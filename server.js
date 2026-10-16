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

const PLANS = [
  { id: '1m',   name: '1 Month',  months: 1,  price: 299  },
  { id: '3m',   name: '3 Months', months: 3,  price: 799  },
  { id: '6m',   name: '6 Months', months: 6,  price: 1599 },
  { id: '1y',   name: '1 Year',   months: 12, price: 2999 },
  { id: 'life', name: 'Lifetime', months: null, price: 9999 },
];
const planById = (id) => PLANS.find((p) => p.id === id);

// ---------------- email via Brevo HTTP API ----------------
// (Gmail SMTP is blocked on Railway's network, so we send over HTTPS instead.)
async function sendAccessEmail(to, name, plan, link, expiresAt) {
  if (!process.env.BREVO_API_KEY) return { sent: false, reason: 'BREVO_API_KEY not configured' };
  const expiryLine = expiresAt
    ? `Your access is valid until ${new Date(expiresAt).toLocaleString('en-IN')}.`
    : 'Your access never expires (Lifetime plan).';
  const text =
`Hi ${name},

Thanks for subscribing to VIRAL CLIPS!

Your private access link (works on ONE device only — open it on the device you want to watch on):

${link}

${expiryLine}
Do not share this link. If opened on a different device, access will be blocked.

Enjoy!
— Team VIRAL CLIPS`;
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': process.env.BREVO_API_KEY },
    body: JSON.stringify({
      sender: { email: process.env.SMTP_FROM || process.env.SMTP_USER, name: 'VIRAL CLIPS' },
      to: [{ email: to, name }],
      subject: `Your VIRAL CLIPS access link (${plan.name})`,
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
  const row = db.prepare('SELECT * FROM admin_sessions WHERE id = ?').get(sid);
  if (!row) return res.status(401).json({ error: 'admin_login_required' });
  next();
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
  // CSP: allow self + inline (pages use inline scripts/styles); videos from self; QR is data: URL
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; media-src 'self'; connect-src 'self'; frame-ancestors 'none'");
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

app.get('/api/qr/:planId', async (req, res) => {
  const plan = planById(req.params.planId);
  if (!plan) return res.status(404).json({ error: 'unknown_plan' });
  const upiUrl = `upi://pay?pa=${encodeURIComponent(UPI_ID)}&pn=${encodeURIComponent(PAYEE_NAME)}&am=${plan.price}&cu=INR&tn=${encodeURIComponent('VIRALCLIPS-' + plan.id)}`;
  const qr = await QRCode.toDataURL(upiUrl, { width: 320, margin: 1 });
  res.json({ qr, upiId: UPI_ID, payee: PAYEE_NAME, amount: plan.price, upiUrl });
});

// Customer submits payment proof after paying via UPI app.
app.post('/api/payments', rateLimit({ windowMs: 60000, max: 10 }), (req, res) => {
  const { name, email, planId, utr } = req.body || {};
  const plan = planById(planId);
  if (!name || !email || !plan || !utr) {
    return res.status(400).json({ error: 'missing_fields', message: 'Name, email, plan and UTR / transaction ID are required.' });
  }
  if (String(name).length > 80 || String(utr).length > 40 || String(email).length > 120) {
    return res.status(400).json({ error: 'too_long', message: 'One of the fields is too long.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'bad_email', message: 'Please enter a valid email address.' });
  }
  const info = db.prepare(
    'INSERT INTO payments (name, email, plan_id, amount, utr, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(name.trim(), email.trim().toLowerCase(), plan.id, plan.price, utr.trim(), Date.now());
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
app.get('/api/stream/:id', requireSubscriber, (req, res) => {
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
  if (!video) return res.status(404).json({ error: 'not_found' });
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

// Public teaser (titles only — no streams).
app.get('/api/teasers', (req, res) => {
  const rows = db.prepare('SELECT id, title, created_at FROM videos ORDER BY created_at DESC').all();
  res.json({ count: rows.length, videos: rows });
});

// ---- admin ----
app.post('/api/admin/login', rateLimit({ windowMs: 60000, max: 8 }), (req, res) => {
  const { password } = req.body || {};
  const a = Buffer.from(String(password || ''));
  const b = Buffer.from(ADMIN_PASSWORD);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return res.status(401).json({ error: 'wrong_password' });
  const sid = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO admin_sessions (id, created_at) VALUES (?, ?)').run(sid, Date.now());
  res.cookie('vc_admin', sid, { httpOnly: true, sameSite: 'lax', secure: IS_HTTPS, maxAge: 12 * 3600 * 1000 });
  res.json({ ok: true });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM admin_sessions WHERE id = ?').run(req.cookies.vc_admin);
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
    'INSERT INTO subscriptions (payment_id, name, email, plan_id, token, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(payment.id, payment.name, payment.email, plan.id, token, expiresAt, Date.now());

  let emailResult = { sent: false, reason: 'SMTP not configured — copy the link and send it manually.' };
  try {
    emailResult = await sendAccessEmail(payment.email, payment.name, plan, link, expiresAt);
  } catch (e) {
    emailResult = { sent: false, reason: 'Email failed: ' + e.message };
  }
  res.json({ ok: true, link, email: emailResult });
});

app.post('/api/admin/reject', requireAdmin, (req, res) => {
  const { paymentId } = req.body || {};
  db.prepare("UPDATE payments SET status = 'rejected' WHERE id = ? AND status = 'pending'").run(paymentId);
  res.json({ ok: true });
});

app.get('/api/admin/subscriptions', requireAdmin, (req, res) => {
  const rows = db.prepare(
    'SELECT id, name, email, plan_id, used_at, expires_at, created_at FROM subscriptions ORDER BY created_at DESC'
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

app.post('/api/admin/videos', requireAdmin, (req, res) => {
  upload.single('video')(req, res, (err) => {
    if (err) return res.status(400).json({ error: 'upload_failed', message: err.message });
    if (!req.file) return res.status(400).json({ error: 'no_file' });
    const title = (req.body.title || path.parse(req.file.originalname).name).trim();
    const info = db.prepare(
      'INSERT INTO videos (title, filename, mime, size, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(title, req.file.filename, req.file.mimetype, req.file.size, Date.now());
    res.json({ ok: true, id: Number(info.lastInsertRowid), title });
  });
});

app.delete('/api/admin/videos/:id', requireAdmin, (req, res) => {
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
  if (!video) return res.status(404).json({ error: 'not_found' });
  db.prepare('DELETE FROM videos WHERE id = ?').run(video.id);
  const fp = path.join(UPLOAD_DIR, path.basename(video.filename));
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  res.json({ ok: true });
});

app.get('/api/admin/videos', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT id, title, size, created_at FROM videos ORDER BY created_at DESC').all());
});

app.listen(PORT, () => {
  console.log(`VIRAL CLIPS running on ${BASE_URL}`);
  console.log(`Plans: ${PLANS.map((p) => `${p.name} ₹${p.price}`).join(' | ')}`);
  if (ADMIN_PASSWORD === 'change-me-now') console.log('⚠ Set ADMIN_PASSWORD env var before going live.');
  if (!process.env.BREVO_API_KEY) console.log('⚠ Email not configured — magic links will be shown in the admin panel to send manually.');
});
