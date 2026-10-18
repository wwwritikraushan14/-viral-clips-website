// Restore video records for files already on the volume.
// Run AFTER redeploy, in the Railway console:  node restore-videos.js
// (upload this file via the console's Files panel first)
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DB = '/app/data/viral-clips.db';
const DIR = '/app/data/uploads';

// known videos matched by file size (MB) -> original title
const KNOWN = [
  [19.6,  'Pink vagina MMS \u{1F4A6}\u{1F495}.mp4'],
  [5.0,   'Shubhashree sahu pink girl viral MMS \u{1F975}.mp4'],
  [12.8,  'Instagram girl rachel sharma viral video\u{1F4A6}\u{1F4A6}.mp4'],
  [4.8,   'bhojpuri actress akshara singh viral video\u{1F4A6}\u{1F975}\u{1F4A6}\u{1F975}.mp4'],
  [7.2,   'Bhojpuri singer shilpi raj mms.mp4'],
  [12.4,  'bhojpuri-actress-priyanka pandit \u{1F4A6}\u{1F4A6}\u{1F975}.mp4'],
  [37.8,  'Anjali Arora \u{1F975}\u{1F4A6}\u{1F4A6}'],
  [136.6, '19 minute viral girl \u{1F975}\u{1F975}'],
];

const db = new DatabaseSync(DB);
db.exec(`CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);`);

const existing = db.prepare('SELECT COUNT(*) AS n FROM videos').get().n;
if (existing > 0) {
  console.log('videos table already has ' + existing + ' records — nothing to do.');
  process.exit(0);
}

const ins = db.prepare(
  'INSERT INTO videos (title, filename, mime, size, created_at) VALUES (?, ?, ?, ?, ?)'
);
let restored = 0;
for (const f of fs.readdirSync(DIR)) {
  if (!f.toLowerCase().endsWith('.mp4')) continue;
  const fp = path.join(DIR, f);
  const st = fs.statSync(fp);
  const mb = st.size / 1048576;
  let best = KNOWN[0], bd = 1e9;
  for (const k of KNOWN) {
    const d = Math.abs(k[0] - mb);
    if (d < bd) { bd = d; best = k; }
  }
  if (bd > 1.0) {
    console.log('SKIP (no title match, ' + mb.toFixed(1) + ' MB): ' + f);
    continue;
  }
  ins.run(best[1], f, 'video/mp4', st.size, Date.now());
  restored++;
  console.log('restored: ' + best[1]);
}
console.log('done — ' + restored + ' videos restored.');
