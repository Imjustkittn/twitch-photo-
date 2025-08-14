(function() {
  let auth = null;
  let status = { isSubscriber:false, userId:null, role:'viewer' };
  let currentPhoto = null;
  let pendingCommentMessage = '';

  const el = (sel) => document.querySelector(sel);
  const gate = el('#gate');
  const identity = el('#identity');
  const gallery = el('#gallery');
  const photosEl = el('#photos');
  const drawer = el('#drawer');
  const drawerPhoto = el('#drawerPhoto');
  const commentsEl = el('#comments');
  const commentText = el('#commentText');
  const commentBtn = el('#commentBtn');
  const modTools = el('#modTools');

  function api(path, opts={}) {
    opts.headers = opts.headers || {};
    opts.headers['Authorization'] = 'Bearer ' + auth.token;
    opts.headers['Content-Type'] = 'application/json';
    return fetch((window.EBS_BASE || '') + path, opts).then(r => {
      if (!r.ok) throw r;
      return r.json();
    });
  }

  function bitsLabel(n){ return `⭐ ${n||0} bits`; }

  function renderPhotos(list) {
    photosEl.innerHTML = '';
    list.forEach(p => {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `
        <img src="${p.url}" alt="${p.title || ''}"/>
        <div class="bits">${bitsLabel(p.tip_bits_total)}</div>
        <div class="meta"><div>${p.title || ''}</div><button class="badge">Open</button></div>
        <div class="underbits" style="padding: 0 10px 10px; font-size:12px; opacity:.9">${bitsLabel(p.tip_bits_total)}</div>
      `;
      card.querySelector('.badge').addEventListener('click', () => openPhoto(p));
      photosEl.appendChild(card);
    });
  }

  async function openPhoto(p) {
    currentPhoto = p;
    drawer.classList.remove('hidden');
    drawerPhoto.innerHTML = `<img src="${p.url}" alt="${p.title||''}"><div style="margin-top:6px">${p.title||''}</div>`;
    await loadComments();
  }

  el('#closeDrawer').addEventListener('click', () => drawer.classList.add('hidden'));

  async function loadComments() {
    commentsEl.innerHTML = '';
    const rows = await api('/api/comments?photoId=' + encodeURIComponent(currentPhoto.id));
    rows.forEach(row => {
      const c = document.createElement('div');
      c.className = 'comment';
      c.dataset.id = row.id;
      c.innerHTML = `<strong>${row.display_name || 'Viewer'}:</strong> ${row.message}`;
      if (status.role === 'broadcaster') {
        c.addEventListener('click', async () => {
          await api('/api/comment/' + row.id, { method:'PATCH', body: JSON.stringify({ hidden: 1 }) });
          await loadComments();
        });
      }
      commentsEl.appendChild(c);
    });
  }

  // Bits products helper (optional)
  async function ensureProductsReady() {
    if (!window.Twitch.ext.features.isBitsEnabled) return;
    try {
      const products = await window.Twitch.ext.bits.getProducts();
      console.log('Products', products);
    } catch (e) {
      console.warn('getProducts failed', e);
    }
  }

  // Tip buttons
  document.querySelectorAll('.tip').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!currentPhoto) return;
      const sku = btn.dataset.sku;
      window.Twitch.ext.bits.useBits(sku);
    });
  });

  // Comments: pay-per-comment (COMMENT_500). We initiate purchase after user writes message.
  commentBtn.addEventListener('click', async () => {
    const message = commentText.value.trim();
    if (!message) return;
    pendingCommentMessage = message;
    // Initiate Bits purchase for a single comment
    window.Twitch.ext.bits.useBits('COMMENT_500');
  });

  // Listen for pubsub updates
  window.Twitch.ext.listen('broadcast', async (target, contentType, message) => {
    try {
      const msg = JSON.parse(message);
      if (msg.type === 'tip_update') {
        // Refresh photos (bits counters)
        const photos = await api('/api/photos');
        renderPhotos(photos);
      }
      if (msg.type === 'new_comment' && currentPhoto && msg.photoId === currentPhoto.id) {
        loadComments();
      }
    } catch {}
  });

  // Bits completion handler
  window.Twitch.ext.bits.onTransactionComplete(async (tx) => {
    try {
      if (!tx) return;
      const sku = (tx.product && tx.product.sku) || tx.product || '';
      if (sku.startsWith('TIP_')) {
        // Tip-only flow
        await api('/api/transactions/complete', { method:'POST', body: JSON.stringify({ receipt: tx.transactionReceipt, photoId: currentPhoto ? currentPhoto.id : null }) });
        const photos = await api('/api/photos');
        renderPhotos(photos);
        return;
      }
      if (sku === 'COMMENT_500' && currentPhoto && pendingCommentMessage) {
        const payload = { photoId: currentPhoto.id, message: pendingCommentMessage, receipt: tx.transactionReceipt };
        await api('/api/comment_with_purchase', { method:'POST', body: JSON.stringify(payload) });
        pendingCommentMessage = '';
        commentText.value = '';
        await loadComments();
      }
    } catch (e) {
      console.error('bits completion error', e);
    }
  });

  async function fetchStatus() {
    status = await api('/api/status');
  }

  async function initAfterStatus() {
    if (!status.userId) {
      gate.classList.add('hidden');
      identity.classList.remove('hidden');
      return;
    }
    if (!status.isSubscriber) {
      gate.textContent = 'This photo gallery is for subscribers only.';
      gate.classList.remove('hidden');
      gallery.classList.add('hidden');
      return;
    }
    gate.classList.add('hidden');
    identity.classList.add('hidden');
    gallery.classList.remove('hidden');
    modTools.classList.toggle('hidden', status.role !== 'broadcaster');
    const photos = await api('/api/photos');
    renderPhotos(photos);
  }

  // Identity share button
  el('#shareIdBtn').addEventListener('click', () => {
    window.Twitch.ext.actions.requestIdShare();
  });

  // Auth bootstrap
  window.Twitch.ext.onAuthorized(async function(a) {
    auth = a;
    await ensureProductsReady();
    await fetchStatus();
    await initAfterStatus();
  });
})();
