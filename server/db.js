const Database = require('better-sqlite3');
const path = require('path');

const dbFile = process.env.DATABASE_FILE || path.join(__dirname, 'data.db');
const db = new Database(dbFile);

// Schema
db.exec(`
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS channels (
  channel_id TEXT PRIMARY KEY,
  broadcaster_login TEXT,
  access_token TEXT,
  refresh_token TEXT,
  expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  tip_bits_total INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  photo_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  display_name TEXT,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  hidden INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS comment_unlocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  unlocked_at INTEGER NOT NULL,
  UNIQUE(channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS tips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  photo_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  bits INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
`);

// Seed helper
function seedPhotos(channel_id) {
  const exists = db.prepare('SELECT COUNT(*) AS c FROM photos WHERE channel_id = ?').get(channel_id);
  if (exists.c === 0) {
    const stmt = db.prepare('INSERT INTO photos (channel_id, url, title) VALUES (?, ?, ?)');
    const demo = [
      ['https://images.unsplash.com/photo-1529626455594-4ff0802cfb7e?q=80&w=1200&auto=format&fit=crop', 'Sunlit Portrait'],
      ['https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?q=80&w=1200&auto=format&fit=crop', 'Blue Hour City'],
      ['https://images.unsplash.com/photo-1469474968028-56623f02e42e?q=80&w=1200&auto=format&fit=crop', 'Forest Path'],
      ['https://images.unsplash.com/photo-1504196606672-aef5c9cefc92?q=80&w=1200&auto=format&fit=crop', 'Neon Night']
    ];
    demo.forEach(([url, title]) => stmt.run(channel_id, url, title));
  }
}

module.exports = { db, seedPhotos };
