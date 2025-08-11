# AI Real Estate Marketing Kit — PRO

**What it does**: Upload photos + address → pay (one-time or subscription) → get MLS copy, brochure PDF, and a short video. Automatic delivery via S3 + email. Admin dashboard included.

## Quick Start
```bash
cp .env.example .env
# fill your keys
npm i
npm run dev
# open http://localhost:5173
```

## Docker
```bash
docker build -t ai-re-kit .
docker run --env-file .env -p 5173:5173 ai-re-kit
```

## Stripe
- One-time price: `STRIPE_PRICE_ONE_TIME`
- Subscription price (monthly): `STRIPE_PRICE_SUB_MONTHLY`
- Webhook: add endpoint `POST /api/stripe-webhook` and set `STRIPE_WEBHOOK_SECRET`

## S3 Delivery
- Set bucket + IAM with PutObject + HeadObject permissions.
- For production, serve downloads via S3/CloudFront; this build redirects to the S3 object.

## Admin
- Basic auth via `ADMIN_USER/ADMIN_PASS`
- Visit `/admin` to see job list and download links

## Tests
```bash
npm test
```