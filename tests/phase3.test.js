// VIRAL CLIPS — Phase 3 tests (backups + usage). Same harness style as
// phase2.test.js; runs against a real server on a scratch port with a
// scratch database. Run with: npm test
// Note: test servers run WITHOUT R2 variables, so the R2 upload path is
// intentionally not exercised here — the no-R2 behaviour is what is tested.
// The live R2 path is verified by tapping "Backup now" in the admin panel.
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
      R2_ENDPOINT: '', R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: '', R2_BUCKET: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://localhost:${port}`;
  const deadline = Date.now() + 15000;
  for (;;) {
    try { const r = await fetch(base + '/health'); if (r.ok) break; } catch (e) { /* not up yet */ }
    if (Date.now() > deadline) { child.kill(); throw new Error('server did not start in time'); }
    await sleep(200);
  }
  return { child, base };
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

async function login(base) {
  const r = await fetch(base + '/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-admin-123' }),
  });
  assert.equal(r.status, 200);
  return cookiesOf(r);
}

let srv;
before(async () => { srv = await startServer(); });
after(() => { srv.child.kill(); });

test('usage endpoint needs login, then returns numbers', { timeout: 30000 }, async () => {
  const anon = await fetch(srv.base + '/api/admin/usage');
  assert.equal(anon.status, 401);
  const { header } = await login(srv.base);
  const r = await fetch(srv.base + '/api/admin/usage', { headers: { Cookie: header } });
  assert.equal(r.status, 200);
  const d = await r.json();
  for (const k of ['dbSize', 'uploadsSize', 'videos', 'subscriptions', 'payments']) {
    assert.equal(typeof d[k], 'number', k);
  }
  assert.ok(d.dbSize > 0, 'fresh test database file exists and is non-empty');
});

test('backup endpoint without R2 reports unavailable (not a crash)', { timeout: 30000 }, async () => {
  const { jar, header } = await login(srv.base);
  // without the CSRF token -> 403 first (route is protected)
  const noToken = await fetch(srv.base + '/api/admin/backup', {
    method: 'POST', headers: { Cookie: header },
  });
  assert.equal(noToken.status, 403);
  // with a valid token -> passes CSRF, then 503 because R2 is off in tests
  const withToken = await fetch(srv.base + '/api/admin/backup', {
    method: 'POST', headers: { Cookie: header, 'x-csrf-token': jar.vc_csrf },
  });
  assert.equal(withToken.status, 503);
  const d = await withToken.json();
  assert.equal(d.error, 'backup_unavailable');
});
