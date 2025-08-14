const jwt = require('jsonwebtoken');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const { db } = require('./db');
const BASE = 'https://api.twitch.tv/helix';

function extSecret() {
  if (!process.env.EXTENSION_SECRET_B64) throw new Error('EXTENSION_SECRET_B64 not set');
  return Buffer.from(process.env.EXTENSION_SECRET_B64, 'base64');
}

function verifyExtensionJWT(token) {
  return jwt.verify(token, extSecret(), { algorithms: ['HS256'] });
}

function signExternalJWT(ownerUserId, expSeconds = 60) {
  const payload = {
    exp: Math.floor(Date.now()/1000) + expSeconds,
    user_id: String(ownerUserId || '0'),
    role: 'external'
  };
  return jwt.sign(payload, extSecret(), { algorithm: 'HS256' });
}

async function sendPubSub(broadcasterId, messageObj, targets=['broadcast']) {
  const token = signExternalJWT(process.env.EXTENSION_OWNER_USER_ID || '0');
  const res = await fetch(`${BASE}/extensions/pubsub`, {
    method: 'POST',
    headers: {
      'Client-Id': process.env.EXTENSION_CLIENT_ID,
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      broadcaster_id: String(broadcasterId),
      message: JSON.stringify(messageObj),
      target: targets
    })
  });
  if (!res.ok) {
    const t = await res.text();
    console.error('PubSub error', res.status, t);
  }
}

async function sendChatMessage(broadcasterId, text) {
  // Requires Chat Capability enabled for the extension.
  try {
    const token = signExternalJWT(process.env.EXTENSION_OWNER_USER_ID || '0');
    const url = new URL(`${BASE}/extensions/chat`);
    url.searchParams.set('broadcaster_id', String(broadcasterId));
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Client-Id': process.env.EXTENSION_CLIENT_ID,
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text: String(text).slice(0, 280) })
    });
    if (!res.ok) {
      const t = await res.text();
      console.error('Chat send error', res.status, t);
    }
  } catch (e) {
    console.error('sendChatMessage exception', e.message);
  }
}

async function exchangeCodeForToken(code, redirectUri) {
  const params = new URLSearchParams({
    client_id: process.env.TWITCH_APP_CLIENT_ID,
    client_secret: process.env.TWITCH_APP_CLIENT_SECRET,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code
  });
  const res = await fetch('https://id.twitch.tv/oauth2/token', { method: 'POST', body: params });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function refreshToken(refresh_token) {
  const params = new URLSearchParams({
    client_id: process.env.TWITCH_APP_CLIENT_ID,
    client_secret: process.env.TWITCH_APP_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token
  });
  const res = await fetch('https://id.twitch.tv/oauth2/token', { method: 'POST', body: params });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function helixGet(path, accessToken, searchParams={}) {
  const url = new URL(`${BASE}/${path}`);
  Object.entries(searchParams).forEach(([k,v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: {
      'Client-Id': process.env.TWITCH_APP_CLIENT_ID,
      'Authorization': `Bearer ${accessToken}`
    }
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function getUser(accessToken) {
  const data = await helixGet('users', accessToken);
  return data.data && data.data[0];
}

async function getUserById(accessToken, id) {
  const data = await helixGet('users', accessToken, { id: String(id) });
  return data.data && data.data[0];
}

async function ensureValidChannelToken(channel_id) {
  const row = db.prepare('SELECT * FROM channels WHERE channel_id = ?').get(channel_id);
  if (!row) return null;
  if (row.expires_at && row.expires_at > Math.floor(Date.now()/1000)+60) return row;
  try {
    const refreshed = await refreshToken(row.refresh_token);
    const expires_at = Math.floor(Date.now()/1000) + refreshed.expires_in;
    db.prepare('UPDATE channels SET access_token=?, refresh_token=?, expires_at=? WHERE channel_id=?')
      .run(refreshed.access_token, refreshed.refresh_token, expires_at, channel_id);
    return db.prepare('SELECT * FROM channels WHERE channel_id = ?').get(channel_id);
  } catch (e) {
    console.error('Failed to refresh broadcaster token', e.message);
    return row; // may be expired
  }
}

async function isSubscriber(channel_id, user_id) {
  const row = await ensureValidChannelToken(channel_id);
  if (!row || !row.access_token) return false;
  try {
    const data = await helixGet('subscriptions', row.access_token, { broadcaster_id: channel_id, user_id });
    return (data.data || []).length > 0;
  } catch (e) {
    console.warn('isSubscriber error (treating as false):', e.message);
    return false;
  }
}

module.exports = {
  verifyExtensionJWT,
  signExternalJWT,
  sendPubSub,
  sendChatMessage,
  exchangeCodeForToken,
  getUser,
  getUserById,
  isSubscriber,
  ensureValidChannelToken
};
