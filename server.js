import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import Stripe from 'stripe';
import { v4 as uuidv4 } from 'uuid';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import archiver from 'archiver';
import nodemailer from 'nodemailer';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import { OpenAI } from 'openai';
import basicAuth from 'express-basic-auth';
import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import Database from 'better-sqlite3';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { z } from 'zod';

const app = express();
const __dirname = path.resolve();
const PORT = process.env.PORT || 5173;
const ORIGIN = process.env.ORIGIN || `http://localhost:${PORT}`;
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 16);
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 120);

ffmpeg.setFfmpegPath(ffmpegPath);

// --- Logging
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
app.use(pinoHttp({ logger }));

// IMPORTANT: Stripe webhook requires the raw body. Register this route BEFORE json/urlencoded parsers.
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    logger.error({ err }, 'stripe_webhook_invalid');
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const updateBySession = (session_id, status) => {
    const row = db.prepare('SELECT id FROM jobs WHERE stripe_session = ? ORDER BY created_at DESC LIMIT 1').get(session_id);
    if (row) updateJob.run({ id: row.id, status, s3_key: null, updated_at: Date.now() });
  };

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object; // contains .mode and .id
      updateBySession(session.id, 'paid');
      break;
    }
    case 'invoice.payment_succeeded':
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      break;
  }
  res.json({ received: true });
});

// --- Security & JSON (after webhook)
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: ORIGIN, credentials: true }));
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true }));

// --- Static
app.use(express.static(path.join(__dirname, 'public')));

// --- Rate limit
const limiter = rateLimit({ windowMs: 60 * 1000, max: RATE_LIMIT_PER_MIN });
app.use('/api/', limiter);

// --- Data paths (env-overridable for Render disk persistence)
const DATA_ROOT = process.env.DATA_ROOT || __dirname;
const OUT_DIR = process.env.OUT_DIR || path.join(DATA_ROOT, 'out');
const UP_DIR  = process.env.UP_DIR  || path.join(DATA_ROOT, 'uploads');
const DB_PATH = process.env.DB_PATH || path.join(DATA_ROOT, 'data.db');
for (const d of [OUT_DIR, UP_DIR]) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });

// --- Multer upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UP_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/\s+/g,'_')}`)
});
const upload = multer({ storage, limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 20 } });

// --- OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Email
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
});

// --- S3
const s3 = new S3Client({ region: process.env.AWS_REGION });
const BUCKET = process.env.S3_BUCKET;
const PREFIX = process.env.S3_PREFIX || '';

// --- SQLite jobs DB
const db = new Database(DB_PATH);
db.exec(`CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  email TEXT,
  address TEXT,
  status TEXT,
  stripe_session TEXT,
  kind TEXT, -- one_time | subscription | demo
  s3_key TEXT,
  created_at INTEGER,
  updated_at INTEGER
);`);
const insertJob = db.prepare('INSERT INTO jobs (id,email,address,status,stripe_session,kind,s3_key,created_at,updated_at) VALUES (@id,@email,@address,@status,@stripe_session,@kind,@s3_key,@created_at,@updated_at)');
const updateJob = db.prepare('UPDATE jobs SET status=@status, s3_key=@s3_key, updated_at=@updated_at WHERE id=@id');
const listJobs = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 500');

// Health
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Create Checkout Session (one-time or subscription)
import { z } from 'zod';
const createSessionSchema = z.object({ email: z.string().email(), mode: z.enum(['payment','subscription']).default('payment') });
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { email, mode } = createSessionSchema.parse(req.body || {});
    const line_items = mode === 'payment' ? [{ price: process.env.STRIPE_PRICE_ONE_TIME, quantity: 1 }] : [{ price: process.env.STRIPE_PRICE_SUB_MONTHLY, quantity: 1 }];
    const session = await stripe.checkout.sessions.create({
      mode,
      customer_email: email,
      line_items,
      success_url: `${ORIGIN}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${ORIGIN}/index.html#cancelled`,
      allow_promotion_codes: true
    });
    res.json({ url: session.url });
  } catch (err) {
    req.log.error({ err }, 'stripe_session_error');
    res.status(400).json({ error: 'bad_request', message: err.message });
  }
});

// Upload + Generate (requires: paid session or active subscription or demo)
const genQuerySchema = z.object({ session_id: z.string().optional(), kind: z.enum(['one_time','subscription','demo']).default('demo') });
app.post('/api/generate', upload.array('photos', 20), async (req, res) => {
  const files = (req.files || []).map(f => f.path);
  try {
    const { email, address, details } = req.body;
    const { session_id, kind } = genQuerySchema.parse({ session_id: req.query.session_id, kind: req.query.kind || 'demo' });

    if (!email || !address) return res.status(400).json({ error: 'missing_fields' });

    // entitlement check
    if (kind !== 'demo') {
      if (!session_id) return res.status(401).json({ error: 'missing_session' });
      const session = await stripe.checkout.sessions.retrieve(session_id);
      if (!session || (session.payment_status !== 'paid' && session.status !== 'complete')) {
        return res.status(402).json({ error: 'payment_required' });
      }
    }

    const jobId = uuidv4();
    const workDir = path.join(OUT_DIR, jobId);
    fs.mkdirSync(workDir, { recursive: true });

    insertJob.run({ id: jobId, email, address, status: 'processing', stripe_session: session_id || null, kind, s3_key: null, created_at: Date.now(), updated_at: Date.now() });

    // 1) Listing + captions (OpenAI)
    const prompt = `Create an MLS-ready listing and 5 social captions for a property.
Address: ${address}
Details: ${details || 'N/A'}
Style: persuasive but factual. Return JSON with keys: mls, seo, captions (array of 5).`;
    const resp = await openai.chat.completions.create({
      model: 'gpt-5',
      messages: [
        { role: 'system', content: 'You generate real estate listing copy. Output strictly JSON.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.6
    });
    let textJSON;
    try { textJSON = JSON.parse(resp.choices[0].message.content); }
    catch { textJSON = { mls: resp.choices[0].message.content, seo: '', captions: [] }; }
    fs.writeFileSync(path.join(workDir, 'listing.json'), JSON.stringify(textJSON, null, 2));

    // 2) Enhance images
    const enhancedDir = path.join(workDir, 'enhanced');
    fs.mkdirSync(enhancedDir, { recursive: true });
    const enhancedPaths = [];
    for (let i = 0; i < files.length; i++) {
      const src = files[i];
      const out = path.join(enhancedDir, `img_${i+1}.jpg`);
      await sharp(src).rotate().resize(1920).modulate({ brightness: 1.05, saturation: 1.05 })
        .toFormat('jpeg', { quality: 86 }).toFile(out);
      enhancedPaths.push(out);
    }

    // 3) PDF brochure
    const pdfPath = path.join(workDir, 'brochure.pdf');
    await makeBrochure(pdfPath, address, textJSON, enhancedPaths);

    // 4) Video slideshow
    const videoPath = path.join(workDir, 'tour.mp4');
    await makeKenBurnsVideo(enhancedPaths, videoPath);

    // 5) ZIP
    const zipPath = path.join(workDir, `${jobId}.zip`);
    await zipFolder(workDir, zipPath);

    // 6) Upload to S3
    const key = `${PREFIX}${jobId}.zip`;
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: fs.createReadStream(zipPath), ContentType: 'application/zip' }));

    // 7) Email link (optional)
    const downloadUrl = `${ORIGIN}/download/s3/${encodeURIComponent(key)}`;
    if (email && transporter.options.auth) {
      await transporter.sendMail({ from: process.env.FROM_EMAIL, to: email, subject: 'Your Real Estate Kit is Ready', html: `<p>Your kit is ready.</p><p><a href="${downloadUrl}">Download here</a> (expires in ${Math.floor((Number(process.env.S3_URL_EXPIRY_SECONDS||604800))/86400)} days)</p>` });
    }

    updateJob.run({ id: jobId, status: 'ready', s3_key: key, updated_at: Date.now() });

    res.json({ jobId, status: 'ready', download: downloadUrl });
  } catch (err) {
    req.log.error({ err }, 'generate_error');
    res.status(500).json({ error: 'generation_failed', message: err.message });
  } finally {
    // cleanup uploads
    for (const f of files) { try { fs.unlinkSync(f); } catch {} }
  }
});

// Serve S3 object via **presigned URL** (safer; time-limited)
app.get('/download/s3/*', async (req, res) => {
  try {
    const key = req.params[0];
    const expires = Number(process.env.S3_URL_EXPIRY_SECONDS || 600); // default 10m
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key })); // sanity check
    const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    const url = await getSignedUrl(s3, command, { expiresIn: Math.min(expires, 604800) });
    return res.redirect(302, url);
  } catch (err) {
    logger.error({ err }, 'download_error');
    return res.status(404).send('Not found');
  }
});

// Public index
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

// Admin dashboard
app.use('/admin', basicAuth({ users: { [process.env.ADMIN_USER]: process.env.ADMIN_PASS }, challenge: true }));
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public/admin.html')));
app.get('/api/admin/jobs', (_req, res) => { res.json({ jobs: listJobs.all() }); });

app.listen(PORT, () => logger.info(`AI RE Kit running on ${ORIGIN}`));

// Helpers
async function makeBrochure(pdfPath, address, data, images) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 36 });
    const stream = fs.createWriteStream(pdfPath);
    doc.pipe(stream);

    // Header
    doc.fontSize(20).font('Helvetica-Bold').text(address || 'Property', { align: 'left' }).moveDown(0.5);
    doc.fontSize(11).fillColor('#444').text(data.seo || '', { align: 'left' }).moveDown(1);

    // Image grid (up to 6)
    const max = Math.min(images.length, 6);
    const cols = 3, gap = 8;
    const w = (doc.page.width - doc.page.margins.left - doc.page.margins.right - (cols-1)*gap) / cols;
    let x = doc.page.margins.left, y = doc.y;
    for (let i=0;i<max;i++) {
      doc.image(images[i], x, y, { width: w, align: 'left' });
      x += w + gap; if ((i+1)%cols===0) { x = doc.page.margins.left; y += w*0.66 + gap; }
    }

    // MLS Section
    doc.moveDown(1.2).font('Helvetica-Bold').fontSize(14).fillColor('#000').text('MLS Listing Copy');
    doc.moveDown(0.2).font('Helvetica').fontSize(11).fillColor('#111').text(data.mls || '', { align: 'left' });

    // Captions
    if (Array.isArray(data.captions)) {
      doc.moveDown(1).font('Helvetica-Bold').fontSize(14).text('Social Captions');
      doc.font('Helvetica').fontSize(11).list(data.captions);
    }

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

async function makeKenBurnsVideo(images, outPath) {
  const listPath = outPath + '.txt';
  const entries = images.map(p => `file '${p.replace(/'/g, "'\''")}'
duration 3`).join('\n');
  fs.writeFileSync(listPath, entries + '\n');
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(listPath)
      .inputOptions(['-f concat', '-safe 0'])
      .videoCodec('libx264')
      .size('?x1080')
      .outputOptions(['-pix_fmt yuv420p', '-r 24'])
      .on('end', () => { fs.unlink(listPath, ()=>resolve()); })
      .on('error', reject)
      .save(outPath);
  });
}

async function zipFolder(srcDir, outZip) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outZip);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(output);
    archive.directory(srcDir, false);
    archive.finalize();
    output.on('close', resolve);
    archive.on('error', reject);
  });
}