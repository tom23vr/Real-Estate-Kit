# Custom Domain + SSL (Render)

1. In Render, open your Web Service → **Settings → Custom Domains → Add Custom Domain**.
2. Enter your domain (e.g., `app.yourdomain.com`). Render will show a CNAME target like `ai-re-kit.onrender.com`.
3. In your DNS provider (GoDaddy, Namecheap, Cloudflare):
   - Create a **CNAME** record:
     - **Name**: `app` (or the subdomain you chose)
     - **Target**: the Render CNAME value
   - TTL: auto/1hr is fine.
4. Wait for DNS to propagate (usually < 15 minutes).
5. Back in Render, click **Verify**. Render will automatically issue and renew an SSL certificate (no extra cost).

## Update Stripe + Email Links
- Update `ORIGIN` env var in Render to your domain, e.g. `https://app.yourdomain.com`.
- In Stripe Dashboard → Webhooks, change the endpoint to `https://app.yourdomain.com/api/stripe-webhook`.
- If you use SMTP, set `FROM_EMAIL` to your brand email (e.g., `Studio <no-reply@yourdomain.com>`). Make sure your email domain has SPF/DKIM set up at your mail provider.