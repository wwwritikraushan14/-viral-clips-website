// SQLite database (Node built-in node:sqlite). File lives next to server.js.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'viral-clips.db'));

db.exec(`
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  utr TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,               -- the magic link token
  used_at INTEGER,                          -- NULL until first opened
  device_fp TEXT,                           -- fingerprint of first device
  expires_at INTEGER,                       -- NULL = lifetime
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
`);

module.exports = db;
