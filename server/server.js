require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const cookieSession = require('cookie-session');
const { db, seedPhotos } = require('./db');
const {
  verifyExtensionJWT,
  signExternalJWT,
  sendPubSub,
  exchangeCodeForToken,
  getUser,
  isSubscriber,
  sendChatMessage,
  ensureValidChannelToken,
  getUserById
} = require('./twitch');

const app = express();
const PORT = process.env.PORT || 8081;

// Basic CORS
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieSession({
  name: 'sess',
  secret: process.env.SESSION_SECRET || 'devsecret',
  sameSite: 'lax'
}));

function requireAuth(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.replace(/^Bearer\s+/i, '');
    if (!token) throw new Error('missing token');
    req.twitch = verifyExtensionJWT(token);
    req.channel_id = req.twitch.channel_id || req.twitch.channelId || req.twitch.channelId;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'unauthorized' });
  }
}

app.get('/health', (_, res) => res.json({ ok: true }));

// OAuth for broadcaster (config page button uses this)
app.get('/auth/login', (req, res) => {
  const redirect = process.env.OAUTH_REDIRECT_URL || (process.env.SERVER_BASE_URL + '/auth/callback');
  const params = new URLSearchParams({
    client_id: process.env.TWITCH_APP_CLIENT_ID,
    redirect_uri: redirect,
    response_type: 'code',
    scope: 'channel:read:subscriptions',
    force_verify: 'true',
    state: JSON.stringify({ ts: Date.now() })
  });
  res.redirect('https://id.twitch.tv/oauth2/authorize?' + params.toString());
});

app.get('/auth/callback', async (req, res) => {
  try {
    const redirect = process.env.OAUTH_REDIRECT_URL || (process.env.SERVER_BASE_URL + '/auth/callback');
    const { code } = req.query;
    const token = await exchangeCodeForToken(code, redirect);
    const user = await getUser(token.access_token);
    const expires_at = Math.floor(Date.now()/1000) + token.expires_in;
    db.prepare(`INSERT INTO channels (channel_id, broadcaster_login, access_token, refresh_token, expires_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(channel_id) DO UPDATE SET broadcaster_login=excluded.broadcaster_login, access_token=excluded.access_token, refresh_token=excluded.refresh_token, expires_at=excluded.expires_at
    `).run(user.id, user.login, token.access_token, token.refresh_token, expires_at);
    seedPhotos(user.id);
    res.send(`<html><body><h2>Connected as @${user.login}</h2><script>setTimeout(()=>window.close(),1500)</script></body></html>`);
  } catch (e) {
    res.status(500).send('Auth failed: ' + e.message);
  }
});

// Viewer status (subscribed? role?)
app.get('/api/status', requireAuth, async (req, res) => {
  const { channel_id, twitch } = req;
  const userId = twitch.user_id || null; // null if identity not shared
  const role = twitch.role || 'viewer';
  let sub = false;
  if (userId) {
    sub = await isSubscriber(channel_id, userId);
  }
  res.json({ userId, role, isSubscriber: sub });
});

// Photos (server also enforces sub-only on response)
app.get('/api/photos', requireAuth, async (req, res) => {
  const { channel_id, twitch } = req;
  const userId = twitch.user_id || null;
  if (!userId) return res.status(403).json({ error: 'identity_required' });
  const sub = await isSubscriber(channel_id, userId);
  if (!sub) return res.status(403).json({ error: 'sub_only' });
  const rows = db.prepare('SELECT id, url, title, tip_bits_total FROM photos WHERE channel_id=? ORDER BY id ASC').all(channel_id);
  res.json(rows);
});

app.get('/api/comments', requireAuth, (req, res) => {
  const { channel_id } = req;
  const { photoId } = req.query;
  const rows = db.prepare('SELECT id, photo_id, user_id, display_name, message, created_at FROM comments WHERE channel_id=? AND photo_id=? AND hidden=0 ORDER BY id DESC').all(channel_id, photoId);
  res.json(rows);
});

// New: comment + purchase in one verified call (500 Bits per comment per photo)
app.post('/api/comment_with_purchase', requireAuth, (req, res) => {
  try {
    const { channel_id, twitch } = req;
    const userId = twitch.user_id || null;
    const { photoId, message, receipt } = req.body;
    if (!userId) return res.status(403).json({ error: 'identity_required' });
    if (!photoId || !message || !receipt) return res.status(400).json({ error: 'missing_params' });

    const decoded = jwt.verify(receipt, Buffer.from(process.env.EXTENSION_SECRET_B64, 'base64'), { algorithms: ['HS256'] });
    // Twitch receipt payload example differs; we use product.sku or product
    const sku = decoded && decoded.data && decoded.data.product && decoded.data.product.sku ? decoded.data.product.sku : decoded.data && decoded.data.product || 'UNKNOWN';
    const bits = decoded && decoded.data && decoded.data.product && decoded.data.product.cost && decoded.data.product.cost.amount;
    const receiptUserId = decoded && decoded.data && decoded.data.userId;

    if (!receiptUserId || String(receiptUserId) != String(userId)) {
      return res.status(400).json({ error: 'user_mismatch' });
    }
    if (sku !== 'COMMENT_500') {
      return res.status(400).json({ error: 'wrong_sku', expected: 'COMMENT_500', got: sku });
    }
    // Create the comment (one paid comment)
    const now = Math.floor(Date.now()/1000);
    const dn = 'Viewer';
    db.prepare('INSERT INTO comments (channel_id, photo_id, user_id, display_name, message, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(channel_id, photoId, userId, dn, String(message).slice(0, 500), now);
    // Broadcast new comment for realtime refresh
    sendPubSub(channel_id, { type: 'new_comment', photoId });

    res.json({ ok: true });
  } catch (e) {
    console.error('/comment_with_purchase error', e.message);
    res.status(400).json({ error: 'bad_receipt' });
  }
});

// Moderation: hide/show comment (broadcaster only)
app.patch('/api/comment/:id', requireAuth, (req, res) => {
  const { channel_id, twitch } = req;
  if (twitch.role !== 'broadcaster') return res.status(403).json({ error: 'forbidden' });
  const { id } = req.params;
  const { hidden } = req.body;
  db.prepare('UPDATE comments SET hidden=? WHERE id=? AND channel_id=?').run(hidden ? 1 : 0, id, channel_id);
  res.json({ ok: true });
});

// Bits transaction verification for tips only
app.post('/api/transactions/complete', requireAuth, async (req, res) => {
  try {
    const { channel_id } = req;
    const { receipt, photoId } = req.body;
    const decoded = jwt.verify(receipt, Buffer.from(process.env.EXTENSION_SECRET_B64, 'base64'), { algorithms: ['HS256'] });
    const sku = decoded && decoded.data && decoded.data.product && decoded.data.product.sku ? decoded.data.product.sku : decoded.data && decoded.data.product || 'UNKNOWN';
    const userId = decoded && decoded.data && decoded.data.userId;
    if (!userId) return res.status(400).json({ error: 'no_user_in_receipt' });

    if (sku.startsWith('TIP_')) {
      const bits = parseInt(sku.split('_')[1], 10) || 0;
      if (!photoId) return res.status(400).json({ error: 'missing_photoId' });
      db.prepare('INSERT INTO tips (channel_id, photo_id, user_id, bits, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(channel_id, photoId, userId, bits, Math.floor(Date.now()/1000));
      db.prepare('UPDATE photos SET tip_bits_total = tip_bits_total + ? WHERE id=? AND channel_id=?')
        .run(bits, photoId, channel_id);
      sendPubSub(channel_id, { type: 'tip_update', photoId, bits });
      // Chat announce (best-effort)
      try {
        const row = await ensureValidChannelToken(channel_id);
        let display = 'Someone';
        if (row && row.access_token) {
          const u = await getUserById(row.access_token, userId);
          if (u && (u.display_name || u.login)) display = u.display_name || u.login;
        }
        const photo = db.prepare('SELECT title FROM photos WHERE id=? AND channel_id=?').get(photoId, channel_id) || {};
        const title = photo.title ? ` on "${photo.title}"` : '';
        await sendChatMessage(channel_id, `⭐ ${display} tipped ${bits} Bits${title}`);
      } catch (e) { console.warn('chat announce failed', e.message); }
      return res.json({ ok: true });
    }
    return res.status(400).json({ error: 'unknown_sku', sku, decoded });
  } catch (e) {
    console.error('/transactions/complete error', e.message);
    res.status(400).json({ error: 'bad_receipt' });
  }
});

app.get('/config-done', (_, res) => {
  res.send('<html><body style="font-family:ui-sans-serif"><h2>Connected!</h2><p>You can close this window and return to your Twitch Extension config.</p></body></html>');
});

app.listen(PORT, () => console.log('EBS listening on', PORT));
