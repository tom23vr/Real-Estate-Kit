# Deploy to Render

## One-time setup
1. Push this repo to GitHub (private or public).
2. Create accounts/keys for Stripe, OpenAI, AWS (S3), SMTP.

## Render
1. Create a **Web Service** from your GitHub repo.
2. When asked for settings:
   - Runtime: **Node**
   - Build Command: `npm install`
   - Start Command: `node server.js`
   - Health Check Path: `/api/health`
3. Add a **Disk**: 5 GB, mount at `/var/data` (Render UI).
4. Set Environment Variables (Render UI → Environment):
   - `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ONE_TIME`, `STRIPE_PRICE_SUB_MONTHLY`, `STRIPE_WEBHOOK_SECRET`
   - `OPENAI_API_KEY`
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `FROM_EMAIL` (optional)
   - `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_PREFIX`
   - `ADMIN_USER`, `ADMIN_PASS`
   - `DATA_ROOT=/var/data`, `OUT_DIR=/var/data/out`, `UP_DIR=/var/data/uploads`, `DB_PATH=/var/data/data.db`
5. Deploy. After it's live, note your public URL (e.g., `https://ai-re-kit.onrender.com`).

## Stripe Webhook
1. In Stripe Dashboard → Developers → Webhooks, click **Add endpoint**.
2. Endpoint URL: `https://YOUR-RENDER-URL/api/stripe-webhook`
3. Select event **`checkout.session.completed`** (you can add more later).
4. Copy the **Signing secret** and set it as `STRIPE_WEBHOOK_SECRET` in Render.

## Test
- Visit your Render URL in a browser.
- Click **Run Demo** to test end-to-end without payment.
- Create a Checkout Session to test Stripe (you can use test mode cards).

## Notes
- Files are uploaded to **S3**; the admin job list persists on Render's disk (SQLite). 
- If you scale to multiple instances, move the DB to a managed database (e.g., Postgres) and store files only on S3.