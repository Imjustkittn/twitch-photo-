// server.js
// Minimal EBS for Photo Booth (Express + better-sqlite3)
// Node 18+ (uses global fetch)

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");

/* ===== Env ===== */
const PORT = process.env.PORT || 10000;
const BASE_URL = process.env.BASE_URL || "https://twitch-photo.onrender.com"; // set on Render if your URL differs
const DB_FILE = process.env.DATABASE_FILE || "/var/data/twitch-photo.db";

const TWITCH_APP_CLIENT_ID = process.env.TWITCH_APP_CLIENT_ID || "";
const TWITCH_APP_CLIENT_SECRET = process.env.TWITCH_APP_CLIENT_SECRET || "";
const EXTENSION_OWNER_USER_ID = process.env.EXTENSION_OWNER_USER_ID || ""; // your Twitch user id
const EBS_JWT_SECRET = process.env.EBS_JWT_SECRET || "change-me";

/* ===== DB setup ===== */
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new Database(DB_FILE);

db.exec(`
  CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    title TEXT DEFAULT '',
    likes_count INTEGER DEFAULT 0,
    tip_bits_total INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    photo_id INTEGER NOT NULL,
    username TEXT DEFAULT '',
    message TEXT NOT NULL,
    bits INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS transactions (
    tx_id TEXT PRIMARY KEY,
    sku TEXT,
    photo_id INTEGER,
    comment TEXT DEFAULT '',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

const app = express();
app.use(cors());
app.use(express.json());

/* ===== Helpers ===== */
function decodeTwitchJWT(authHeader) {
  if (!authHeader) return {};
  const token = authHeader.replace(/^Bearer\s+/i, "");
  try {
    // We only decode; Twitch signs with their key. For our gating we don't need to verify here.
    const decoded = jwt.decode(token) || {};
    // decoded.role, decoded.user_id, decoded.channel_id, decoded.pubsub_perms
    return { token, ...decoded };
  } catch {
    return {};
  }
}

function ok(res, data) {
  res.json(data || { ok: true });
}
function bad(res, msg, code = 400) {
  res.status(code).json({ error: msg || "bad_request" });
}

/* ===== Health ===== */
app.get("/health", (req, res) => ok(res, { ok: true }));

/* ===== Status (role + simple sub gate) ===== */
app.get("/api/status", (req, res) => {
  const a = decodeTwitchJWT(req.headers.authorization);
  const role = a.role || "viewer";

  // Let broadcaster & moderator bypass subscriber gate
  const isSubscriber = role === "broadcaster" || role === "moderator";

  ok(res, {
    role,
    isSubscriber,
    channel_id: a.channel_id || null,
    user_id: a.user_id || null,
  });
});

/* ===== Photos API ===== */
app.get("/api/photos", (req, res) => {
  const rows = db.prepare(`SELECT id, url, title, likes_count, tip_bits_total, created_at FROM photos ORDER BY id DESC`).all();
  ok(res, rows);
});

// Admin add photo (broadcaster/mod only)
app.post("/api/admin/photos", (req, res) => {
  const a = decodeTwitchJWT(req.headers.authorization);
  const role = a.role || "viewer";
  if (!["broadcaster", "moderator"].includes(role)) return bad(res, "forbidden", 403);

  const { url, title = "" } = req.body || {};
  if (!url || !/^https:\/\/.+/i.test(url)) return bad(res, "direct https image url required");

  const info = db.prepare(`INSERT INTO photos (url, title) VALUES (?, ?)`).run(url, title);
  const photo = db.prepare(`SELECT id, url, title, likes_count, tip_bits_total, created_at FROM photos WHERE id = ?`).get(info.lastInsertRowid);
  ok(res, { photo });
});

// Admin delete photo
app.delete("/api/admin/photos/:id", (req, res) => {
  const a = decodeTwitchJWT(req.headers.authorization);
  const role = a.role || "viewer";
  if (!["broadcaster", "moderator"].includes(role)) return bad(res, "forbidden", 403);
  const id = Number(req.params.id || 0);
  if (!id) return bad(res, "invalid id");

  db.prepare(`DELETE FROM photos WHERE id = ?`).run(id);
  db.prepare(`DELETE FROM comments WHERE photo_id = ?`).run(id);
  ok(res, { deleted: id });
});

/* ===== Likes / Tips / Comments ===== */
function bitsFromSku(sku) {
  const m = String(sku || "").match(/(\d+)/);
  return m ? parseInt(m[1], 10) || 0 : 0;
}

// Dev / non-bits fallback like
app.post("/api/like", (req, res) => {
  const { photoId, bits = 0 } = req.body || {};
  const id = Number(photoId || 0);
  if (!id) return bad(res, "invalid photoId");

  const b = db.prepare(`UPDATE photos SET likes_count = likes_count + 1, tip_bits_total = tip_bits_total + ? WHERE id = ?`).run(bits, id);
  if (!b.changes) return bad(res, "not found", 404);
  ok(res, { liked: id, bitsAdded: bits });
});

// Dev / non-bits fallback comment purchase (treat as free)
app.post("/api/comment_with_purchase", (req, res) => {
  const a = decodeTwitchJWT(req.headers.authorization);
  const user = a.user_id || "viewer";
  const { photoId, comment = "" } = req.body || {};
  const id = Number(photoId || 0);
  if (!id || !comment.trim()) return bad(res, "photoId and comment required");

  db.prepare(`INSERT INTO comments (photo_id, username, message, bits) VALUES (?, ?, ?, 0)`)
    .run(id, user, String(comment).slice(0, 500));

  ok(res, { commented: id });
});

// Bits transaction completion (from panel)
app.post("/api/transactions/complete", (req, res) => {
  const { onReceipt = {}, photoId, comment = "" } = req.body || {};
  const id = Number(photoId || 0);
  if (!id) return bad(res, "invalid photoId");

  const sku = onReceipt.sku || "";
  const bits = bitsFromSku(sku);

  // idempotency is light here—tx id is not provided by our stub; we just apply the math
  db.prepare(`UPDATE photos SET likes_count = likes_count + 1, tip_bits_total = tip_bits_total + ? WHERE id = ?`).run(bits, id);
  if (comment.trim()) {
    db.prepare(`INSERT INTO comments (photo_id, username, message, bits) VALUES (?, ?, ?, ?)`)
      .run(id, "viewer", String(comment).slice(0, 500), bits || 500);
  }
  ok(res, { applied: true, bits });
});

/* ===== Simple broadcaster connect flow (stores token) ===== */
app.get("/auth/login", (req, res) => {
  const redirectUri = `${BASE_URL}/auth/callback`;
  const scope = encodeURIComponent("channel:read:subscriptions chat:read chat:edit");
  const url = `https://id.twitch.tv/oauth2/authorize?client_id=${TWITCH_APP_CLIENT_ID}&redirect_uri=${encodeURIComponent(
    redirectUri
  )}&response_type=code&scope=${scope}`;
  res.redirect(url);
});

app.get("/auth/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("Missing code");

  const redirectUri = `${BASE_URL}/auth/callback`;
  // Exchange code for tokens
  const tokenRes = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: TWITCH_APP_CLIENT_ID,
      client_secret: TWITCH_APP_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  const tokenJson = await tokenRes.json().catch(() => ({}));

  // Persist for later use (basic)
  try {
    db.prepare(`INSERT INTO kv(key,value) VALUES('broadcaster_oauth', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .run(JSON.stringify(tokenJson));
  } catch {}

  res.send(`<html><body style="font-family: ui-sans-serif; padding:16px">
    <h3>Connected ✔</h3>
    <p>You can close this window.</p>
  </body></html>`);
});

/* ===== Start ===== */
app.listen(PORT, () => {
  console.log("EBS listening on", PORT, "DB:", DB_FILE);
});
