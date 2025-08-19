// panel.js — Twitch Photo Panel (full file)
//
// Requirements:
// - index.html includes: <div id="app"></div>
// - index.html loads ebs-config.js BEFORE this file and sets window.EBS_BASE
// - Capabilities: connect-src includes your EBS, img-src includes your image CDNs
//
// Features:
// - Sub gate (broadcaster/mod bypass)
// - Photo feed with title, like count, tip bits total
// - Tip buttons (100/500/1000 bits) via Bits in Extensions
// - Comment for 500 bits (prompt UI)
// - Dev fallback like (no Bits) for broadcaster/mod or DEV_FREEBITS=1 on EBS
// - Robust API shape handling ({photos:[...]})

(() => {
  const $ = (s, d = document) => d.querySelector(s);
  const BASE = window.EBS_BASE || 'https://twitch-photo.onrender.com';

  const app = $('#app') || (() => {
    const d = document.createElement('div');
    d.id = 'app';
    document.body.appendChild(d);
    return d;
  })();

  let token = null;
  let role = 'viewer';
  let channelId = null;
  let isSubscriber = false;
  let products = [];
  let pending = { sku: null, photoId: null, comment: '' };

  // ---------- helpers ----------
  function api(path, opts = {}) {
    const headers = Object.assign(
      { 'Authorization': 'Bearer ' + (token || '') },
      opts.headers || {}
    );
    return fetch(BASE + path, Object.assign({ headers }, opts)).then(async r => {
      const ct = r.headers.get('content-type') || '';
      const body = ct.includes('application/json') ? await r.json().catch(() => ({})) : await r.text();
      if (!r.ok) throw (typeof body === 'object' ? body : { error: body || r.statusText, status: r.status });
      return body;
    });
  }

  const bitsApi = () => (window.Twitch && Twitch.ext && Twitch.ext.bits) ? Twitch.ext.bits : null;

  function normalizePhotos(resp) {
    if (Array.isArray(resp)) return resp;
    if (resp && Array.isArray(resp.photos)) return resp.photos;
    return [];
  }

  function bitsFromSku(sku) {
    if (!sku) return 0;
    const m = sku.match(/TIP_(\d+)/);
    return m ? (+m[1] || 0) : 0;
  }

  // ---------- UI ----------
  function setHTML(el, html) { el.innerHTML = html; }

  function renderGate() {
    setHTML(app, `
      <div style="display:flex;align-items:center;justify-content:center;height:100%;min-height:320px">
        <div style="text-align:center;max-width:560px;padding:16px">
          <div style="font-weight:600;font-size:16px;margin-bottom:6px">This photo gallery is for subscribers only.</div>
          <div style="opacity:.8">Subscribe to view the photos. If you're the broadcaster or a moderator, you should already have access.</div>
        </div>
      </div>
    `);
  }

  function renderEmpty() {
    setHTML(app, `
      <div style="display:flex;align-items:center;justify-content:center;height:100%;min-height:240px">
        <div style="opacity:.85">No photos yet.</div>
      </div>
    `);
  }

  function renderError(msg) {
    setHTML(app, `
      <div style="padding:16px;color:#ff6b6b">Error: ${escapeHtml(msg || 'Something went wrong')}</div>
    `);
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function renderPhotos(list) {
    if (!list || !list.length) { renderEmpty(); return; }

    const haveBits = !!bitsApi();
    const tipBtns = (id) => `
      <div class="row-actions" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
        <button class="btn tip" data-pid="${id}" data-sku="TIP_100">Tip 100</button>
        <button class="btn tip" data-pid="${id}" data-sku="TIP_500">Tip 500</button>
        <button class="btn tip" data-pid="${id}" data-sku="TIP_1000">Tip 1000</button>
        <button class="btn comment" data-pid="${id}" data-sku="COMMENT_500">Comment (500)</button>
        ${haveBits ? '' : '<button class="btn like-dev" data-pid="'+id+'">Like (dev)</button>'}
      </div>
    `;

    const html = `
      <div class="list" style="display:flex;flex-direction:column;gap:16px;padding:12px">
        ${list.map(p => `
          <div class="photo" data-id="${p.id}" style="border:1px solid #2a2a2a;border-radius:12px;overflow:hidden;background:#0e0e10">
            <img src="${escapeHtml(p.url)}" alt="" style="width:100%;display:block;max-height:720px;object-fit:cover;background:#000">
            <div style="padding:10px 12px">
              <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
                <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(p.title || '')}</div>
                <div style="opacity:.8;font-size:12px;white-space:nowrap">
                  <span title="Likes">❤ ${p.likes_count || 0}</span>
                  <span title="Bits" style="margin-left:10px">⚡ ${p.tip_bits_total || 0}</span>
                </div>
              </div>
              ${tipBtns(p.id)}
            </div>
          </div>
        `).join('')}
      </div>
    `;
    setHTML(app, html);

    app.addEventListener('click', async (ev) => {
      const b = ev.target.closest('button');
      if (!b) return;

      const pid = +b.getAttribute('data-pid');
      if (!pid) return;

      if (b.classList.contains('tip')) {
        const sku = b.getAttribute('data-sku');
        await handleTip(pid, sku);
      } else if (b.classList.contains('comment')) {
        const sku = b.getAttribute('data-sku');
        await handleComment(pid, sku);
      } else if (b.classList.contains('like-dev')) {
        try {
          await api('/api/like', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ photoId: pid, bits: 0 })
          });
          refresh();
        } catch (e) {
          console.error(e);
          renderError(e.error || e.message || 'Like failed');
        }
      }
    }, { once: true }); // avoid stacking listeners on re-render
  }

  // ---------- actions ----------
  async function handleTip(photoId, sku) {
    const bits = bitsApi();
    if (bits && products.find(p => p.sku === sku)) {
      pending = { sku, photoId, comment: '' };
      try {
        bits.useBits(sku);
      } catch (e) {
        console.warn('useBits failed, falling back', e);
        await fallbackLike(photoId, sku);
      }
    } else {
      await fallbackLike(photoId, sku);
    }
  }

  async function handleComment(photoId, sku /* COMMENT_500 */) {
    const text = prompt('Enter your comment (will be posted with 500 Bits):');
    if (!text) return;

    const bits = bitsApi();
    if (bits && products.find(p => p.sku === sku)) {
      pending = { sku, photoId, comment: text };
      try {
        bits.useBits(sku);
      } catch (e) {
        console.warn('useBits failed, falling back', e);
        await fallbackComment(photoId, text);
      }
    } else {
      await fallbackComment(photoId, text);
    }
  }

  async function fallbackLike(photoId, sku) {
    const inc = bitsFromSku(sku);
    try {
      await api('/api/like', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photoId, bits: inc })
      });
      refresh();
    } catch (e) {
      renderError(e.error || e.message || 'Tip failed');
    }
  }

  async function fallbackComment(photoId, text) {
    try {
      await api('/api/comment_with_purchase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photoId, comment: text })
      });
      alert('Comment posted!');
    } catch (e) {
      renderError(e.error || e.message || 'Comment failed');
    }
  }

  // ---------- load / refresh ----------
  async function loadStatus() {
    try {
      const j = await api('/api/status');
      role = j.role || 'viewer';
      isSubscriber = !!j.isSubscriber;
      channelId = j.channel_id || null;
    } catch (e) {
      // If identity isn’t shared, the EBS may reject viewers.
      role = 'viewer';
      isSubscriber = false;
    }
  }

  async function loadProducts() {
    try {
      const j = await api('/api/products');
      products = Array.isArray(j.products) ? j.products : [];
    } catch {
      products = [];
    }
  }

  async function loadPhotos() {
    const resp = await api('/api/photos');
    return normalizePhotos(resp);
  }

  async function refresh() {
    try {
      await loadStatus();
      if (role !== 'broadcaster' && role !== 'moderator' && !isSubscriber) {
        renderGate();
        return;
      }
      await loadProducts();
      const list = await loadPhotos();
      renderPhotos(list);
    } catch (e) {
      console.error(e);
      renderError(e.error || e.message || 'Load failed');
    }
  }

  // ---------- Twitch events ----------
  if (window.Twitch && Twitch.ext) {
    Twitch.ext.onAuthorized(async (a) => {
      token = a.token;
      try {
        await api('/health'); // warm-up
      } catch {}
      refresh();
    });

    const b = bitsApi();
    if (b) {
      b.onTransactionComplete(async (tx) => {
        try {
          // send to EBS so it can record likes/comments + announce to chat
          await api('/api/transactions/complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              onReceipt: { sku: tx && tx.sku || pending.sku },
              photoId: pending.photoId,
              comment: pending.comment || ''
            })
          });
        } catch (e) {
          console.warn('complete failed:', e);
        } finally {
          // Clear and refresh
          pending = { sku: null, photoId: null, comment: '' };
          refresh();
        }
      });
    }
  } else {
    // Fallback (shouldn’t happen in Twitch)
    renderError('Twitch Ext API unavailable');
  }
})();
