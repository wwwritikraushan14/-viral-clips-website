// VIRAL CLIPS — paid video subscription server.
// Flow: plans -> UPI QR -> payment proof form -> admin approves ->
// one-time, one-device magic link emailed -> auto-expiry on every request.
require('dotenv').config();
const express = require('express');
const compression = require('compression');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const QRCode = require('qrcode');
const multer = require('multer');
const nodemailer = require('nodemailer');
const db = require('./db');

// ---------------- config ----------------
const PORT = process.env.PORT || 3000;
const UPI_ID = process.env.UPI_ID || 'ritik170501@ptyes';
const PAYEE_NAME = process.env.PAYEE_NAME || 'VIRAL CLIPS';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-now';
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const IS_HTTPS = BASE_URL.startsWith('https://'); // secure cookies only over HTTPS
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------------- video storage: Cloudflare R2 (optional) ----------------
// When R2_* variables are set, NEW video uploads go to the R2 bucket and
// members stream straight from Cloudflare — the Railway disk then only
// holds the database and small teaser images. Without them, videos stay
// on local disk exactly as before. Old 'local' videos always keep working.
const R2_ENDPOINT = process.env.R2_ENDPOINT || '';
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const R2_BUCKET = process.env.R2_BUCKET || '';
const R2_ON = Boolean(R2_ENDPOINT && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET);
let s3 = null;
let s3Commands = null;
let getSignedUrl = null;
if (R2_ON) {
  const s3lib = require('@aws-sdk/client-s3');
  s3 = new s3lib.S3Client({
    region: 'auto',
    endpoint: R2_ENDPOINT,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });
  s3Commands = s3lib;
  getSignedUrl = require('@aws-sdk/s3-request-presigner').getSignedUrl;
}

const PLANS = [
  { id: '1m',   name: '1 Month',  months: 1,  price: 299  },
  { id: '3m',   name: '3 Months', months: 3,  price: 799  },
  { id: '6m',   name: '6 Months', months: 6,  price: 1599 },
  { id: '1y',   name: '1 Year',   months: 12, price: 2999 },
  { id: 'life', name: 'Lifetime', months: null, price: 9999 },
];
const planById = (id) => PLANS.find((p) => p.id === id);

// ---------------- email via Gmail API, Resend or Brevo (HTTPS) ----------------
// (Gmail SMTP is blocked on Railway's network, so we send over HTTPS instead.)
// Set GMAIL_CLIENT_ID + GMAIL_CLIENT_SECRET + GMAIL_REFRESH_TOKEN + GMAIL_FROM
// for free Gmail API sending (500/day), or RESEND_API_KEY, or BREVO_API_KEY.
async function sendViaGmailApi(to, subject, text) {
  const id = process.env.GMAIL_CLIENT_ID, sec = process.env.GMAIL_CLIENT_SECRET,
        rt = process.env.GMAIL_REFRESH_TOKEN, from = process.env.GMAIL_FROM;
  if (!id || !sec || !rt || !from) return null; // not configured — skip
  const tokRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: sec, refresh_token: rt, grant_type: 'refresh_token' }),
  });
  if (!tokRes.ok) return { sent: false, reason: 'Gmail token refresh failed' };
  const { access_token } = await tokRes.json();
  const raw = Buffer.from(
    `From: VIRAL CLIPS <${from}>\r\nTo: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}`,
    'utf8'
  ).toString('base64url');
  const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  if (!sendRes.ok) {
    const body = await sendRes.text().catch(() => '');
    return { sent: false, reason: 'Gmail send failed: ' + body.slice(0, 160) };
  }
  return { sent: true };
}

async function sendAccessEmail(to, name, plan, link, expiresAt) {
  if (!process.env.GMAIL_REFRESH_TOKEN && !process.env.RESEND_API_KEY && !process.env.BREVO_API_KEY) {
    return { sent: false, reason: 'Email not configured — copy the link and send it manually.' };
  }
  const expiryLine = expiresAt
    ? `Your access is valid until ${new Date(expiresAt).toLocaleString('en-IN')}.`
    : 'Your access never expires (Lifetime plan).';
  const subject = `Your VIRAL CLIPS access link (${plan.name})`;
  const text =
`Hi ${name},

Thanks for subscribing to VIRAL CLIPS!

Your private access link (works on ONE device only — open it on the device you want to watch on):

${link}

${expiryLine}
Do not share this link. If opened on a different device, access will be blocked.

Enjoy!
— Team VIRAL CLIPS`;

  // ---- Gmail API (free, 500/day, best deliverability) ----
  const gmailRes = await sendViaGmailApi(to, subject, text);
  if (gmailRes) return gmailRes;

  // ---- Resend (preferred third-party) ----
  if (process.env.RESEND_API_KEY) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || 'VIRAL CLIPS <onboarding@resend.dev>',
        to: [to],
        subject,
        text,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { sent: false, reason: 'Email failed: ' + body.slice(0, 160) };
    }
    return { sent: true };
  }

  // ---- Brevo fallback ----
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': process.env.BREVO_API_KEY },
    body: JSON.stringify({
      sender: { email: process.env.SMTP_FROM || process.env.SMTP_USER, name: 'VIRAL CLIPS' },
      to: [{ email: to, name }],
      subject,
      textContent: text,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { sent: false, reason: 'Email failed: ' + body.slice(0, 160) };
  }
  return { sent: true };
}

// ---------------- helpers ----------------
function deviceFingerprint(req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
  const ua = req.headers['user-agent'] || '';
  return crypto.createHash('sha256').update(ip + '|' + ua).digest('hex');
}

function getSubscription(token) {
  return db.prepare('SELECT * FROM subscriptions WHERE token = ?').get(token);
}

function isExpired(sub) {
  return sub.expires_at !== null && Date.now() > sub.expires_at;
}

// Subscriber guard: valid token cookie + same device + not expired.
function requireSubscriber(req, res, next) {
  const token = req.cookies.vc_t;
  if (!token) return res.status(401).json({ error: 'no_access', message: 'Open your private access link first.' });
  const sub = getSubscription(token);
  if (!sub) return res.status(401).json({ error: 'no_access', message: 'Invalid access link.' });
  if (isExpired(sub)) return res.status(403).json({ error: 'expired', message: 'Your subscription has ended. Please renew to continue watching.' });
  if (sub.device_fp && sub.device_fp !== deviceFingerprint(req)) {
    return res.status(403).json({ error: 'device', message: 'This link is locked to another device.' });
  }
  req.sub = sub;
  next();
}

function requireAdmin(req, res, next) {
  const sid = req.cookies.vc_admin;
  if (!sid) return res.status(401).json({ error: 'admin_login_required' });
  if (validAdminToken(sid)) return next(); // signed cookie — no DB lookup needed
  const row = db.prepare('SELECT * FROM admin_sessions WHERE id = ?').get(sid); // legacy DB sessions
  if (!row) return res.status(401).json({ error: 'admin_login_required' });
  next();
}

// Admin login sessions are signed cookies, NOT database rows — so logging in
// never needs a disk write. (A completely full disk otherwise makes even a
// correct password "fail", because the session row can't be saved.)
// The ADMIN_PASSWORD is the signing key: changing it logs everyone out.
const ADMIN_SESSION_MS = 12 * 3600 * 1000;
function adminToken() {
  const exp = String(Date.now() + ADMIN_SESSION_MS);
  const sig = crypto.createHmac('sha256', ADMIN_PASSWORD).update('vc-admin:' + exp).digest('hex');
  return exp + '.' + sig;
}
function validAdminToken(tok) {
  const parts = String(tok || '').split('.');
  if (parts.length !== 2) return false;
  const [exp, sig] = parts;
  if (!/^\d+$/.test(exp) || Date.now() > Number(exp)) return false;
  const want = crypto.createHmac('sha256', ADMIN_PASSWORD).update('vc-admin:' + exp).digest('hex');
  const a = Buffer.from(sig), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function page(title, heading, message, cta) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — VIRAL CLIPS</title><link rel="stylesheet" href="/styles.css"></head>
<body><div class="wrap center"><div class="card">
<h1>${heading}</h1><p class="muted">${message}</p>
${cta || '<a class="btn" href="/">Back to home</a>'}
</div></div></body></html>`;
}

// ---------------- app ----------------
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(compression()); // gzip responses
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));

// ---- security headers ----
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // CSP: allow self + inline (pages use inline scripts/styles); videos from self (+ R2 when configured); QR is data: URL
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; media-src 'self'" + (R2_ON ? ' https://*.r2.cloudflarestorage.com' : '') + "; connect-src 'self'; frame-ancestors 'none'");
  next();
});

// ---- request logging (Phase 1) ----
// Logs method + path + status + time only. req.path never includes the
// query string (which can carry tokens), and we never log cookies/bodies.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`[req] ${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

// ---- simple in-memory rate limiter ----
const buckets = new Map();
function rateLimit({ windowMs, max }) {
  return (req, res, next) => {
    const key = (req.ip || '') + req.path;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now > b.reset) b = { count: 0, reset: now + windowMs };
    b.count++;
    buckets.set(key, b);
    if (b.count > max) return res.status(429).json({ error: 'too_many_requests', message: 'Too many attempts. Please wait a minute and try again.' });
    next();
  };
}

// static files with browser caching
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '7d',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'public, max-age=3600'); // 1h for pages
  },
}));

// ---- public API ----
app.get('/api/plans', (req, res) => res.json(PLANS));

// ---- health check (Phase 1): for uptime monitoring, no sensitive data ----
app.get('/health', (req, res) => res.json({ ok: true, storage: R2_ON ? 'r2' : 'local', uptime: Math.floor(process.uptime()) }));

app.get('/api/qr/:planId', rateLimit({ windowMs: 60000, max: 30 }), async (req, res) => {
  const plan = planById(req.params.planId);
  if (!plan) return res.status(404).json({ error: 'unknown_plan' });
  const upiUrl = `upi://pay?pa=${encodeURIComponent(UPI_ID)}&pn=${encodeURIComponent(PAYEE_NAME)}&am=${plan.price}&cu=INR&tn=${encodeURIComponent('VIRALCLIPS-' + plan.id)}`;
  const qr = await QRCode.toDataURL(upiUrl, { width: 320, margin: 1 });
  res.json({ qr, upiId: UPI_ID, payee: PAYEE_NAME, amount: plan.price, upiUrl });
});

// Customer submits payment proof after paying via UPI app.
app.post('/api/payments', rateLimit({ windowMs: 60000, max: 10 }), (req, res) => {
  const { name, email, phone, planId, utr } = req.body || {};
  const plan = planById(planId);
  if (!name || !phone || !plan || !utr) {
    return res.status(400).json({ error: 'missing_fields', message: 'Name, phone, plan and UTR / transaction ID are required.' });
  }
  if (String(name).length > 80 || String(utr).length > 40 || String(email || '').length > 120 || String(phone).length > 20) {
    return res.status(400).json({ error: 'too_long', message: 'One of the fields is too long.' });
  }
  const emailClean = String(email || '').trim().toLowerCase();
  if (emailClean && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailClean)) {
    return res.status(400).json({ error: 'bad_email', message: 'Please enter a valid email address.' });
  }
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 13) {
    return res.status(400).json({ error: 'bad_phone', message: 'Please enter a valid 10-digit mobile number.' });
  }
  const info = db.prepare(
    'INSERT INTO payments (name, email, phone, plan_id, amount, utr, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(name.trim(), emailClean, digits, plan.id, plan.price, utr.trim(), Date.now());
  res.json({ ok: true, paymentId: Number(info.lastInsertRowid),
    message: 'Payment details received. You will get your private access link on email once verified.' });
});

// One-time magic link entry. First open binds the link to this device.
app.get('/access/:token', (req, res) => {
  const sub = getSubscription(req.params.token);
  if (!sub) return res.status(404).send(page('Invalid link', '⛔ Invalid link', 'This access link does not exist.'));
  if (isExpired(sub)) {
    return res.status(403).send(page('Expired', '⌛ Subscription ended',
      'Your subscription period is over. Renew to keep watching.',
      '<a class="btn" href="/plans.html">See plans</a>'));
  }
  const fp = deviceFingerprint(req);
  if (!sub.used_at) {
    db.prepare('UPDATE subscriptions SET used_at = ?, device_fp = ? WHERE id = ?').run(Date.now(), fp, sub.id);
  } else if (sub.device_fp !== fp) {
    return res.status(403).send(page('Device locked', '🔒 Locked to another device',
      'This link was already opened on a different device. One link works on one device only.'));
  }
  res.cookie('vc_t', sub.token, { httpOnly: true, sameSite: 'lax', secure: IS_HTTPS, maxAge: 100 * 365 * 24 * 3600 * 1000 });
  res.redirect('/watch.html');
});

// ---- subscriber API (needs magic-link session) ----
app.get('/api/me', requireSubscriber, (req, res) => {
  const plan = planById(req.sub.plan_id);
  res.json({
    name: req.sub.name, email: req.sub.email,
    plan: plan ? plan.name : req.sub.plan_id,
    expiresAt: req.sub.expires_at,
    daysLeft: req.sub.expires_at ? Math.max(0, Math.ceil((req.sub.expires_at - Date.now()) / 86400000)) : null,
  });
});

app.get('/api/videos', requireSubscriber, (req, res) => {
  const rows = db.prepare('SELECT id, title, size, created_at FROM videos ORDER BY created_at DESC').all();
  res.json(rows);
});

// Token-gated video streaming with range support.
app.get('/api/stream/:id', requireSubscriber, async (req, res) => {
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
  if (!video) return res.status(404).json({ error: 'not_found' });
  // Cloudflare R2 video: hand the member a private signed link (valid 6h)
  // and let Cloudflare serve the video directly — no Railway bandwidth used.
  if (video.storage === 'r2') {
    if (!R2_ON) return res.status(503).json({ error: 'storage_unavailable' });
    try {
      const url = await getSignedUrl(
        s3,
        new s3Commands.GetObjectCommand({ Bucket: R2_BUCKET, Key: video.filename }),
        { expiresIn: 6 * 3600 }
      );
      return res.redirect(302, url);
    } catch (e) {
      return res.status(502).json({ error: 'storage_error', message: 'Could not reach video storage. Try again.' });
    }
  }
  const filePath = path.join(UPLOAD_DIR, path.basename(video.filename));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'file_missing' });
  const stat = fs.statSync(filePath);
  const range = req.headers.range;
  const contentType = video.mime || 'video/mp4';
  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : stat.size - 1;
    if (isNaN(start) || start >= stat.size) return res.status(416).send('Range not satisfiable');
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': contentType,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': contentType, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(filePath).pipe(res);
  }
});

// Public teasers: homepage gallery photos uploaded via the admin panel.
app.get('/api/teasers', rateLimit({ windowMs: 60000, max: 120 }), (req, res) => {
  res.json(db.prepare('SELECT id, title FROM teasers ORDER BY created_at DESC').all());
});

// ---- admin ----
app.post('/api/admin/login', rateLimit({ windowMs: 60000, max: 8 }), (req, res) => {
  const { password } = req.body || {};
  const a = Buffer.from(String(password || ''));
  const b = Buffer.from(ADMIN_PASSWORD);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return res.status(401).json({ error: 'wrong_password' });
  res.cookie('vc_admin', adminToken(), { httpOnly: true, sameSite: 'lax', secure: IS_HTTPS, maxAge: ADMIN_SESSION_MS });
  res.json({ ok: true });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  try { db.prepare('DELETE FROM admin_sessions WHERE id = ?').run(req.cookies.vc_admin); } catch (e) { /* legacy cleanup is best-effort */ }
  res.clearCookie('vc_admin');
  res.json({ ok: true });
});

app.get('/api/admin/payments', requireAdmin, (req, res) => {
  const status = req.query.status || 'pending';
  const rows = db.prepare('SELECT * FROM payments WHERE status = ? ORDER BY created_at DESC').all(status);
  res.json(rows);
});

// Approve -> creates the one-time one-device magic link, emails it.
app.post('/api/admin/approve', requireAdmin, async (req, res) => {
  const { paymentId } = req.body || {};
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!payment || payment.status !== 'pending') {
    return res.status(400).json({ error: 'bad_payment', message: 'Payment not found or already handled.' });
  }
  const plan = planById(payment.plan_id);
  if (!plan) return res.status(400).json({ error: 'bad_plan' });

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = plan.months ? Date.now() + plan.months * 30 * 86400000 : null;
  const link = `${BASE_URL}/access/${token}`;

  db.prepare('UPDATE payments SET status = ? WHERE id = ?').run('approved', payment.id);
  db.prepare(
    'INSERT INTO subscriptions (payment_id, name, email, phone, plan_id, token, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(payment.id, payment.name, payment.email, payment.phone || '', plan.id, token, expiresAt, Date.now());

  let emailResult = { sent: false, reason: 'No email provided — send the link on WhatsApp.' };
  if (payment.email) {
    try {
      emailResult = await sendAccessEmail(payment.email, payment.name, plan, link, expiresAt);
    } catch (e) {
      emailResult = { sent: false, reason: 'Email failed: ' + e.message };
    }
  }
  res.json({ ok: true, link, phone: payment.phone || '', email: emailResult });
});

app.post('/api/admin/reject', requireAdmin, (req, res) => {
  const { paymentId } = req.body || {};
  db.prepare("UPDATE payments SET status = 'rejected' WHERE id = ? AND status = 'pending'").run(paymentId);
  res.json({ ok: true });
});

app.get('/api/admin/subscriptions', requireAdmin, (req, res) => {
  const rows = db.prepare(
    'SELECT id, name, email, phone, plan_id, used_at, expires_at, created_at FROM subscriptions ORDER BY created_at DESC'
  ).all();
  res.json(rows.map((r) => ({
    ...r,
    active: r.expires_at === null || r.expires_at > Date.now(),
    opened: r.used_at !== null,
  })));
});

// Dashboard stats.
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const revenue = db.prepare("SELECT COALESCE(SUM(amount),0) AS r FROM payments WHERE status='approved'").get().r;
  const pending = db.prepare("SELECT COUNT(*) AS c FROM payments WHERE status='pending'").get().c;
  const subs = db.prepare('SELECT expires_at FROM subscriptions').all();
  const active = subs.filter((s) => s.expires_at === null || s.expires_at > Date.now()).length;
  const videos = db.prepare('SELECT COUNT(*) AS c FROM videos').get().c;
  res.json({ revenue, pending, active, totalSubs: subs.length, videos });
});

// Revoke a subscriber's access immediately.
app.delete('/api/admin/subscriptions/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM subscriptions WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Extend a subscription by N months (1-24).
app.post('/api/admin/subscriptions/:id/extend', requireAdmin, (req, res) => {
  const months = Math.max(1, Math.min(24, Number(req.body?.months) || 1));
  const sub = db.prepare('SELECT expires_at FROM subscriptions WHERE id=?').get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'not_found' });
  if (sub.expires_at === null) return res.json({ ok: true, lifetime: true });
  const base = sub.expires_at > Date.now() ? sub.expires_at : Date.now();
  db.prepare('UPDATE subscriptions SET expires_at=? WHERE id=?').run(base + months * 30 * 86400000, req.params.id);
  res.json({ ok: true });
});

// Get a subscriber's magic link again (copy / resend manually).
app.get('/api/admin/subscriptions/:id/link', requireAdmin, (req, res) => {
  const sub = db.prepare('SELECT token FROM subscriptions WHERE id=?').get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'not_found' });
  res.json({ link: `${BASE_URL}/access/${sub.token}` });
});

// Video upload (admin).
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, Date.now() + '-' + crypto.randomBytes(6).toString('hex') + path.extname(file.originalname)),
  }),
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) cb(null, true);
    else cb(new Error('Only video files are allowed'));
  },
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1 GB
});

// R2 mode: hold the file in memory briefly, then send it to Cloudflare —
// nothing is written to the (full) Railway disk.
const uploadR2 = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) cb(null, true);
    else cb(new Error('Only video files are allowed'));
  },
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1 GB
});

app.post('/api/admin/videos', rateLimit({ windowMs: 3600000, max: 30 }), requireAdmin, (req, res) => {
  const handler = R2_ON ? uploadR2.single('video') : upload.single('video');
  handler(req, res, async (err) => {
    if (err) return res.status(400).json({ error: 'upload_failed', message: err.message });
    if (!req.file) return res.status(400).json({ error: 'no_file' });
    const title = (req.body.title || path.parse(req.file.originalname).name).trim();
    if (R2_ON) {
      const key = 'videos/' + Date.now() + '-' + crypto.randomBytes(6).toString('hex') + path.extname(req.file.originalname);
      try {
        await s3.send(new s3Commands.PutObjectCommand({
          Bucket: R2_BUCKET,
          Key: key,
          Body: req.file.buffer,
          ContentType: req.file.mimetype,
        }));
      } catch (e) {
        return res.status(502).json({ error: 'storage_error', message: 'Upload to Cloudflare failed: ' + e.message });
      }
      const info = db.prepare(
        'INSERT INTO videos (title, filename, mime, size, storage, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(title, key, req.file.mimetype, req.file.size, 'r2', Date.now());
      return res.json({ ok: true, id: Number(info.lastInsertRowid), title });
    }
    const info = db.prepare(
      'INSERT INTO videos (title, filename, mime, size, storage, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(title, req.file.filename, req.file.mimetype, req.file.size, 'local', Date.now());
    res.json({ ok: true, id: Number(info.lastInsertRowid), title });
  });
});

app.delete('/api/admin/videos/:id', requireAdmin, async (req, res) => {
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
  if (!video) return res.status(404).json({ error: 'not_found' });
  // Free the actual file FIRST: on a full disk, removing the file is what
  // makes room so the database row delete below can succeed again.
  if (video.storage === 'r2') {
    if (R2_ON) {
      try { await s3.send(new s3Commands.DeleteObjectCommand({ Bucket: R2_BUCKET, Key: video.filename })); }
      catch (e) { /* row is removed below; a leftover object can be deleted in the R2 dashboard */ }
    }
  } else {
    const fp = path.join(UPLOAD_DIR, path.basename(video.filename));
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  db.prepare('DELETE FROM videos WHERE id = ?').run(video.id);
  res.json({ ok: true });
});

app.get('/api/admin/videos', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT id, title, size, created_at FROM videos ORDER BY created_at DESC').all());
});

// ---------- homepage teaser images (admin uploads, shown on homepage gallery) ----------
const teaserUpload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, 'teaser-' + Date.now() + '-' + crypto.randomBytes(6).toString('hex') + path.extname(file.originalname)),
  }),
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  },
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
});

app.post('/api/admin/teasers', rateLimit({ windowMs: 3600000, max: 30 }), requireAdmin, (req, res) => {
  teaserUpload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: 'upload_failed', message: err.message });
    if (!req.file) return res.status(400).json({ error: 'no_file' });
    const title = (req.body.title || path.parse(req.file.originalname).name).trim();
    const info = db.prepare(
      'INSERT INTO teasers (title, filename, mime, size, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(title, req.file.filename, req.file.mimetype, req.file.size, Date.now());
    res.json({ ok: true, id: Number(info.lastInsertRowid), title });
  });
});

app.delete('/api/admin/teasers/:id', requireAdmin, (req, res) => {
  const t = db.prepare('SELECT * FROM teasers WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not_found' });
  db.prepare('DELETE FROM teasers WHERE id = ?').run(t.id);
  const fp = path.join(UPLOAD_DIR, path.basename(t.filename));
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  res.json({ ok: true });
});

app.get('/api/admin/teasers', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT id, title, size, created_at FROM teasers ORDER BY created_at DESC').all());
});

// Public: teaser image file.
app.get('/api/teaser-img/:id', rateLimit({ windowMs: 60000, max: 120 }), (req, res) => {
  const t = db.prepare('SELECT filename, mime FROM teasers WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).end();
  const fp = path.join(UPLOAD_DIR, path.basename(t.filename));
  if (!fs.existsSync(fp)) return res.status(404).end();
  res.setHeader('Content-Type', t.mime || 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  fs.createReadStream(fp).pipe(res);
});

// ---- 404 (Phase 1): branded page for browsers, JSON for API calls ----
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not_found' });
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// ---- error handler (Phase 1): log it, never leak internals to visitors ----
app.use((err, req, res, next) => {
  console.error('[error]', req.method, req.path, err && err.message);
  if (res.headersSent) return next(err);
  if (req.path.startsWith('/api/')) return res.status(500).json({ error: 'server_error' });
  res.status(500).send('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Something went wrong \u2014 VIRAL CLIPS</title></head><body style="background:#07080c;color:#f2f3f5;font-family:system-ui,sans-serif;text-align:center;padding:80px 20px"><h1>Something went wrong</h1><p style="color:#9aa0ab">Please try again in a bit.</p><a href="/" style="color:#ff2d55;font-weight:700">Back to homepage</a></body></html>');
});

app.listen(PORT, () => {
  console.log(`VIRAL CLIPS running on ${BASE_URL}`);
  console.log(`Video storage: ${R2_ON ? 'Cloudflare R2 (bucket: ' + R2_BUCKET + ')' : 'local disk'}`);
  console.log(`Plans: ${PLANS.map((p) => `${p.name} ₹${p.price}`).join(' | ')}`);
  if (ADMIN_PASSWORD === 'change-me-now') console.log('⚠ Set ADMIN_PASSWORD env var before going live.');
  if (!process.env.RESEND_API_KEY && !process.env.BREVO_API_KEY) console.log('⚠ Email not configured — magic links will be shown in the admin panel to send manually.');
});
