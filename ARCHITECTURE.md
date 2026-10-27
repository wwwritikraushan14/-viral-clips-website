# VIRAL CLIPS — System Architecture

Plain-language map of how the site works, what protects it, and what its
limits are. Written for the site owner, not just for developers.

## 1. What it is

A paid video-subscription website. Visitors pick a plan, pay with UPI,
submit their payment proof, and after the admin approves, they get a
private one-time, one-device access link. Videos stream behind that link
and stop working automatically when the plan ends.

## 2. Stack (all free or already paid for)

| Piece | Choice | Why |
|---|---|---|
| Hosting | Railway (Trial workspace) | Runs the server, restarts on push |
| Storage | Cloudflare R2 (free tier, 10 GB) for NEW videos; Railway disk for old videos | R2 keeps the disk from filling again |
| Database | SQLite (`node:sqlite`, built-in) | No separate database server to pay for or maintain |
| Server | Node.js + Express 4 | Small, single process |
| Frontend | Plain HTML/CSS/JS, no framework | Fast, no build step, editable in GitHub's web editor |
| Email | Resend (test mode) with WhatsApp fallback | Test mode only delivers to the owner's address, so the real delivery path is: admin copies the magic link and sends it on WhatsApp |
| Payments | UPI QR + manual approval (no gateway) | ₹0 fees; the admin verifies the UTR in their own UPI app |

## 3. Components

```
Browser ──> Express server (server.js) ──> SQLite (viral-clips.db)
   │                │                            ├── payments
   │                ├── public/ (static pages)   ├── subscriptions
   │                ├── /api/* (JSON)           ├── videos
   │                ├── /access/:token (watch)  ├── teasers
   │                └── /api/teaser-img/:id     └── errors (Phase 2)
   │
   └─> Cloudflare R2 (new video uploads + member streaming via
       6-hour presigned URLs) — only when R2_* variables are set
```

Key files:

- `server.js` — all routes, auth, rate limits, logging, error handling
- `db.js` — tables + migrations (phone column, video `storage` column)
- `public/` — `index.html`, `plans.html`, `pay.html`, `admin.html`,
  `404.html` (Phase 1), styles, thumbnails
- `tests/phase2.test.js` — automated suite (Phase 2, `npm test`)

## 4. Customer journey (the money path)

1. Visitor picks a plan on `plans.html` (`/api/plans` lists prices).
2. `pay.html` shows a UPI QR (`/api/qr/:planId`) — QR images are
   generated on the server, never stored.
3. Customer pays in their own UPI app, submits name + WhatsApp number +
   UTR (`POST /api/payments`, rate-limited 10/min).
4. Admin checks the UTR in their UPI app and approves
   (`POST /api/admin/approve`, admin-only).
5. Approval creates a subscription row with a random token and returns
   the magic link. The admin sends it to the customer on WhatsApp.
6. Customer opens the link once: the server sets a device cookie and
   records the device fingerprint (`used_at`, `device_fp`). A second
   device opening the same link is refused.
7. Every watch request checks: subscription exists, not expired
   (`expires_at`), device matches. Expired plans stop working on their own.

## 5. Admin journey

`admin.html` → login (password → signed `vc_admin` cookie) → tabs:
Dashboard, Payments, Subscribers, Videos, Homepage Teasers, Errors
(Phase 2). Approve / reject / extend / revoke / upload / delete all go
through `requireAdmin` (signed cookie, no database write on login —
this is the fix for the Oct 21 "wrong password" incident, which was
really a full disk blocking session writes).

## 6. Security model

- **Admin auth:** HMAC-signed cookie (`vc_admin`), `httpOnly`,
  `sameSite=lax`, `secure` on HTTPS. Changing `ADMIN_PASSWORD` logs
  everyone out (it is the signing key).
- **CSRF (Phase 2):** login also sets a readable `vc_csrf` cookie; the
  admin panel sends it back as `x-csrf-token` on every state-changing
  admin call (approve, reject, extend, revoke, uploads, deletes).
  Missing/wrong token → 403. Logout is deliberately left unprotected so
  an old session can always log out and get a fresh token.
- **Subscriber auth:** random 32-byte token in the URL + device cookie +
  device fingerprint. No passwords for customers.
- **Headers:** `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, strict `Referrer-Policy`,
  `Permissions-Policy`, and a Content-Security-Policy.
- **Input safety:** prepared statements everywhere (no SQL injection
  surface); uploads are type-checked (video/image only) and size-capped
  (1 GB video, 15 MB teaser); rename endpoint caps at 120 chars and
  strips control characters.
- **Secrets:** never in code. All keys live in Railway environment
  variables (`ADMIN_PASSWORD`, `R2_*`, `RESEND_API_KEY`, `UPI_ID`,
  `BASE_URL`).

## 7. Rate limits (in-memory, per IP + path)

| Route | Limit |
|---|---|
| Admin login | 8 / min |
| Payment submit | 10 / min |
| QR code | 30 / min |
| Teaser list / teaser image | 120 / min each |
| Admin video upload | 30 / hour |
| Admin teaser upload | 30 / hour |

Subscriber-guarded watch routes are deliberately NOT limited, so a
paying member can never be locked out by a limit. Limits reset when the
server restarts (in-memory store) — acceptable at this scale, noted as
a Phase 3 item if the site ever runs on multiple instances.

## 8. Caching

- gzip compression on all responses.
- Static HTML cached 1 hour, teaser images 24 hours (CDN-style headers
  ready, but no CDN sits in front of the site yet — Phase 3).
- No server-side page cache: payment and subscription pages must always
  be fresh.

## 9. Logging, error tracking, monitoring (Phases 1–2)

- **Request logs (Phase 1):** every request logs
  `[req] METHOD path STATUS ms`. Paths only — never query strings,
  tokens, cookies, or bodies.
- **Error tracking (Phase 2):** server errors are stored in an `errors`
  table (method, path, message capped at 200 chars, timestamp), capped
  at the newest 100 rows so a flood can never fill the disk. Visible in
  the admin panel's Errors tab (`GET /api/admin/errors`, admin-only).
- **Health (Phase 1):** `GET /health` returns
  `{ok, storage: 'r2'|'local', uptime}` with no sensitive data.
- **Monitoring (Phase 2):** an external check hits `/health` every
  30 minutes and alerts only when the site stops answering.
- **CI (Phase 2):** GitHub Actions runs `npm test` on every push and
  pull request. It reports pass/fail on GitHub; it does NOT block
  Railway deploys (Railway deploys on push regardless).

## 10. Deployment

```
GitHub push (main) ──> Railway auto-deploy ──> live site
                  └──> GitHub Actions runs npm test (report only)
```

Uploads are done from the phone via GitHub's web upload. Rule learned
the hard way: never trust the phone's view of the live site — verify
each deploy at the repo AND the live host, and use a private tab for
visual checks (the phone browser's cache has faked bugs before).

## 11. Environment variables (Railway)

`ADMIN_PASSWORD`, `UPI_ID`, `PAYEE_NAME`, `BASE_URL`, `DB_PATH`,
`UPLOAD_DIR`, `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `RESEND_API_KEY`.
Without the `R2_*` variables the site behaves exactly as before
(local disk only).

## 12. Limits and scaling (honest ceiling)

- **Single instance + SQLite:** fine for a small subscriber base.
  SQLite handles many readers but one writer at a time; the site has
  few writes (payments, approvals, uploads), so this is not a problem
  today.
- **Disk:** the Railway volume holds the database, teaser images, and
  OLD videos. New videos go to R2, so disk growth is now slow. If the
  disk ever fills again, logins fail first (same symptom as Oct 21) —
  check disk before changing passwords.
- **When to scale (Phase 3 triggers):** traffic that needs a CDN in
  front, spend that needs budget alerts, or concurrent writers that
  need a real database. None of these are needed yet.
- **Single points of failure:** one Railway instance, one SQLite file,
  manual backups. Automated DB backups are a Phase 3 item.

## 13. Phase status

- **Phase 1 (done, live):** full rate-limit coverage, request logging,
  error middleware, branded 404 page, `/health` endpoint.
- **Phase 2 (this delivery):** automated test suite, CI checks,
  CSRF tokens, error tracking table + admin Errors tab, this document,
  30-minute health monitoring.
- **Phase 3 (planned, not started):** Cloudflare CDN in front of the
  site, automated DB backups, budget/spend alerts, scaling path
  (multi-instance + database upgrade) when traffic demands it.
