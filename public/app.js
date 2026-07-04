/* ============================================================
   AMERICAN PRIDE STORE — shared frontend logic
   (used by the homepage and the product pages)
   ============================================================ */

let PRODUCTS = [];
let CATEGORIES = [];
let activeFilter = 'all';
const cart = loadCart();

const $ = (sel) => document.querySelector(sel);
const fmt = (cents) => '$' + (cents / 100).toFixed(2);

// Red padlock icon (emoji can't be recoloured with CSS, so we use an inline SVG).
const LOCK = '<svg class="lock-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-1V6a5 5 0 0 0-5-5zm3 8H9V6a3 3 0 0 1 6 0z"/></svg>';
window.LOCK = LOCK;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
window.esc = esc;

/* ---------- Pricing & options (mirrors the server) ---------- */
function effPrice(p) {
  const sale = Number(p.sale_price) || 0;
  return sale > 0 && sale < p.price ? sale : p.price;
}
function onSale(p) {
  const sale = Number(p.sale_price) || 0;
  return sale > 0 && sale < p.price;
}
function unitPrice(p, options) {
  let u = effPrice(p);
  const sel = options || {};
  (p.options || []).forEach((g) => {
    if (g.type === 'addon') {
      const picked = Array.isArray(sel[g.name]) ? sel[g.name] : (sel[g.name] ? [sel[g.name]] : []);
      g.choices.forEach((c) => { if (picked.includes(c.label)) u += c.price; });
    } else {
      const c = g.choices.find((x) => x.label === sel[g.name]) || g.choices[0];
      if (c) u += c.price;
    }
  });
  return Math.max(u, 0);
}
function optionSummary(p, options) {
  const sel = options || {};
  const parts = [];
  (p.options || []).forEach((g) => {
    if (g.type === 'addon') {
      const picked = Array.isArray(sel[g.name]) ? sel[g.name] : (sel[g.name] ? [sel[g.name]] : []);
      picked.forEach((l) => parts.push(`${g.name}: ${l}`));
    } else {
      const c = g.choices.find((x) => x.label === sel[g.name]) || g.choices[0];
      if (c) parts.push(`${g.name}: ${c.label}`);
    }
  });
  return parts.join(' · ');
}
function optsKey(options) {
  if (!options) return '';
  return Object.keys(options).sort().map((k) => {
    const v = options[k];
    const val = Array.isArray(v) ? [...v].sort().join('+') : v;
    return `${k}=${val}`;
  }).filter((s) => !s.endsWith('=') && !s.endsWith('=undefined')).join('&');
}
function lineKey(slug, options) {
  const k = optsKey(options);
  return k ? `${slug}|${k}` : slug;
}
window.effPrice = effPrice;
window.onSale = onSale;
window.unitPrice = unitPrice;

/* ---------- Affiliate referral capture ---------- */
(function captureRef() {
  const ref = new URLSearchParams(location.search).get('ref');
  if (ref && /^[A-Za-z0-9]{4,20}$/.test(ref)) {
    const code = ref.toUpperCase();
    const existing = getRef();
    localStorage.setItem('ap_ref', JSON.stringify({ code, exp: Date.now() + 30 * 864e5 }));
    if (!existing || existing !== code) {
      fetch('/api/track/' + code, { method: 'POST' }).catch(() => {});
    }
  }
})();
function getRef() {
  try {
    const saved = JSON.parse(localStorage.getItem('ap_ref'));
    if (saved && saved.exp > Date.now()) return saved.code;
  } catch {}
  return '';
}

/* Keep the referral code visible in the URL on every page, so it never
   looks "lost" when a referred visitor clicks through to a product. */
(function keepRefInUrl() {
  const code = getRef();
  if (!code) return;
  const url = new URL(location.href);
  if (url.searchParams.get('ref') !== code) {
    url.searchParams.set('ref', code);
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
})();

/* ---------- Page-view tracking (storefront only) ---------- */
(function trackPageview() {
  fetch('/api/pageview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: location.pathname, ref: getRef() })
  }).catch(() => {});
})();

/* ---------- Cart persistence ----------
   Shape: { [lineKey]: { slug, qty, options } }
   (old carts were { slug: qty } — migrated on load) */
function loadCart() {
  let raw = {};
  try { raw = JSON.parse(localStorage.getItem('ap_cart')) || {}; } catch { raw = {}; }
  const out = {};
  for (const [key, val] of Object.entries(raw)) {
    if (typeof val === 'number') {
      out[key] = { slug: key, qty: val, options: {} }; // migrate old format
    } else if (val && val.slug) {
      out[key] = { slug: val.slug, qty: val.qty || 1, options: val.options || {} };
    }
  }
  return out;
}
function saveCart() {
  localStorage.setItem('ap_cart', JSON.stringify(cart));
}

/* ---------- Load catalog ---------- */
async function initCatalog() {
  const ref = getRef();
  const q = ref ? '?ref=' + encodeURIComponent(ref) : '';
  const [prodRes, catRes] = await Promise.all([fetch('/api/products' + q), fetch('/api/categories')]);
  PRODUCTS = await prodRes.json();
  CATEGORIES = await catRes.json();
  renderFilterTabs();
  renderGrid();
  renderCart();
}

/* ---------- Category filter tabs (homepage only) ---------- */
function renderFilterTabs() {
  const bar = $('#filter-tabs');
  if (!bar) return;
  const cats = CATEGORIES.filter((c) => c.product_count > 0);
  bar.innerHTML = `
    <button class="filter-tab active" data-cat="all">All</button>
    ${cats.map((c) => `<button class="filter-tab" data-cat="${esc(c.slug)}">${esc(c.name)}</button>`).join('')}
  `;
  bar.querySelectorAll('.filter-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeFilter = btn.dataset.cat;
      bar.querySelectorAll('.filter-tab').forEach((b) => b.classList.toggle('active', b === btn));
      renderGrid();
    });
  });
}

/* ---------- Product grid (homepage only) ---------- */
function renderGrid() {
  const grid = $('#product-grid');
  if (!grid) return;
  const list = PRODUCTS.filter((p) => activeFilter === 'all' || p.category_slug === activeFilter);

  if (list.length === 0) {
    grid.innerHTML = '<p style="grid-column:1/-1;text-align:center;color:#8b96b0">No products in this category yet.</p>';
    return;
  }

  grid.innerHTML = list.map((p) => {
    const sale = onSale(p);
    const pct = sale ? Math.round((1 - p.sale_price / p.price) * 100) : 0;
    const hasOptions = (p.options || []).length > 0;
    const priceHtml = sale
      ? `<span class="product-price">${fmt(p.sale_price)}</span> <span class="product-price-old">${fmt(p.price)}</span>`
      : `<span class="product-price">${fmt(p.price)}</span>`;
    // Products with options must be configured on their page, so the card links there.
    const buttonHtml = hasOptions
      ? `<a class="add-btn" href="/product/${esc(p.slug)}">CHOOSE OPTIONS</a>`
      : `<button class="add-btn" data-id="${esc(p.slug)}">ADD TO CART</button>`;
    const buyHtml = hasOptions
      ? `<a class="card-buy" href="/product/${esc(p.slug)}">BUY NOW ${LOCK}</a>`
      : `<button class="card-buy" data-buy="${esc(p.slug)}">BUY NOW ${LOCK}</button>`;
    return `
    <article class="product-card reveal">
      ${sale ? `<span class="product-badge gold sale-badge">-${pct}%</span>` : (p.badge ? `<span class="product-badge ${p.badge === 'LIMITED' ? 'gold' : ''}">${esc(p.badge)}</span>` : '')}
      <a class="card-link" href="/product/${esc(p.slug)}" aria-label="${esc(p.name)}">
        <div class="product-img"><img src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy" /></div>
      </a>
      <div class="product-info">
        ${p.category_name ? `<span class="product-cat">${esc(p.category_name)}</span>` : ''}
        <h3 class="product-name"><a class="card-link" href="/product/${esc(p.slug)}">${esc(p.name)}</a></h3>
        <p class="product-desc">${esc(p.description)}</p>
        <div class="product-foot">
          <div class="price-wrap">${priceHtml}</div>
          ${buttonHtml}
        </div>
        ${buyHtml}
      </div>
    </article>`;
  }).join('');

  grid.querySelectorAll('button.add-btn').forEach((btn) => {
    btn.addEventListener('click', () => addToCart(btn.dataset.id));
  });
  grid.querySelectorAll('button.card-buy').forEach((btn) => {
    btn.addEventListener('click', () => buyNow(btn.dataset.buy, btn));
  });

  observeReveals();
}

/* ---------- Buy now (straight to Stripe checkout, qty 1) ---------- */
async function buyNow(slug, btn) {
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'REDIRECTING…';
  try {
    const res = await fetch('/api/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ id: slug, quantity: 1 }], ref: getRef() })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Checkout failed');
    window.location.href = data.url;
  } catch (err) {
    btn.disabled = false;
    btn.innerHTML = original;
    showToast(err.message);
  }
}

/* ---------- Cart logic ---------- */
function addToCart(slug, qty = 1, options = {}) {
  const key = lineKey(slug, options);
  const existing = cart[key];
  cart[key] = { slug, options, qty: Math.min((existing ? existing.qty : 0) + qty, 99) };
  saveCart();
  renderCart();
  popCartCount();
  showToast();
}
window.addToCart = addToCart;

function setQtyLine(key, qty) {
  if (!cart[key]) return;
  if (qty <= 0) delete cart[key];
  else cart[key].qty = Math.min(qty, 99);
  saveCart();
  renderCart();
}

function cartEntries() {
  return Object.entries(cart)
    .map(([key, line]) => ({ key, line, product: PRODUCTS.find((p) => p.slug === line.slug) }))
    .filter((e) => e.product);
}

function renderCart() {
  const entries = cartEntries();
  const count = entries.reduce((s, e) => s + e.line.qty, 0);
  const total = entries.reduce((s, e) => s + unitPrice(e.product, e.line.options) * e.line.qty, 0);

  $('#cart-count').textContent = count;
  $('#cart-head-count').textContent = count ? `(${count})` : '';
  $('#cart-total').textContent = fmt(total);
  $('#checkout-btn').style.display = count ? '' : 'none';

  const box = $('#cart-items');
  if (!count) {
    box.innerHTML = `<div class="cart-empty"><span class="big">🛒</span>Your cart is empty.<br/>Time to gear up, patriot!</div>`;
    return;
  }

  box.innerHTML = entries.map(({ key, line, product: p }) => {
    const summary = optionSummary(p, line.options);
    return `
    <div class="cart-item">
      <div class="cart-item-img"><img src="${esc(p.image)}" alt="${esc(p.name)}" /></div>
      <div class="cart-item-info">
        <div class="cart-item-name">${esc(p.name)}</div>
        ${summary ? `<div class="cart-item-opts">${esc(summary)}</div>` : ''}
        <div class="cart-item-price">${fmt(unitPrice(p, line.options))}</div>
        <div class="qty-controls">
          <button class="qty-btn" data-key="${esc(key)}" data-d="-1">−</button>
          <span class="qty-val">${line.qty}</span>
          <button class="qty-btn" data-key="${esc(key)}" data-d="1">+</button>
        </div>
      </div>
      <button class="cart-item-remove" data-key="${esc(key)}" aria-label="Remove">✕</button>
    </div>`;
  }).join('');

  box.querySelectorAll('.qty-btn').forEach((b) =>
    b.addEventListener('click', () => setQtyLine(b.dataset.key, (cart[b.dataset.key] ? cart[b.dataset.key].qty : 0) + Number(b.dataset.d)))
  );
  box.querySelectorAll('.cart-item-remove').forEach((b) =>
    b.addEventListener('click', () => setQtyLine(b.dataset.key, 0))
  );
}

function popCartCount() {
  const el = $('#cart-count');
  el.classList.add('pop');
  setTimeout(() => el.classList.remove('pop'), 220);
}

/* ---------- Toast ---------- */
let toastTimer;
function showToast(msg) {
  const t = $('#toast');
  t.textContent = msg || 'Added to cart! 🇺🇸';
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), msg ? 3200 : 1800);
}

/* ---------- Cart drawer open/close ---------- */
function openCart() {
  $('#cart-drawer').classList.add('open');
  $('#cart-overlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeCart() {
  $('#cart-drawer').classList.remove('open');
  $('#cart-overlay').classList.remove('open');
  document.body.style.overflow = '';
}
$('#cart-btn').addEventListener('click', openCart);
$('#cart-close').addEventListener('click', closeCart);
$('#cart-overlay').addEventListener('click', closeCart);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCart(); });

/* ---------- Stripe checkout ---------- */
$('#checkout-btn').addEventListener('click', async () => {
  const btn = $('#checkout-btn');
  const label = $('#checkout-label');
  const errBox = $('#cart-error');
  errBox.textContent = '';

  const items = Object.values(cart).map((line) => ({ id: line.slug, quantity: line.qty, options: line.options }));
  if (items.length === 0) return;

  btn.disabled = true;
  label.textContent = 'REDIRECTING…';

  try {
    const res = await fetch('/api/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, ref: getRef() })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Checkout failed');
    window.location.href = data.url;
  } catch (err) {
    errBox.textContent = err.message;
    btn.disabled = false;
    label.textContent = 'SECURE CHECKOUT 🔒';
  }
});

/* ---------- Navbar scroll state ---------- */
const navbar = $('#navbar');
window.addEventListener('scroll', () => {
  navbar.classList.toggle('scrolled', window.scrollY > 40 || !$('#product-grid'));
}, { passive: true });

/* ---------- Scroll reveal animations ---------- */
let revealObserver;
function observeReveals() {
  if (!revealObserver) {
    revealObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry, i) => {
        if (entry.isIntersecting) {
          entry.target.style.transitionDelay = `${(i % 4) * 90}ms`;
          entry.target.classList.add('visible');
          revealObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });
  }
  document.querySelectorAll('.reveal:not(.visible)').forEach((el) => revealObserver.observe(el));
}
observeReveals();

/* ---------- Twinkling stars in hero ---------- */
(function makeStars() {
  const layer = $('#stars-layer');
  if (!layer) return;
  const n = window.innerWidth < 640 ? 26 : 48;
  let html = '';
  for (let i = 0; i < n; i++) {
    const size = 6 + Math.random() * 12;
    html += `<span class="star" style="left:${Math.random() * 100}%;top:${Math.random() * 100}%;--size:${size}px;--dur:${2.5 + Math.random() * 3}s;--delay:${Math.random() * 4}s">★</span>`;
  }
  layer.innerHTML = html;
})();

/* ---------- Animated stat counters ---------- */
(function countUp() {
  const nums = document.querySelectorAll('.stat-num');
  if (!nums.length) return;
  const obs = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      obs.unobserve(entry.target);
      const el = entry.target;
      const target = Number(el.dataset.count);
      const decimals = Number(el.dataset.decimals) || 0;
      const suffix = el.dataset.suffix || '';
      const dur = 1600;
      const start = performance.now();
      (function tick(now) {
        const t = Math.min((now - start) / dur, 1);
        const eased = 1 - Math.pow(1 - t, 3);
        const value = target * eased;
        const text = decimals
          ? value.toFixed(decimals)
          : Math.round(value).toLocaleString('en-US');
        el.textContent = text + suffix;
        if (t < 1) requestAnimationFrame(tick);
      })(start);
    });
  }, { threshold: 0.5 });
  nums.forEach((el) => obs.observe(el));
})();

/* ---------- Go ---------- */
initCatalog().catch(() => {
  const grid = $('#product-grid');
  if (grid) grid.innerHTML = '<p style="text-align:center;color:#8b96b0">Could not load products. Is the server running?</p>';
});
