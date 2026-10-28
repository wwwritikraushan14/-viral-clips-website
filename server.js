// VIRAL CLIPS — paid video subscription server.
// Flow: plans -> UPI QR -> payment proof form -> admin approves ->
// one-time, one-device magic link emailed -> auto-expiry on every request.
require('dotenv').config();
const express = require('express');
const compression = require('compression');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const QRCode = require('qrcode');
const multer = require('multer');
const nodemailer = require('nodemailer');
const db = require('./db');
const { spawn, execFile } = require('child_process');

// ---------------- config ----------------
const PORT = process.env.PORT || 3000;
const UPI_ID = process.env.UPI_ID || 'ritik170501@ptyes';
const PAYEE_NAME = process.env.PAYEE_NAME || 'VIRAL CLIPS';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-now';
// A missing ADMIN_PASSWORD must never fall back to a usable login: the
// well-known default above is treated as "no admin access at all".
const ADMIN_PASSWORD_SET = Boolean(process.env.ADMIN_PASSWORD) && ADMIN_PASSWORD !== 'change-me-now';
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const IS_HTTPS = BASE_URL.startsWith('https://'); // secure cookies only over HTTPS
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---- error tracking (Phase 2): recent server errors, capped at 100 rows ----
try {
  db.exec(`CREATE TABLE IF NOT EXISTS errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
} catch (e) { /* error tracking is best-effort */ }

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

// ---- admin quality downloads: convert on the fly with ffmpeg ----
// Railway's Node image has no ffmpeg, so the static binaries from these
// npm packages are used when installed; a system ffmpeg/ffprobe in PATH
// is the fallback (local testing). Without either, quality downloads
// answer 503 with a plain message instead of crashing.
let FFMPEG_BIN = 'ffmpeg';
let FFPROBE_BIN = 'ffprobe';
try { FFMPEG_BIN = require('@ffmpeg-installer/ffmpeg').path; } catch (e) {}
try { FFPROBE_BIN = require('@ffprobe-installer/ffprobe').path; } catch (e) {}
let FFMPEG_OK = false;
execFile(FFMPEG_BIN, ['-version'], { timeout: 10000 }, (err) => {
  if (err) return;
  execFile(FFPROBE_BIN, ['-version'], { timeout: 10000 }, (err2) => { if (!err2) FFMPEG_OK = true; });
});

// ---------------- automated DB backups to R2 (Phase 3) ----------------
// A consistent snapshot (VACUUM INTO) is uploaded to the owner's own R2
// bucket every 6 hours, keeping the newest 20. The database is small, so
// 20 backups cost almost nothing against the 10 GB free tier. Backups
// hold customer names, phones and UTRs — they live in the same bucket
// and account as the videos, nowhere else.
const BACKUP_PREFIX = 'backups/';
const BACKUP_KEEP = 20;
const BACKUP_EVERY_MS = 6 * 3600 * 1000;
async function runBackup() {
  if (!R2_ON) return { ok: false, reason: 'R2 is not configured — backups need R2.' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-backup-'));
  const snap = path.join(dir, 'viral-clips.db');
  try {
    db.exec(`VACUUM INTO '${snap.replace(/'/g, "''")}'`);
    const body = fs.readFileSync(snap);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const key = BACKUP_PREFIX + 'viral-clips-' + stamp + '.db';
    await s3.send(new s3Commands.PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: body }));
    const listed = await s3.send(new s3Commands.ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: BACKUP_PREFIX }));
    const objs = (listed.Contents || []).sort((a, b) => a.LastModified - b.LastModified);
    for (const o of objs.slice(0, Math.max(0, objs.length - BACKUP_KEEP))) {
      await s3.send(new s3Commands.DeleteObjectCommand({ Bucket: R2_BUCKET, Key: o.Key }));
    }
    return { ok: true, key, size: body.length };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* temp cleanup is best-effort */ }
  }
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
  // Legacy sessions never had an expiry — enforce the same 12-hour life
  // as signed cookies, and drop dead rows instead of honouring them forever.
  if (Date.now() - row.created_at > ADMIN_SESSION_MS) {
    try { db.prepare('DELETE FROM admin_sessions WHERE id = ?').run(sid); } catch (e) {}
    return res.status(401).json({ error: 'admin_login_required' });
  }
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
  if (!ADMIN_PASSWORD_SET) return false; // no real password -> no sessions, not even old ones
  const parts = String(tok || '').split('.');
  if (parts.length !== 2) return false;
  const [exp, sig] = parts;
  if (!/^\d+$/.test(exp) || Date.now() > Number(exp)) return false;
  const want = crypto.createHmac('sha256', ADMIN_PASSWORD).update('vc-admin:' + exp).digest('hex');
  const a = Buffer.from(sig), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Login comparison on hashes: a wrong password must never leak the real
// password's length through timing (the old length check short-circuited).
function passwordMatches(password) {
  if (!ADMIN_PASSWORD_SET) return false;
  const a = crypto.createHash('sha256').update(String(password || '')).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

function page(title, heading, message, cta) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — VIRAL CLIPS</title><link rel="stylesheet" href="/styles.css"></head>
<body><div class="wrap center"><div class="card">
<h1>${heading}</h1><p class="muted">${message}</p>
${cta || '<a class="btn" href="/">Back to home</a>'}
</div></div></body></html>`;
}

// ---- async safety (security audit): Express 4 does not forward rejected
// promises from async route handlers to the error middleware — an
// unexpected throw (full disk, vanished file) would otherwise become an
// unhandled rejection and can crash the whole server. Wrap async routes
// so every failure becomes a clean generic 500 instead.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

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
  // No includeSubDomains: this host lives on Railway's shared domain.
  // (On plain HTTP the header is ignored by browsers, so local dev is unaffected.)
  res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  // CSP: allow self + inline (pages use inline scripts/styles); videos from self (+ R2 when configured); QR is data: URL
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; media-src 'self'" + (R2_ON ? ' https://*.r2.cloudflarestorage.com' : '') + "; connect-src 'self'; frame-ancestors 'none'");
  next();
});

// Magic-link tokens travel in the URL path (/access/<token>), so plain
// path logging would store live tokens in Railway logs and the errors
// table. Redact that one segment everywhere a path is recorded.
const redactPath = (p) => String(p || '').replace(/^\/access\/[^/]+/, '/access/[redacted]');

// ---- request logging (Phase 1) ----
// Logs method + path + status + time only. req.path never includes the
// query string (which can carry tokens), and we never log cookies/bodies.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`[req] ${req.method} ${redactPath(req.path)} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

// ---- simple in-memory rate limiter ----
const buckets = new Map();
const RATE_BUCKETS_MAX = 5000;
function rateLimit({ windowMs, max }) {
  return (req, res, next) => {
    const key = (req.ip || '') + req.path;
    const now = Date.now();
    // Bound memory: drop expired buckets, and if still over the cap drop
    // the oldest entries first (Map keeps insertion order). An evicted
    // visitor simply gets a fresh budget — never a crash, never a block.
    if (buckets.size > RATE_BUCKETS_MAX) {
      for (const [k, b] of buckets) { if (now > b.reset) buckets.delete(k); }
      while (buckets.size > RATE_BUCKETS_MAX) { buckets.delete(buckets.keys().next().value); }
    }
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

app.get('/api/qr/:planId', rateLimit({ windowMs: 60000, max: 30 }), ah(async (req, res) => {
  const plan = planById(req.params.planId);
  if (!plan) return res.status(404).json({ error: 'unknown_plan' });
  const upiUrl = `upi://pay?pa=${encodeURIComponent(UPI_ID)}&pn=${encodeURIComponent(PAYEE_NAME)}&am=${plan.price}&cu=INR&tn=${encodeURIComponent('VIRALCLIPS-' + plan.id)}`;
  const qr = await QRCode.toDataURL(upiUrl, { width: 320, margin: 1 });
  res.json({ qr, upiId: UPI_ID, payee: PAYEE_NAME, amount: plan.price, upiUrl });
}));

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
  let info;
  try {
    info = db.prepare(
      'INSERT INTO payments (name, email, phone, plan_id, amount, utr, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(name.trim(), emailClean, digits, plan.id, plan.price, utr.trim(), Date.now());
  } catch (e) {
    // UTRs are unique per UPI transaction: the same proof twice would
    // otherwise create two pending rows that could both be approved.
    if (/UNIQUE constraint/i.test(e.message)) {
      return res.status(400).json({ error: 'duplicate_utr', message: 'This UTR / transaction ID was already submitted.' });
    }
    throw e;
  }
  res.json({ ok: true, paymentId: Number(info.lastInsertRowid),
    message: 'Payment details received. You will get your private access link on WhatsApp once verified.' });
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

// Shared video serving for members AND the admin panel: R2 videos redirect
// to a private signed link (valid 6h), local videos stream from disk with
// range support so the player can seek. download=true adds a
// Content-Disposition attachment header so the browser saves the file
// instead of playing it.
function downloadName(video) {
  const base = (video.title || 'video').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^[._]+|[._]+$/g, '') || 'video';
  const ext = (path.extname(video.filename || '').toLowerCase().match(/^\.[a-z0-9]{1,5}$/) || ['.mp4'])[0];
  return base + ext;
}
async function serveVideo(video, req, res, download) {
  // Cloudflare R2 video: hand over a private signed link (valid 6h)
  // and let Cloudflare serve the video directly — no Railway bandwidth used.
  if (video.storage === 'r2') {
    if (!R2_ON) return res.status(503).json({ error: 'storage_unavailable' });
    try {
      const cmd = new s3Commands.GetObjectCommand({
        Bucket: R2_BUCKET, Key: video.filename,
        ...(download ? { ResponseContentDisposition: `attachment; filename="${downloadName(video)}"` } : {}),
      });
      const url = await getSignedUrl(s3, cmd, { expiresIn: 6 * 3600 });
      return res.redirect(302, url);
    } catch (e) {
      return res.status(502).json({ error: 'storage_error', message: 'Could not reach video storage. Try again.' });
    }
  }
  const filePath = path.join(UPLOAD_DIR, path.basename(video.filename));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'file_missing' });
  const stat = fs.statSync(filePath);
  const range = req.headers.range;
  // Never trust the stored mime type for the response header: only a
  // video/* type is served, anything else falls back to mp4.
  const contentType = (video.mime || '').startsWith('video/') ? video.mime : 'video/mp4';
  const extra = download ? { 'Content-Disposition': `attachment; filename="${downloadName(video)}"` } : {};
  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(startStr, 10);
    // Clamp the end to the real file size: an end past EOF would declare
    // a Content-Length the body never reaches, hanging the player.
    const end = Math.min(endStr ? parseInt(endStr, 10) : stat.size - 1, stat.size - 1);
    if (isNaN(start) || isNaN(end) || start > end || start >= stat.size) return res.status(416).send('Range not satisfiable');
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': contentType,
      ...extra,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': contentType, 'Accept-Ranges': 'bytes', ...extra });
    fs.createReadStream(filePath).pipe(res);
  }
}

// Token-gated video streaming with range support.
app.get('/api/stream/:id', requireSubscriber, ah(async (req, res) => {
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
  if (!video) return res.status(404).json({ error: 'not_found' });
  return serveVideo(video, req, res, false);
}));

// Public teasers: homepage gallery photos uploaded via the admin panel.
app.get('/api/teasers', rateLimit({ windowMs: 60000, max: 120 }), (req, res) => {
  res.json(db.prepare('SELECT id, title FROM teasers ORDER BY created_at DESC').all());
});

// ---- CSRF protection (Phase 2): double-submit cookie ----
// Login sets a readable vc_csrf cookie; the admin panel sends it back as
// x-csrf-token on every state-changing request. sameSite=lax cookies
// already block most cross-site posts; this closes the rest.
function requireCsrf(req, res, next) {
  const sent = req.headers['x-csrf-token'];
  const cookie = req.cookies.vc_csrf;
  if (!sent || !cookie || sent.length !== cookie.length) {
    return res.status(403).json({ error: 'bad_csrf', message: 'Missing or invalid CSRF token.' });
  }
  if (!crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(cookie))) {
    return res.status(403).json({ error: 'bad_csrf', message: 'Missing or invalid CSRF token.' });
  }
  next();
}


// ---- admin ----
app.post('/api/admin/login', rateLimit({ windowMs: 60000, max: 8 }), (req, res) => {
  const { password } = req.body || {};
  if (!passwordMatches(password)) return res.status(401).json({ error: 'wrong_password' });
  res.cookie('vc_admin', adminToken(), { httpOnly: true, sameSite: 'lax', secure: IS_HTTPS, maxAge: ADMIN_SESSION_MS });
  res.cookie('vc_csrf', crypto.randomBytes(24).toString('hex'), { httpOnly: false, sameSite: 'lax', secure: IS_HTTPS, maxAge: ADMIN_SESSION_MS });
  res.json({ ok: true });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  try { db.prepare('DELETE FROM admin_sessions WHERE id = ?').run(req.cookies.vc_admin); } catch (e) { /* legacy cleanup is best-effort */ }
  // Pass the same flags the cookies were set with, or some browsers keep
  // the old (Secure) cookie and the "logout" silently does nothing.
  res.clearCookie('vc_admin', { httpOnly: true, sameSite: 'lax', secure: IS_HTTPS });
  res.clearCookie('vc_csrf', { sameSite: 'lax', secure: IS_HTTPS });
  res.json({ ok: true });
});

app.get('/api/admin/payments', requireAdmin, (req, res) => {
  const status = req.query.status || 'pending';
  const rows = db.prepare('SELECT * FROM payments WHERE status = ? ORDER BY created_at DESC').all(status);
  res.json(rows);
});

// Approve -> creates the one-time one-device magic link, emails it.
app.post('/api/admin/approve', requireAdmin, requireCsrf, ah(async (req, res) => {
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

  // Atomic claim: if two approvals race (double-click, double tab), only
  // the first wins; the second sees 0 changed rows and stops here.
  const claimed = db.prepare("UPDATE payments SET status = 'approved' WHERE id = ? AND status = 'pending'").run(payment.id);
  if (claimed.changes !== 1) {
    return res.status(400).json({ error: 'bad_payment', message: 'Payment not found or already handled.' });
  }
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
}));

app.post('/api/admin/reject', requireAdmin, requireCsrf, (req, res) => {
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
app.delete('/api/admin/subscriptions/:id', requireAdmin, requireCsrf, (req, res) => {
  db.prepare('DELETE FROM subscriptions WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Let a device-locked subscriber start over: clears the first-open bind so
// the same link can be opened fresh on the subscriber's current device.
// (Without this, a subscriber whose phone changed network/IP had no way
// back in short of deleting and re-creating their subscription.)
app.post('/api/admin/subscriptions/:id/reset-device', requireAdmin, requireCsrf, (req, res) => {
  const info = db.prepare('UPDATE subscriptions SET used_at = NULL, device_fp = NULL WHERE id = ?').run(req.params.id);
  if (info.changes !== 1) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

// Extend a subscription by N months (1-24).
app.post('/api/admin/subscriptions/:id/extend', requireAdmin, requireCsrf, (req, res) => {
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

// Video upload (admin). Extensions are allow-listed, not just the
// client-claimed mime type: a file claiming to be a video but named
// .html/.svg must never be stored or served back with a trusted type.
const VIDEO_EXTS = ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v', '.3gp'];
const IMAGE_EXTS = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
// Multer's default "File too large" tells the admin nothing — translate it.
function uploadErrMessage(err, what, limitText) {
  if (err && err.code === 'LIMIT_FILE_SIZE') return `${what} is too large — keep it under ${limitText}.`;
  return err ? err.message : 'Upload failed';
}
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, Date.now() + '-' + crypto.randomBytes(6).toString('hex') + path.extname(file.originalname)),
  }),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (file.mimetype.startsWith('video/') && VIDEO_EXTS.includes(ext)) cb(null, true);
    else cb(new Error('Only video files are allowed (' + VIDEO_EXTS.join(', ') + ')'));
  },
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1 GB (disk-streamed, no RAM issue)
});

// R2 mode: hold the file in memory briefly, then send it to Cloudflare —
// nothing is written to the (full) Railway disk.
const uploadR2 = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (file.mimetype.startsWith('video/') && VIDEO_EXTS.includes(ext)) cb(null, true);
    else cb(new Error('Only video files are allowed (' + VIDEO_EXTS.join(', ') + ')'));
  },
  // Memory storage holds the whole file in RAM: 1 GB here could OOM-kill
  // the whole server on a small Railway container. 300 MB fails gracefully
  // with a clear message instead of taking the site down for everyone.
  limits: { fileSize: 300 * 1024 * 1024 },
});

app.post('/api/admin/videos', rateLimit({ windowMs: 3600000, max: 30 }), requireAdmin, requireCsrf, (req, res, next) => {
  const handler = R2_ON ? uploadR2.single('video') : upload.single('video');
  handler(req, res, async (err) => {
    try {
    if (err) return res.status(400).json({ error: 'upload_failed', message: uploadErrMessage(err, 'Video', R2_ON ? '300 MB in cloud mode' : '1 GB') });
    if (!req.file) return res.status(400).json({ error: 'no_file' });
    const title = (req.body.title || path.parse(req.file.originalname).name).trim();
    if (title.length > 120) {
      // Reject before anything else is stored; remove the local file
      // multer just wrote (R2 mode has nothing to clean — upload is below).
      if (!R2_ON) { try { fs.unlinkSync(req.file.path); } catch (e) {} }
      return res.status(400).json({ error: 'title_too_long', message: 'Title must be 120 characters or less.' });
    }
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
        console.error('[upload] R2 put failed:', e.message);
        return res.status(502).json({ error: 'storage_error', message: 'Could not upload to video storage. Try again.' });
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
    } catch (e) { next(e); }
  });
});

app.delete('/api/admin/videos/:id', requireAdmin, requireCsrf, ah(async (req, res) => {
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
}));

app.get('/api/admin/videos', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT id, title, size, created_at FROM videos ORDER BY created_at DESC').all());
});


// ---- admin quality-download helpers ----
// Read a video's real size (width/height). Works for a disk file and for
// an https URL (ffmpeg reads just the header over range requests).
function probeHeight(input) {
  return new Promise((resolve) => {
    execFile(FFPROBE_BIN, ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=p=0', input],
      { timeout: 30000 }, (err, stdout) => {
        if (err) return resolve(null);
        const parts = String(stdout).trim().split(',').map(Number);
        resolve(parts.length === 2 && parts[1] > 0 ? { width: parts[0], height: parts[1] } : null);
      });
  });
}
const QUALITY_STEPS = [240, 360, 720, 1080];
// Only offer qualities at or below the original — upscaling a 360p video
// to 1080p would just make a bigger file, not a better picture.
function availableQualities(height) {
  return height ? QUALITY_STEPS.filter((q) => q <= height) : [];
}
// Resolve what ffmpeg should read: a disk path for local videos, a short
// signed URL for R2 videos. Returns null when the source can't be reached.
async function adminVideoInput(video) {
  if (video.storage === 'r2') {
    if (!R2_ON) return null;
    try {
      return await getSignedUrl(
        s3,
        new s3Commands.GetObjectCommand({ Bucket: R2_BUCKET, Key: video.filename }),
        { expiresIn: 3600 }
      );
    } catch (e) { return null; }
  }
  const fp = path.join(UPLOAD_DIR, path.basename(video.filename));
  return fs.existsSync(fp) ? fp : null;
}
// Convert to the requested height and stream the result straight to the
// download — nothing is written to disk first, so a full Railway disk
// can't block it and a big video doesn't eat RAM.
function transcodeDownload(video, input, targetH, req, res) {
  const outName = downloadName(video).replace(/\.[a-z0-9]+$/i, '') + '-' + targetH + 'p.mp4';
  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Content-Disposition': `attachment; filename="${outName}"`,
  });
  const ff = spawn(FFMPEG_BIN, ['-hide_banner', '-loglevel', 'error', '-i', input,
    '-vf', `scale=-2:${targetH}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-c:a', 'aac', '-movflags', 'frag_keyframe+empty_moov+faststart', '-f', 'mp4', 'pipe:1']);
  ff.stderr.resume(); // drain progress output so ffmpeg never blocks on a full pipe
  ff.stdout.pipe(res);
  let done = false;
  const finish = () => { if (!done) { done = true; try { res.end(); } catch (e) {} } };
  ff.on('error', finish);
  ff.on('close', finish);
  req.on('close', () => { try { ff.kill('SIGKILL'); } catch (e) {} });
}

// Admin preview + download: the admin is NOT a subscriber, so the member
// /api/stream route (requireSubscriber) can never serve them. These two
// admin-only routes use the same serving code instead.
app.get('/api/admin/videos/:id/stream', requireAdmin, ah(async (req, res) => {
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
  if (!video) return res.status(404).json({ error: 'not_found' });
  return serveVideo(video, req, res, false);
}));
// What the Download menu shows for one video: Original always, plus every
// step at or below the video's real height (never upscale).
app.get('/api/admin/videos/:id/qualities', requireAdmin, ah(async (req, res) => {
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
  if (!video) return res.status(404).json({ error: 'not_found' });
  if (!FFMPEG_OK) return res.json({ height: null, qualities: [] });
  const input = await adminVideoInput(video);
  if (!input) return res.json({ height: null, qualities: [] });
  const dims = await probeHeight(input);
  res.json({ height: dims ? dims.height : null, qualities: availableQualities(dims ? dims.height : null) });
}));
app.get('/api/admin/videos/:id/download', requireAdmin, ah(async (req, res) => {
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
  if (!video) return res.status(404).json({ error: 'not_found' });
  const q = String(req.query.quality || 'original').toLowerCase();
  if (q === 'original') return serveVideo(video, req, res, true);
  const target = parseInt(q, 10);
  if (!QUALITY_STEPS.includes(target)) return res.status(400).json({ error: 'bad_quality', message: 'Quality must be 240, 360, 720 or 1080.' });
  if (!FFMPEG_OK) return res.status(503).json({ error: 'transcode_unavailable', message: 'Quality downloads need the server video tools — they are not installed on this server yet.' });
  const input = await adminVideoInput(video);
  if (!input) return res.status(503).json({ error: 'storage_unavailable', message: 'Could not reach this video. Try the Original download.' });
  const dims = await probeHeight(input);
  if (!dims) return res.status(502).json({ error: 'probe_failed', message: 'Could not read this video. Try the Original download.' });
  if (target >= dims.height) return serveVideo(video, req, res, true); // already at or below target: original is best
  return transcodeDownload(video, input, target, req, res);
}));

// ---------- homepage teaser images (admin uploads, shown on homepage gallery) ----------
const teaserUpload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, 'teaser-' + Date.now() + '-' + crypto.randomBytes(6).toString('hex') + path.extname(file.originalname)),
  }),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (file.mimetype.startsWith('image/') && IMAGE_EXTS[ext]) cb(null, true);
    else cb(new Error('Only photo files are allowed (.jpg, .png, .webp, .gif) — SVG is not allowed'));
  },
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
});

app.post('/api/admin/teasers', rateLimit({ windowMs: 3600000, max: 30 }), requireAdmin, requireCsrf, (req, res, next) => {
  teaserUpload.single('image')(req, res, (err) => {
    try {
    if (err) return res.status(400).json({ error: 'upload_failed', message: uploadErrMessage(err, 'Photo', '15 MB') });
    if (!req.file) return res.status(400).json({ error: 'no_file' });
    const title = (req.body.title || path.parse(req.file.originalname).name).trim();
    if (title.length > 120) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      return res.status(400).json({ error: 'title_too_long', message: 'Title must be 120 characters or less.' });
    }
    const info = db.prepare(
      'INSERT INTO teasers (title, filename, mime, size, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(title, req.file.filename, req.file.mimetype, req.file.size, Date.now());
    res.json({ ok: true, id: Number(info.lastInsertRowid), title });
    } catch (e) { next(e); }
  });
});

app.delete('/api/admin/teasers/:id', requireAdmin, requireCsrf, (req, res) => {
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

// ---- error tracking (Phase 2): recent errors for the admin panel ----
app.get('/api/admin/errors', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT id, method, path, message, created_at FROM errors ORDER BY id DESC LIMIT 50').all();
  res.json(rows);
});

// ---- backups + usage (Phase 3) ----
app.post('/api/admin/backup', requireAdmin, requireCsrf, async (req, res) => {
  try {
    const r = await runBackup();
    if (!r.ok) return res.status(503).json({ error: 'backup_unavailable', message: r.reason });
    res.json({ ok: true, key: r.key, size: r.size });
  } catch (e) {
    console.error('[backup] failed:', e.message);
    res.status(500).json({ error: 'backup_failed', message: 'Backup failed. Try again.' });
  }
});

function dirSize(root) {
  let total = 0;
  try {
    for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
      const p = path.join(root, ent.name);
      if (ent.isDirectory()) total += dirSize(p);
      else if (ent.isFile()) { try { total += fs.statSync(p).size; } catch (e) {} }
    }
  } catch (e) { /* a missing dir counts as zero */ }
  return total;
}

app.get('/api/admin/usage', requireAdmin, (req, res) => {
  const dbFile = process.env.DB_PATH || path.join(__dirname, 'viral-clips.db');
  let dbSize = 0;
  try { dbSize = fs.statSync(dbFile).size; } catch (e) {}
  const videos = db.prepare('SELECT COUNT(*) AS c FROM videos').get().c;
  const subs = db.prepare('SELECT COUNT(*) AS c FROM subscriptions').get().c;
  const payments = db.prepare('SELECT COUNT(*) AS c FROM payments').get().c;
  res.json({ dbSize, uploadsSize: dirSize(UPLOAD_DIR), videos, subscriptions: subs, payments });
});

// Public: teaser image file.
// Teaser images are public, so their Content-Type must come from the file
// extension (never the uploader-supplied mime), and the response is
// sandboxed so even a crafted image file can never run scripts here.
app.get('/api/teaser-img/:id', rateLimit({ windowMs: 60000, max: 120 }), (req, res) => {
  const t = db.prepare('SELECT filename FROM teasers WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).end();
  const fp = path.join(UPLOAD_DIR, path.basename(t.filename));
  if (!fs.existsSync(fp)) return res.status(404).end();
  res.setHeader('Content-Type', IMAGE_EXTS[path.extname(t.filename).toLowerCase()] || 'application/octet-stream');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
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
  console.error('[error]', req.method, redactPath(req.path), err && err.message);
  try {
    const msg = String((err && err.message) || 'unknown error').slice(0, 200);
    db.prepare('INSERT INTO errors (method, path, message, created_at) VALUES (?, ?, ?, ?)').run(req.method, redactPath(req.path), msg, Date.now());
    db.prepare('DELETE FROM errors WHERE id NOT IN (SELECT id FROM errors ORDER BY id DESC LIMIT 100)').run();
  } catch (e) { /* error tracking must never break error responses */ }
  if (res.headersSent) return next(err);
  if (req.path.startsWith('/api/')) return res.status(500).json({ error: 'server_error' });
  res.status(500).send('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Something went wrong \u2014 VIRAL CLIPS</title></head><body style="background:#07080c;color:#f2f3f5;font-family:system-ui,sans-serif;text-align:center;padding:80px 20px"><h1>Something went wrong</h1><p style="color:#9aa0ab">Please try again in a bit.</p><a href="/" style="color:#ff2d55;font-weight:700">Back to homepage</a></body></html>');
});

// Phase 3: automatic backups — one shortly after startup, then every 6 hours.
// Runs only when R2 is configured; failures are logged, never fatal.
if (R2_ON) {
  const doBackup = () => runBackup()
    .then((r) => console.log('[backup]', r.ok ? 'saved ' + r.key : 'skipped: ' + r.reason))
    .catch((e) => console.error('[backup] failed', e.message));
  setTimeout(doBackup, 30000);
  setInterval(doBackup, BACKUP_EVERY_MS);
}

app.listen(PORT, () => {
  console.log(`VIRAL CLIPS running on ${BASE_URL}`);
  console.log(`Video storage: ${R2_ON ? 'Cloudflare R2 (bucket: ' + R2_BUCKET + ')' : 'local disk'}`);
  console.log(`Plans: ${PLANS.map((p) => `${p.name} ₹${p.price}`).join(' | ')}`);
  if (!ADMIN_PASSWORD_SET) console.log('⚠ ADMIN_PASSWORD is not set — admin login is DISABLED until it is set.');
  if (!process.env.RESEND_API_KEY && !process.env.BREVO_API_KEY) console.log('⚠ Email not configured — magic links will be shown in the admin panel to send manually.');
});
