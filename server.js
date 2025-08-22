// server.js - Twitch Photo EBS (clean build, single multer import)

const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const multer = require("multer"); // <-- only once

// ---------- Config ----------
const PORT = process.env.PORT || 10000;
const BASE_URL = process.env.BASE_URL || ""; // e.g. https://twitch-photo.onrender.com
const DATA_DIR = process.env.DATA_DIR || "/var/data";
const DB_FILE =
  process.env.DATABASE_FILE ||
  path.join(DATA_DIR, "twitch-photo.db");
const UPLOAD_DIR =
  process.env.UPLOAD_DIR ||
  path.join(DATA_DIR, "uploads");

// Ensure folders exist (works with/without persistent disk)
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- DB (sqlite3) ----------
const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database(DB_FILE);

db.serialize(() => {
  db.run(
    `CREATE TABLE IF NOT EXISTS photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      local_path TEXT,
      title TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );
  db.run(
    `CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,          -- 'like' | 'comment'
      photo_id INTEGER NOT NULL,
      user_name TEXT,
      amount INTEGER DEFAULT 0,    -- bits mapped to likes
      comment TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );
});

// ---------- App ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// Serve uploaded files if you keep them locally
app.use("/uploads", express.static(UPLOAD_DIR));

// Multer storage (for file uploads from config UI)
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || ".png") || ".png";
    const name = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
    cb(null, name);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// ---------- Health / Status ----------
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    baseUrl: BASE_URL,
    dbPath: DB_FILE,
    uploads: UPLOAD_DIR,
    now: new Date().toISOString(),
  });
});

app.get("/api/status", (_req, res) => {
  db.get(`SELECT COUNT(*) AS c FROM photos`, (err, row) => {
    res.json({
      ok: !err,
      photos: row ? row.c : 0,
      baseUrl: BASE_URL,
    });
  });
});

// ---------- Photos API ----------

// List photos newest first
app.get("/api/photos", (_req, res) => {
  db.all(
    `SELECT id, url, title, created_at FROM photos ORDER BY created_at DESC`,
    (err, rows) => {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      res.json({ ok: true, photos: rows });
    }
  );
});

// Add via URL
app.post("/api/photos/url", (req, res) => {
  const { url, title = "" } = req.body || {};
  if (!url) return res.status(400).json({ ok: false, error: "Missing url" });
  db.run(
    `INSERT INTO photos (url, title) VALUES (?, ?)`,
    [url, title],
    function (err) {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      res.json({ ok: true, id: this.lastID });
    }
  );
});

// Upload a file (PNG/JPG/GIF)
app.post("/api/photos/upload", upload.single("file"), (req, res) => {
  if (!req.file)
    return res.status(400).json({ ok: false, error: "No file" });

  const localPath = `/uploads/${req.file.filename}`;
  const { title = "" } = req.body || {};

  db.run(
    `INSERT INTO photos (url, local_path, title) VALUES (?, ?, ?)`,
    [BASE_URL + localPath, localPath, title],
    function (err) {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      res.json({ ok: true, id: this.lastID, url: BASE_URL + localPath });
    }
  );
});

// Delete a photo
app.delete("/api/photos/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ ok: false, error: "Bad id" });

  db.get(`SELECT local_path FROM photos WHERE id = ?`, [id], (err, row) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });

    db.run(`DELETE FROM photos WHERE id = ?`, [id], (err2) => {
      if (err2) return res.status(500).json({ ok: false, error: err2.message });

      // Best-effort remove local file
      if (row && row.local_path) {
        const abs = path.join(UPLOAD_DIR, path.basename(row.local_path));
        fs.promises.unlink(abs).catch(() => {});
      }
      res.json({ ok: true });
    });
  });
});

// ---------- Likes / Comments (dev-friendly) ----------

// tip/like (maps bits to likes on the server side)
app.post("/api/tip", (req, res) => {
  const { photoId, userName = "viewer", bits = 0 } = req.body || {};
  if (!photoId) return res.status(400).json({ ok: false, error: "photoId required" });

  db.run(
    `INSERT INTO events (type, photo_id, user_name, amount) VALUES ('like', ?, ?, ?)`,
    [photoId, userName, bits],
    function (err) {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      res.json({ ok: true, id: this.lastID });
    }
  );
});

// comment (500 bits gate is enforced in the panel UI in Hosted Test)
app.post("/api/comment", (req, res) => {
  const { photoId, userName = "viewer", comment = "" } = req.body || {};
  if (!photoId || !comment)
    return res.status(400).json({ ok: false, error: "photoId and comment required" });

  db.run(
    `INSERT INTO events (type, photo_id, user_name, comment) VALUES ('comment', ?, ?, ?)`,
    [photoId, userName, comment],
    function (err) {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      res.json({ ok: true, id: this.lastID });
    }
  );
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log("EBS listening on", PORT);
  console.log("DB:", DB_FILE);
  console.log("Uploads:", UPLOAD_DIR);
});
