// server/server.js
// Photo Gallery Twitch Extension — EBS (Express)

require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const cors = require('cors');

// Uses better-sqlite3 via ./db (already in your project)
const { db, seedPhotos } = require('./db');

// ---------------- Env ----------------
const PORT = process.env.PORT || 10000;

const EXT_CLIENT_ID     = process.env.EXTENSION_CLIENT_ID;      // Twitch Extension client id
const EXT_SECRET_B64    = process.env.EXTENSION_SECRET_B64;     // base64-encoded shared secret
const EBS_JWT_SECRET    = process.env.EBS_JWT_SECRET || 'dev-ebs-secret'; // (not critical here)

const APP_CLIENT_ID     = process.env.TWITCH_APP_CLIENT_ID;     // Twitch OAuth app (Helix)
const APP_CLIENT_SECRET = process.env.TWITCH_APP_CLIENT_SECRET;
const OAUTH_REDIRECT_URL =
  process.env.OAUTH_REDIRECT_URL || process.env.REDIRECT_URI ||
  (process.env.SERVER_BASE_URL ? `${process.env.SERVER_BASE_URL}/auth/callback` : '');

if (!EXT_CLIENT_ID || !EXT_SECRET_B64) {
  console.warn('[WARN] Missing EXTENSION_CLIENT_ID or EXTENSION_SECRET_B64');
}
if (!APP_CLIENT_ID || !APP_CLIENT_SECRET || !OAUTH_REDIRECT_URL) {
  console.warn('[WARN] Missing TWITCH_APP_CLIENT_ID / TWITCH_APP_CLIENT_SECRET / OAUTH_REDIRECT_URL');
}

// ---------------- App & CORS ----------------
const app = express();
app.use(express.json());

// Allow Twitch extension origins (override with CORS_ORIGINS=CSV)
const DEFAULT_ORIGINS = [
  'https://extension-files.twitch.tv',
  'https://*.ext-twitch.tv',
];
const allowList = (process.env.CORS_ORIGINS || DEFAULT_ORIGINS.join(','))
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // allow health checks, curl, etc.
    const ok = allowList.some(pat => {
      if (pat.includes('*')) {
        const re = new RegExp('^' + pat.replace(/\./g,'\\.').replace(/\*/g,'.*') + '$');
        return re.test(origin);
      }
      return origin === pat;
    });
    cb(null, ok);
  },
}));

// ---------------- DB bootstrap ----------------
try { db.exec("ALTER TABLE photos ADD COLUMN likes_count INTEGER DEFAULT 0"); } catch (e) {}
db.exec(`CREATE TABLE IF NOT EXISTS channel_tokens (
  channel_id   TEXT PRIMARY KEY,
  access_token TEXT,
  refresh_token TEXT,
  expires_at   INTEGER
);`);

// ---------------- Helpers ----------------
const EXT_SECRET = Buffer.from(EXT_SECRET_B64 || '', 'base64');

function verifyExtensionJWT(bearer) {
  if (!bearer) throw new Error('missing_auth');
  const parts = bearer.split(' ');
  const token = parts.length === 2 ? parts[1] : bearer;
  return jwt.verify(token, EXT_SECRET, { algorithms: ['HS256'] });
}

async function tokenExchange(code) {
  const url = new URL('https://id.twitch.tv/oauth2/token');
  url.searchParams.set('client_id', APP_CLIENT_ID);
  url.searchParams.set('client_secret', APP_CLIENT_SECRET);
  url.searchParams.set('code', code);
  url.searchParams.set('grant_type', 'authorization_code');
  url.searchParams.set('redirect_uri', OAUTH_REDIRECT_URL);

  const r = await fetch(url, { method: 'POST' });
  if (!r.ok) throw new Error(`/oauth2/token failed ${r.status}`);
  return r.json(); // { access_token, refresh_token, expires_in, scope[], token_type }
}

async function refreshToken(refresh_token) {
  const url = new URL('https://id.twitch.tv/oauth2/token');
  url.searchParams.set('client_id', APP_CLIENT_ID);
  url.searchParams.set('client_secret', APP_CLIENT_SECRET);
  url.searchParams.set('grant_type', 'refresh_token');
  url.searchParams.set('refresh_token', refresh_token);

  const r = await fetch(url, { method: 'POST' });
  if (!r.ok) throw new Error(`/oauth2/token refresh failed ${r.status}`);
  return r.json();
}

async function helixGet(path, access_token, params = {}) {
  const url = new URL('https://api.twitch.tv/helix' + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url, {
    headers: { 'Client-Id': APP_CLIENT_ID, 'Authorization': `Bearer ${access_token}` }
  });
  if (!r.ok) throw new Error(`Helix ${path} ${r.status}`);
  return r.json();
}

async function helixPost(path, access_token, body) {
  const url = new URL('https://api.twitch.tv/helix' + path);
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Client-Id': APP_CLIENT_ID,
      'Authorization': `Bearer ${access_token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Helix POST ${path} ${r.status}: ${t}`);
  }
  return r.json();
}

function getChannelTokenRow(channel_id) {
  return db.prepare('SELECT * FROM channel_tokens WHERE channel_id = ?').get(channel_id);
}

function saveChannelToken(channel_id, access_token, refresh_token, expires_in) {
  const expires_at = Math.floor(Date.now() / 1000) + (Number(expires_in) || 0) - 30;
  db.prepare(`
    INSERT INTO channel_tokens(channel_id,access_token,refresh_token,expires_at)
    VALUES(?,?,?,?)
    ON CONFLICT(channel_id) DO UPDATE SET access_token=excluded.access_token, refresh_token=excluded.refresh_token, expires_at=excluded.expires_at
  `).run(channel_id, access_token, refresh_token || null, expires_at);
}

async function ensureValidChannelToken(channel_id) {
  let row = getChannelTokenRow(channel_id);
  if (row && row.access_token && row.expires_at > Math.floor(Date.now()/1000)) return row;

  if (row && row.refresh_token) {
    try {
      const t = await refreshToken(row.refresh_token);
      saveChannelToken(channel_id, t.access_token, t.refresh_token || row.refresh_token, t.expires_in || 3600);
      return getChannelTokenRow(channel_id);
    } catch (e) {
      console.warn('[refreshToken] failed:', e.message);
    }
  }
  throw new Error('no_channel_token');
}

async function getUserById(access_token, user_id) {
  const j = await helixGet('/users', access_token, { id: user_id });
  return (j.data && j.data[0]) || null;
}

async function isSubscriber(channel_id, user_id) {
  const row = await ensureValidChannelToken(channel_id); // needs channel:read:subscriptions
  const j = await helixGet('/subscriptions', row.access_token, { broadcaster_id: channel_id, user_id });
  return (j.data && j.data.length > 0);
}

async function sendChatMessage(channel_id, message) {
  const row = await ensureValidChannelToken(channel_id); // needs user:write:chat
  await helixPost('/chat/messages', row.access_token, {
    broadcaster_id: channel_id,
    sender_id: channel_id,
    message
  });
}

// ---------------- Middleware ----------------
function requireAuth(req, res, next) {
  try {
    const auth = req.headers['authorization'];
    const p = verifyExtensionJWT(auth);
    req.channel_id = p.channel_id;
    req.twitch = {
      user_id: p.user_id || null,
      opaque_user_id: p.opaque_user_id || null,
      role: p.role || 'viewer'
    };
    next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
}
function requireJson(req, res, next) {
  if (req.is('application/json')) return next();
  res.status(415).json({ error: 'content_type_json_required' });
}
const requireBroadcaster = (req, res, next) => {
  const role = (req.twitch && req.twitch.role) || 'viewer';
  if (role !== 'broadcaster' && role !== 'moderator') return res.status(403).json({ error: 'forbidden' });
  next();
};

// ---------------- Routes ----------------
app.get('/health', (req, res) => res.json({ ok: true }));

// --- OAuth connect (Configure view) ---
app.get('/auth/login', (req, res) => {
  if (!APP_CLIENT_ID || !OAUTH_REDIRECT_URL) {
    return res.status(500).send('Server missing app OAuth env vars.');
  }
  const url = new URL('https://id.twitch.tv/oauth2/authorize');
  url.searchParams.set('client_id', APP_CLIENT_ID);
  url.searchParams.set('redirect_uri', OAUTH_REDIRECT_URL);
  url.searchParams.set('response_type', 'code');
  // Scopes we need: read subs (gating) + send chat (announce tips)
  url.searchParams.set('scope', 'channel:read:subscriptions user:write:chat');
  res.redirect(url.toString());
});

app.get('/auth/callback', async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send('Missing code');
    const t = await tokenExchange(code);
    const u = await helixGet('/users', t.access_token);
    const me = (u.data && u.data[0]) || null;
    if (!me) throw new Error('user_lookup_failed');

    const channel_id = String(me.id);
    saveChannelToken(channel_id, t.access_token, t.refresh_token, t.expires_in || 3600);
    try { seedPhotos(channel_id); } catch {}

    res.send(`<html><body style="background:#0f0f10;color:#eee;font:14px ui-sans-serif">
      <p>Connected as <b>@${me.display_name || me.login}</b> (channel ${channel_id}).</p>
      <script>setTimeout(()=>window.close(), 1200)</script>
    </body></html>`);
  } catch (e) {
    console.error('/auth/callback error', e);
    res.status(500).send('Auth failed. ' + e.message);
  }
});

// --- Products so panel knows SKUs (optional for dev) ---
app.get('/api/products', (req, res) => {
  res.json({ products: [
    { sku: 'TIP_100',     displayName: 'Tip 100',       costBits: 100 },
    { sku: 'TIP_500',     displayName: 'Tip 500',       costBits: 500 },
    { sku: 'TIP_1000',    displayName: 'Tip 1000',      costBits: 1000 },
    { sku: 'COMMENT_500', displayName: 'Comment (500)', costBits: 500 },
  ]});
});

// --- Status (sub gate; broadcaster/mod bypass while testing) ---
app.get('/api/status', requireAuth, async (req, res) => {
  const { channel_id, twitch } = req;
  const userId = twitch.user_id || null;
  const role = twitch.role || 'viewer';
  let isSub = false;
  try {
    if (role === 'broadcaster' || role === 'moderator') {
      isSub = true; // dev convenience
    } else if (userId) {
      isSub = await isSubscriber(channel_id, userId);
    }
  } catch {}
  res.json({ userId, role, isSubscriber: isSub });
});

// --- Photos feed (panel) ---
app.get('/api/photos', requireAuth, async (req, res) => {
  const { channel_id, twitch } = req;
  const role = twitch.role || 'viewer';
  const userId = twitch.user_id || null;

  if (role !== 'broadcaster' && role !== 'moderator') {
    if (!userId) return res.status(403).json({ error: 'identity_required' });
    const sub = await isSubscriber(channel_id, userId).catch(() => false);
    if (!sub) return res.status(403).json({ error: 'sub_only' });
  }

  const rows = db.prepare(
    'SELECT id, url, title, tip_bits_total, likes_count FROM photos WHERE channel_id = ? ORDER BY id DESC'
  ).all(channel_id);
  res.json({ photos: rows });
});

// --- Admin: add/delete photos (Configure) ---
app.post('/api/admin/photos', requireAuth, requireJson, requireBroadcaster, async (req, res) => {
  const { channel_id } = req;
  let { url, title } = req.body || {};
  if (!url || !/^https:\/\/.+/i.test(url)) {
    return res.status(400).json({ error: 'Please provide a direct https image URL.' });
  }
  // Best-effort HEAD to check content-type image/*
  try {
    const head = await fetch(url, { method: 'HEAD' });
    const ctype = (head.headers.get('content-type') || '').toLowerCase();
    if (ctype && !ctype.startsWith('image/')) {
      return res.status(400).json({ error: 'URL does not point to an image.' });
    }
  } catch {}
  title = title || '';
  const info = db.prepare('INSERT INTO photos (channel_id, url, title) VALUES (?, ?, ?)').run(channel_id, url, title);
  res.json({ ok: true, photo: { id: info.lastInsertRowid, url, title, tip_bits_total: 0, likes_count: 0 } });
});

app.delete('/api/admin/photos/:id', requireAuth, requireBroadcaster, (req, res) => {
  const { channel_id } = req;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad_id' });
  db.prepare('DELETE FROM photos WHERE id = ? AND channel_id = ?').run(id, channel_id);
  db.prepare('UPDATE comments SET hidden=1 WHERE photo_id = ? AND channel_id = ?').run(id, channel_id);
  res.json({ ok: true });
});

// --- Comment moderation list (Configure) ---
app.get('/api/comments', requireAuth, requireBroadcaster, (req, res) => {
  const { channel_id } = req;
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
  const rows = db.prepare(
    'SELECT id, photo_id, user_id, display_name, message, created_at FROM comments WHERE channel_id = ? AND hidden = 0 ORDER BY id DESC LIMIT ?'
  ).all(channel_id, limit);
  res.json(rows);
});

app.delete('/api/admin/comments/:id', requireAuth, requireBroadcaster, (req, res) => {
  const { channel_id } = req;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad_id' });
  db.prepare('UPDATE comments SET hidden=1 WHERE id = ? AND channel_id = ?').run(id, channel_id);
  res.json({ ok: true });
});

// --- Dev like (free for broadcaster/mod OR DEV_FREEBITS=1). Also announces in chat. ---
app.post('/api/like', requireAuth, requireJson, async (req, res) => {
  const DEV = process.env.DEV_FREEBITS === '1';
  const { channel_id, twitch } = req;
  const role = twitch.role || 'viewer';
  if (!DEV && role !== 'broadcaster' && role !== 'moderator') {
    return res.status(403).json({ error: 'bits_required' });
  }
  const { photoId, bits } = req.body || {};
  if (!photoId) return res.status(400).json({ error: 'missing_photo' });

  const inc = Number(bits) || 0;
  db.prepare('UPDATE photos SET likes_count = likes_count + 1, tip_bits_total = tip_bits_total + ? WHERE id = ? AND channel_id = ?')
    .run(inc, Number(photoId), channel_id);

  try {
    const row = await ensureValidChannelToken(channel_id);
    let who = 'Someone';
    if (row && row.access_token && twitch.user_id) {
      const u = await getUserById(row.access_token, twitch.user_id).catch(() => null);
      if (u && (u.display_name || u.login)) who = u.display_name || u.login;
    }
    await sendChatMessage(channel_id, `⭐ ${who} tipped a photo!`);
  } catch (e) { console.warn('chat announce failed:', e.message); }
  res.json({ ok: true });
});

// --- Bits receipt (TIP_xxx adds like+bits; COMMENT_500 inserts comment) ---
app.post('/api/transactions/complete', requireAuth, requireJson, async (req, res) => {
  try {
    const { channel_id, twitch } = req;
    const { onReceipt, photoId, comment }
