// VIRAL CLIPS — Phase 2 test suite (Node built-in test runner, no new deps).
// Run with: npm test
// Each test talks to a real server started on a scratch port with a scratch
// database, so nothing here touches production data or the live site.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
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

async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-test-'));
  const uploadDir = path.join(dir, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER_FILE], {
    env: {
      ...process.env,
      PORT: String(port),
      BASE_URL: `http://localhost:${port}`,
      ADMIN_PASSWORD: 'test-admin-123',
      DB_PATH: path.join(dir, 'test.db'),
      UPLOAD_DIR: uploadDir,
      // force local mode so tests never touch Cloudflare
      R2_ENDPOINT: '', R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: '', R2_BUCKET: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
  return { child, base, out: () => out };
}

// Parse Set-Cookie headers into a Cookie header value + a lookup map.
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

let srv;
before(async () => { srv = await startServer(); });
after(() => { srv.child.kill(); });

test('health endpoint answers ok (local storage in tests)', { timeout: 30000 }, async () => {
  const r = await fetch(srv.base + '/health');
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.ok, true);
  assert.equal(d.storage, 'local');
  assert.equal(typeof d.uptime, 'number');
});

test('unknown page returns the branded 404 page', { timeout: 30000 }, async () => {
  const r = await fetch(srv.base + '/this-page-does-not-exist');
  assert.equal(r.status, 404);
  const body = await r.text();
  assert.match(body, /This page doesn't exist/);
});

test('unknown API returns a JSON 404', { timeout: 30000 }, async () => {
  const r = await fetch(srv.base + '/api/nope');
  assert.equal(r.status, 404);
  const d = await r.json();
  assert.equal(d.error, 'not_found');
});

test('security headers are present on the homepage', { timeout: 30000 }, async () => {
  const r = await fetch(srv.base + '/');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.match(r.headers.get('content-security-policy') || '', /default-src/);
});

test('plans and teasers endpoints answer 200', { timeout: 30000 }, async () => {
  for (const p of ['/api/plans', '/api/teasers']) {
    const r = await fetch(srv.base + p);
    assert.equal(r.status, 200, p);
  }
});

test('wrong admin password is a clean 401', { timeout: 30000 }, async () => {
  const r = await fetch(srv.base + '/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'definitely-wrong' }),
  });
  assert.equal(r.status, 401);
});

test('admin errors endpoint needs login, then returns a list', { timeout: 30000 }, async () => {
  const anon = await fetch(srv.base + '/api/admin/errors');
  assert.equal(anon.status, 401);
  const login = await fetch(srv.base + '/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-admin-123' }),
  });
  assert.equal(login.status, 200);
  const { header } = cookiesOf(login);
  const authed = await fetch(srv.base + '/api/admin/errors', { headers: { Cookie: header } });
  assert.equal(authed.status, 200);
  assert.ok(Array.isArray(await authed.json()));
});

test('CSRF: state-changing admin call without the token is 403, with it passes', { timeout: 30000 }, async () => {
  const login = await fetch(srv.base + '/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-admin-123' }),
  });
  assert.equal(login.status, 200);
  const { jar, header } = cookiesOf(login);
  assert.ok(jar.vc_admin, 'login sets the admin cookie');
  assert.ok(jar.vc_csrf, 'login sets the CSRF cookie');

  // no token -> 403 (before any upload validation runs)
  const fd = new FormData();
  const noToken = await fetch(srv.base + '/api/admin/teasers', {
    method: 'POST', headers: { Cookie: header }, body: fd,
  });
  assert.equal(noToken.status, 403);

  // correct token -> passes CSRF, then fails only on the missing file (400)
  const fd2 = new FormData();
  const withToken = await fetch(srv.base + '/api/admin/teasers', {
    method: 'POST', headers: { Cookie: header, 'x-csrf-token': jar.vc_csrf }, body: fd2,
  });
  assert.equal(withToken.status, 400);
});

test('request logging records requests', { timeout: 30000 }, async () => {
  await fetch(srv.base + '/health');
  await sleep(300);
  assert.match(srv.out(), /\[req\] GET \/health/);
});

test('QR endpoint is rate-limited (isolated server, fresh budget)', { timeout: 60000 }, async () => {
  const s2 = await startServer();
  try {
    const statuses = [];
    for (let i = 0; i < 35; i++) {
      const r = await fetch(s2.base + '/api/qr/1m');
      statuses.push(r.status);
      await r.arrayBuffer().catch(() => {});
    }
    assert.deepEqual(statuses.slice(0, 30), Array(30).fill(200));
    assert.ok(statuses.slice(30).every((s) => s === 429), 'requests past the limit get 429');
  } finally {
    s2.child.kill();
  }
});
