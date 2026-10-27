// VIRAL CLIPS — security-audit test suite (2026-10-28). Same harness style as
// phase2/phase3: each test talks to a real server on a scratch port with a
// scratch database, so nothing here touches production data or the live site.
// Run with: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const SERVER_FILE = path.join(__dirname, '..', 'server.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// adminPassword: string -> that password; null -> no ADMIN_PASSWORD at all
// (tests the "default password must never work" hardening).
async function startServer({ adminPassword = 'test-admin-123' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-test-'));
  const uploadDir = path.join(dir, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  const port = await freePort();
  const env = {
    ...process.env,
    PORT: String(port),
    BASE_URL: `http://localhost:${port}`,
    DB_PATH: path.join(dir, 'test.db'),
    UPLOAD_DIR: uploadDir,
    R2_ENDPOINT: '', R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: '', R2_BUCKET: '',
  };
  if (adminPassword === null) delete env.ADMIN_PASSWORD;
  else env.ADMIN_PASSWORD = adminPassword;
  const child = spawn(process.execPath, [SERVER_FILE], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const base = `http://localhost:${port}`;
  const deadline = Date.now() + 15000;
  for (;;) {
    try { const r = await fetch(base + '/health'); if (r.ok) break; } catch (e) { /* not up yet */ }
    if (Date.now() > deadline) { child.kill(); throw new Error('server did not start in time'); }
    await sleep(200);
  }
  return { child, base, dir, uploadDir, dbPath: path.join(dir, 'test.db'), out: () => out };
}

function cookiesOf(res) {
  const jar = {};
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  const header = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  return { jar, header };
}

async function login(base, password = 'test-admin-123') {
  const r = await fetch(base + '/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  assert.equal(r.status, 200, 'admin login should succeed');
  return cookiesOf(r);
}

async function submitPayment(base, { name, utr, planId = '1m', phone = '9876543210' }) {
  const r = await fetch(base + '/api/payments', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, phone, planId, utr }),
  });
  const d = await r.json();
  assert.equal(r.status, 200, 'payment submit should succeed');
  return d.paymentId;
}

async function approvePayment(base, auth, paymentId) {
  const r = await fetch(base + '/api/admin/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: auth.header, 'x-csrf-token': auth.jar.vc_csrf },
    body: JSON.stringify({ paymentId }),
  });
  return r;
}

// Full subscriber flow: payment -> approve -> open magic link -> vc_t cookie.
async function subscriberCookie(base, auth, name, xff) {
  const pid = await submitPayment(base, { name, utr: 'UTR-' + name.replace(/\W/g, '') });
  const appr = await approvePayment(base, auth, pid);
  assert.equal(appr.status, 200, 'approve should succeed');
  const { link } = await appr.json();
  const token = link.split('/access/')[1];
  const open = await fetch(base + '/access/' + token, {
    redirect: 'manual', headers: { 'X-Forwarded-For': xff },
  });
  assert.equal(open.status, 302, 'first open should redirect to watch');
  assert.equal(open.headers.get('location'), '/watch.html');
  return cookiesOf(open).header;
}

function uploadForm({ field, filename, mime, bytes, title }) {
  const fd = new FormData();
  fd.append(field, new Blob([bytes], { type: mime }), filename);
  if (title !== undefined) fd.append('title', title);
  return fd;
}

let srv;
let auth; // one shared admin login (login is rate-limited to 8/min)
before(async () => { srv = await startServer(); auth = await login(srv.base); });
after(() => { srv.child.kill(); });

test('HSTS header is present on the homepage', { timeout: 30000 }, async () => {
  const r = await fetch(srv.base + '/');
  assert.equal(r.headers.get('strict-transport-security'), 'max-age=31536000');
});

test('async failure becomes a generic 500, not a server crash', { timeout: 30000 }, async () => {
  // Upload a video, then replace its file with a directory so the delete
  // path throws (unlink on a directory). Before the async-safety fix this
  // was an unhandled rejection that could kill the whole server.
  const before = new Set(fs.readdirSync(srv.uploadDir));
  const up = await fetch(srv.base + '/api/admin/videos', {
    method: 'POST', headers: { Cookie: auth.header, 'x-csrf-token': auth.jar.vc_csrf },
    body: uploadForm({ field: 'video', filename: 'crash.mp4', mime: 'video/mp4', bytes: Buffer.alloc(1000, 0x61), title: 'Crash test video' }),
  });
  assert.equal(up.status, 200);
  const { id } = await up.json();
  const added = fs.readdirSync(srv.uploadDir).filter((f) => !before.has(f));
  assert.equal(added.length, 1, 'exactly one file should be added');
  const fp = path.join(srv.uploadDir, added[0]);
  fs.unlinkSync(fp);
  fs.mkdirSync(fp);
  const del = await fetch(srv.base + '/api/admin/videos/' + id, {
    method: 'DELETE', headers: { Cookie: auth.header, 'x-csrf-token': auth.jar.vc_csrf },
  });
  assert.equal(del.status, 500, 'delete failure should be a 500');
  const d = await del.json();
  assert.equal(d.error, 'server_error', 'error must be generic');
  assert.ok(!JSON.stringify(d).includes('EISDIR'), 'no internals must leak');
  const health = await fetch(srv.base + '/health');
  assert.equal(health.status, 200, 'server must still be alive after the failure');
  fs.rmdirSync(fp);
});

test('double approval creates exactly one subscription', { timeout: 30000 }, async () => {
  const name = 'Double Approve ' + Date.now();
  const pid = await submitPayment(srv.base, { name, utr: 'UTR-DOUBLE-' + Date.now() });
  const headers = { 'Content-Type': 'application/json', Cookie: auth.header, 'x-csrf-token': auth.jar.vc_csrf };
  const [a, b] = await Promise.all([
    fetch(srv.base + '/api/admin/approve', { method: 'POST', headers, body: JSON.stringify({ paymentId: pid }) }),
    fetch(srv.base + '/api/admin/approve', { method: 'POST', headers, body: JSON.stringify({ paymentId: pid }) }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 400], 'one approve wins, the other is refused');
  const subs = await fetch(srv.base + '/api/admin/subscriptions', { headers: { Cookie: auth.header } }).then((r) => r.json());
  assert.equal(subs.filter((s) => s.name === name).length, 1, 'exactly one subscription for the payment');
});

test('device lock can be cleared by the admin (reset-device)', { timeout: 30000 }, async () => {
  const name = 'Reset Device ' + Date.now();
  const pid = await submitPayment(srv.base, { name, utr: 'UTR-RESET-' + Date.now() });
  const appr = await approvePayment(srv.base, auth, pid);
  assert.equal(appr.status, 200);
  const { link } = await appr.json();
  const token = link.split('/access/')[1];
  const openA = await fetch(srv.base + '/access/' + token, { redirect: 'manual', headers: { 'X-Forwarded-For': '203.0.113.10' } });
  assert.equal(openA.status, 302, 'first device binds the link');
  const openB = await fetch(srv.base + '/access/' + token, { redirect: 'manual', headers: { 'X-Forwarded-For': '203.0.113.20' } });
  assert.equal(openB.status, 403, 'second device is locked out');
  assert.match(await openB.text(), /Locked to another device/);
  const subs = await fetch(srv.base + '/api/admin/subscriptions', { headers: { Cookie: auth.header } }).then((r) => r.json());
  const sub = subs.find((s) => s.name === name);
  assert.ok(sub, 'subscription should exist');
  const reset = await fetch(srv.base + '/api/admin/subscriptions/' + sub.id + '/reset-device', {
    method: 'POST', headers: { Cookie: auth.header, 'x-csrf-token': auth.jar.vc_csrf },
  });
  assert.equal(reset.status, 200, 'admin reset should succeed');
  const openB2 = await fetch(srv.base + '/access/' + token, { redirect: 'manual', headers: { 'X-Forwarded-For': '203.0.113.20' } });
  assert.equal(openB2.status, 302, 'after reset the new device can open the link');
  const openA2 = await fetch(srv.base + '/access/' + token, { redirect: 'manual', headers: { 'X-Forwarded-For': '203.0.113.10' } });
  assert.equal(openA2.status, 403, 'the link is now locked to the new device');
});

test('no ADMIN_PASSWORD means no admin login at all', { timeout: 30000 }, async () => {
  const s2 = await startServer({ adminPassword: null });
  try {
    const byDefault = await fetch(s2.base + '/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'change-me-now' }),
    });
    assert.equal(byDefault.status, 401, 'the well-known default must never log in');
    const byAnything = await fetch(s2.base + '/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'whatever' }),
    });
    assert.equal(byAnything.status, 401);
    // Even a token correctly signed with the default key must be refused.
    const exp = String(Date.now() + 3600000);
    const sig = crypto.createHmac('sha256', 'change-me-now').update('vc-admin:' + exp).digest('hex');
    const forged = await fetch(s2.base + '/api/admin/stats', { headers: { Cookie: `vc_admin=${exp}.${sig}` } });
    assert.equal(forged.status, 401, 'default-key sessions must be dead');
  } finally { s2.child.kill(); }
});

test('logout sends expired cookies for both admin cookies', { timeout: 30000 }, async () => {
  const out = await fetch(srv.base + '/api/admin/logout', {
    method: 'POST', headers: { Cookie: auth.header, 'x-csrf-token': auth.jar.vc_csrf },
  });
  assert.equal(out.status, 200);
  const setCookies = out.headers.getSetCookie().join('\n');
  assert.match(setCookies, /vc_admin=[^;]*;[^]*Expires=Thu, 01 Jan 1970/, 'vc_admin must be expired');
  assert.match(setCookies, /vc_csrf=[^;]*;[^]*Expires=Thu, 01 Jan 1970/, 'vc_csrf must be expired');
});

test('magic-link tokens are redacted from request logs', { timeout: 30000 }, async () => {
  const token = 'ZZTESTTOKEN999';
  const r = await fetch(srv.base + '/access/' + token);
  assert.equal(r.status, 404, 'unknown token is a 404 page');
  await sleep(400);
  const logs = srv.out();
  assert.match(logs, /\[req\] GET \/access\/\[redacted\]/, 'log should show the redacted path');
  assert.ok(!logs.includes(token), 'raw token must never appear in logs');
});

test('streaming clamps out-of-range requests and rejects reversed ranges', { timeout: 30000 }, async () => {
  const xff = '198.51.100.7';
  const subCookie = await subscriberCookie(srv.base, auth, 'Stream Test ' + Date.now(), xff);
  const up = await fetch(srv.base + '/api/admin/videos', {
    method: 'POST', headers: { Cookie: auth.header, 'x-csrf-token': auth.jar.vc_csrf },
    body: uploadForm({ field: 'video', filename: 'range.mp4', mime: 'video/mp4', bytes: Buffer.alloc(1000, 0x62), title: 'Range test video' }),
  });
  assert.equal(up.status, 200);
  const { id } = await up.json();
  const headers = { Cookie: subCookie, 'X-Forwarded-For': xff };
  const full = await fetch(srv.base + '/api/stream/' + id, { headers });
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-length'), '1000');
  assert.equal((await full.arrayBuffer()).byteLength, 1000);
  const beyond = await fetch(srv.base + '/api/stream/' + id, { headers: { ...headers, Range: 'bytes=0-999999' } });
  assert.equal(beyond.status, 206);
  assert.equal(beyond.headers.get('content-range'), 'bytes 0-999/1000', 'end must clamp to the real file size');
  assert.equal(beyond.headers.get('content-length'), '1000', 'length must match the body actually sent');
  await beyond.arrayBuffer();
  const reversed = await fetch(srv.base + '/api/stream/' + id, { headers: { ...headers, Range: 'bytes=5-3' } });
  assert.equal(reversed.status, 416);
});

test('over-long titles are rejected and leave no orphan file', { timeout: 30000 }, async () => {
  const before = new Set(fs.readdirSync(srv.uploadDir));
  const longTitle = 'LONGTITLE-' + 'x'.repeat(190);
  const up = await fetch(srv.base + '/api/admin/videos', {
    method: 'POST', headers: { Cookie: auth.header, 'x-csrf-token': auth.jar.vc_csrf },
    body: uploadForm({ field: 'video', filename: 'long.mp4', mime: 'video/mp4', bytes: Buffer.alloc(500, 0x63), title: longTitle }),
  });
  assert.equal(up.status, 400);
  assert.equal((await up.json()).error, 'title_too_long');
  const after = new Set(fs.readdirSync(srv.uploadDir));
  assert.deepEqual([...after].sort(), [...before].sort(), 'no file may be left behind');
  const videos = await fetch(srv.base + '/api/admin/videos', { headers: { Cookie: auth.header } }).then((r) => r.json());
  assert.ok(!videos.some((v) => v.title === longTitle), 'no video row may be created');
});

test('upload allowlists reject SVG teasers and wrong-mime videos', { timeout: 30000 }, async () => {
  const adminHeaders = { Cookie: auth.header, 'x-csrf-token': auth.jar.vc_csrf };
  const svg = await fetch(srv.base + '/api/admin/teasers', {
    method: 'POST', headers: adminHeaders,
    body: uploadForm({ field: 'image', filename: 'evil.svg', mime: 'image/svg+xml', bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), title: 'evil' }),
  });
  assert.equal(svg.status, 400);
  assert.match((await svg.json()).message, /SVG/);
  const jpg = await fetch(srv.base + '/api/admin/teasers', {
    method: 'POST', headers: adminHeaders,
    body: uploadForm({ field: 'image', filename: 'ok.jpg', mime: 'image/jpeg', bytes: Buffer.alloc(200, 0x64), title: 'ok photo' }),
  });
  assert.equal(jpg.status, 200, 'a real jpg must still upload');
  const htmlVideo = await fetch(srv.base + '/api/admin/videos', {
    method: 'POST', headers: adminHeaders,
    body: uploadForm({ field: 'video', filename: 'x.mp4', mime: 'text/html', bytes: Buffer.from('<script>alert(1)</script>'), title: 'fake video' }),
  });
  assert.equal(htmlVideo.status, 400, 'a .mp4 name with an html mime must be refused');
});

test('teaser images are served with a safe type and a sandboxed CSP', { timeout: 30000 }, async () => {
  const up = await fetch(srv.base + '/api/admin/teasers', {
    method: 'POST', headers: { Cookie: auth.header, 'x-csrf-token': auth.jar.vc_csrf },
    body: uploadForm({ field: 'image', filename: 'safe.jpg', mime: 'image/jpeg', bytes: Buffer.alloc(200, 0x65), title: 'safe photo' }),
  });
  assert.equal(up.status, 200);
  const { id } = await up.json();
  const img = await fetch(srv.base + '/api/teaser-img/' + id);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.equal(img.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  await img.arrayBuffer();
});

test('the same UTR cannot be submitted twice', { timeout: 30000 }, async () => {
  const utr = 'UTR-DUP-' + Date.now();
  const first = await fetch(srv.base + '/api/payments', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'First', phone: '9876543210', planId: '1m', utr }),
  });
  assert.equal(first.status, 200);
  const second = await fetch(srv.base + '/api/payments', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Second', phone: '9876543211', planId: '1m', utr }),
  });
  assert.equal(second.status, 400);
  assert.equal((await second.json()).error, 'duplicate_utr');
});

test('oversized teaser upload gets a clear size message', { timeout: 60000 }, async () => {
  const big = await fetch(srv.base + '/api/admin/teasers', {
    method: 'POST', headers: { Cookie: auth.header, 'x-csrf-token': auth.jar.vc_csrf },
    body: uploadForm({ field: 'image', filename: 'big.jpg', mime: 'image/jpeg', bytes: Buffer.alloc(16 * 1024 * 1024, 0x66), title: 'too big' }),
  });
  assert.equal(big.status, 400);
  assert.match((await big.json()).message, /15 MB/);
});

test('legacy admin sessions expire after 12 hours', { timeout: 30000 }, async () => {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(srv.dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const now = Date.now();
    db.prepare('INSERT INTO admin_sessions (id, created_at) VALUES (?, ?)').run('legacy-fresh-1', now);
    db.prepare('INSERT INTO admin_sessions (id, created_at) VALUES (?, ?)').run('legacy-old-1', now - 13 * 3600 * 1000);
  } finally { db.close(); }
  const fresh = await fetch(srv.base + '/api/admin/stats', { headers: { Cookie: 'vc_admin=legacy-fresh-1' } });
  assert.equal(fresh.status, 200, 'a fresh legacy session still works');
  const old = await fetch(srv.base + '/api/admin/stats', { headers: { Cookie: 'vc_admin=legacy-old-1' } });
  assert.equal(old.status, 401, 'a 13-hour-old legacy session must be refused');
});

test('rate limiter stays bounded under many distinct IPs', { timeout: 120000 }, async () => {
  // 5,100 distinct visitor IPs: past the 5,000-bucket cap, so the eviction
  // path runs. Every request must still succeed and the server must stay up.
  for (let i = 0; i < 5100; i++) {
    const ip = `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
    const r = await fetch(srv.base + '/api/teasers', { headers: { 'X-Forwarded-For': ip } });
    assert.equal(r.status, 200, `request ${i} from ${ip} should succeed`);
    await r.arrayBuffer();
  }
  const health = await fetch(srv.base + '/health');
  assert.equal(health.status, 200, 'server must stay responsive after the flood');
});
