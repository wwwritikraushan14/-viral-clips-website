# VIRAL CLIPS — Paid Video Subscription Site

A complete membership site: visitors pick a plan, pay via your UPI QR code,
submit payment proof, you approve in the admin panel, and the site emails them
a **one-time, one-device magic link**. Access expires automatically when the plan ends.

## How it works

1. Customer picks a plan on `/plans.html` → sees your UPI QR (amount pre-filled) → pays in any UPI app
2. Customer submits name + email + UTR/transaction ID on the pay page
3. You open `/admin.html`, verify the UTR in your UPI app/bank statement, tap **Approve**
4. Site emails the customer a magic link (or shows it in the admin panel to send manually)
5. First time the link is opened, it locks to that device — other devices get blocked
6. Every video request checks expiry — when the plan ends, they're kicked out automatically

## Plans & pricing (built in)

| Plan | Price |
|---|---|
| 1 Month | ₹299 |
| 3 Months | ₹799 |
| 6 Months | ₹1599 |
| 1 Year | ₹2999 |
| Lifetime | ₹9999 |

UPI ID: `ritik170501@ptyes` (change via `UPI_ID` env var)

## Run it

```bash
cd viral-clips
npm install
cp .env.example .env   # then edit: set ADMIN_PASSWORD at minimum
node server.js
```

Open http://localhost:3000 — admin panel at http://localhost:3000/admin.html

## Important settings (`.env`)

- `ADMIN_PASSWORD` — **change this before going live** (default `change-me-now`)
- `BASE_URL` — your public domain, e.g. `https://viralclips.in` (magic links use this)
- `UPI_ID` / `PAYEE_NAME` — your UPI details for the QR codes

## Email setup (for automatic magic-link delivery)

Without this, approved links appear in the admin panel and you send them manually
(WhatsApp works fine too).

For Gmail:
1. Turn on 2-Step Verification on your Google account
2. Create an **App Password** (Google Account → Security → App passwords)
3. In `.env`:
```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=you@gmail.com
SMTP_PASS=<the 16-char app password>
SMTP_FROM=you@gmail.com
```

## Going live (checklist)

1. Get a VPS (Hostinger / DigitalOcean / any, ~₹400–800/mo) or any Node host
2. Point your domain to it, set `BASE_URL=https://yourdomain.com`
3. Set a strong `ADMIN_PASSWORD`, configure SMTP
4. Run behind HTTPS (Caddy or Nginx + Let's Encrypt) — required, since access cookies must be secure
5. Keep it running: `pm2 start server.js --name viral-clips` (or systemd)
6. Back up `viral-clips.db` + `uploads/` regularly — that's your whole business data

## Notes & limits

- **One device** = same browser + IP fingerprint. If a customer switches phones or their mobile IP changes a lot, they may get locked — you can see unopened/expired subs in the admin panel and re-issue a link by rejecting + re-approving, or just generate a fresh payment approval.
- Videos stream with range support (seeking works); downloads are discouraged via `controlsList="nodownload"` but a determined user can still save streams — true DRM needs a service like Vimeo OTT / Gumroad.
- UPI payments are verified manually (no auto-confirm without a gateway like Razorpay). If volume grows, Razorpay can be added later for instant auto-activation.
