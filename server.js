require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const sharp = require('sharp');
const geoip = require('geoip-lite');
const db = require('./db');

const Stripe = require('stripe');
const app = express();
const PORT = process.env.PORT || 4242;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

/* ---------- Settings (DB-backed, override .env) ---------- */
function getSetting(key) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : '';
}
function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value || ''));
}

// Effective Stripe key: admin-panel setting wins, else .env.
function currentStripeKey() {
  return getSetting('stripe_secret_key') || process.env.STRIPE_SECRET_KEY || '';
}
// The public site URL (for Stripe redirects + affiliate links).
function currentDomain() {
  return getSetting('domain') || process.env.DOMAIN || `http://localhost:${PORT}`;
}

// A Stripe client for the current key, rebuilt only when the key changes.
let _stripeClient = null;
let _stripeKeyUsed = null;
function getStripe() {
  const key = currentStripeKey();
  if (!key) return null;
  if (key !== _stripeKeyUsed) { _stripeClient = Stripe(key); _stripeKeyUsed = key; }
  return _stripeClient;
}

// We sit behind nginx, which forwards the visitor's real IP in X-Forwarded-For.
app.set('trust proxy', true);
app.use(express.json({ limit: '6mb' }));

// Best-effort 2-letter country code for the requesting visitor (offline GeoIP).
// Only the country is derived and stored — never the raw IP address.
function countryOf(req) {
  try {
    let ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.headers['x-real-ip'] || req.ip || (req.socket && req.socket.remoteAddress) || '';
    ip = ip.replace(/^::ffff:/, ''); // unwrap IPv4-mapped IPv6
    if (!ip || ip === '::1' || ip === '127.0.0.1') return '';
    const geo = geoip.lookup(ip);
    return geo && geo.country ? geo.country : '';
  } catch { return ''; }
}

/* ============================================================
   SEO / social meta (server-rendered so crawlers see it)
   ============================================================ */
function htmlEscape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function absoluteUrl(p) {
  const base = currentDomain().replace(/\/+$/, '');
  if (!p) return base;
  return /^https?:\/\//i.test(p) ? p : base + (p.startsWith('/') ? '' : '/') + p;
}
// A share image guaranteed to be a real raster (PNG/JPG) so it renders on social apps.
function siteOgImage() {
  const set = getSetting('og_image');
  if (set) return absoluteUrl(set);
  const row = db.prepare("SELECT image FROM products WHERE active = 1 AND image LIKE '%.png' OR image LIKE '%.jpg' OR image LIKE '%.jpeg' OR image LIKE '%.webp' ORDER BY featured DESC, created_at DESC LIMIT 1").get();
  if (row && row.image) return absoluteUrl(row.image);
  return absoluteUrl('/images/og-cover.svg');
}
function rasterOrDefault(imgPath) {
  return imgPath && /\.(png|jpe?g|webp)$/i.test(imgPath) ? absoluteUrl(imgPath) : siteOgImage();
}
// The raw (public) image path used as the source for the site's share banner.
function siteOgSource() {
  const set = getSetting('og_image');
  if (set) return set;
  const row = db.prepare("SELECT image FROM products WHERE active = 1 AND (image LIKE '%.png' OR image LIKE '%.jpg' OR image LIKE '%.jpeg' OR image LIKE '%.webp') ORDER BY featured DESC, created_at DESC LIMIT 1").get();
  return (row && row.image) ? row.image : '/images/og-cover.svg';
}
const baseNoExt = (p) => path.basename(p || '').replace(/\.[^.]+$/, '');

// Parse ?from=YYYY-MM-DD&to=YYYY-MM-DD for stats; default = last 7 days.
function dateRange(req) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const q = req.query || {};
  if (re.test(q.from) && re.test(q.to)) {
    return q.from <= q.to ? { from: q.from, to: q.to } : { from: q.to, to: q.from };
  }
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10);
  return { from, to: today };
}
function buildMetaTags({ title, description, url, image, type = 'website', jsonld, extra = '' }) {
  const t = htmlEscape(title);
  const d = htmlEscape(String(description || '').replace(/\s+/g, ' ').trim().slice(0, 300));
  const u = htmlEscape(url);
  const img = htmlEscape(image);
  let tags = `
  <title>${t}</title>
  <meta name="description" content="${d}" />
  <link rel="canonical" href="${u}" />
  <meta name="robots" content="index, follow" />
  <meta name="theme-color" content="#0a1228" />
  <meta property="og:type" content="${type}" />
  <meta property="og:site_name" content="American Pride Store" />
  <meta property="og:title" content="${t}" />
  <meta property="og:description" content="${d}" />
  <meta property="og:url" content="${u}" />
  <meta property="og:image" content="${img}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />${/\.jpe?g$/i.test(image) ? '\n  <meta property="og:image:type" content="image/jpeg" />' : (/\.png$/i.test(image) ? '\n  <meta property="og:image:type" content="image/png" />' : '')}
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${t}" />
  <meta name="twitter:description" content="${d}" />
  <meta name="twitter:image" content="${img}" />${extra}`;
  if (jsonld) tags += `\n  <script type="application/ld+json">${JSON.stringify(jsonld)}</script>`;
  return tags;
}
const _pageCache = {};
function renderPage(file, metaBlock) {
  if (!_pageCache[file]) _pageCache[file] = fs.readFileSync(path.join(__dirname, 'public', file), 'utf8');
  return _pageCache[file].replace('<!--META-->', metaBlock);
}

// Generate a proper 1200x630 landscape share image (product photo centered on a
// navy brand background) so link previews look right instead of a giant square.
const OG_DIR = path.join(__dirname, 'public', 'images', 'og-cache');
async function ensureOgImage(publicImagePath, cacheName) {
  try {
    if (!publicImagePath || /^https?:\/\//i.test(publicImagePath)) return null;
    const srcAbs = path.join(__dirname, 'public', publicImagePath.replace(/^\//, ''));
    if (!fs.existsSync(srcAbs)) return null;
    if (!fs.existsSync(OG_DIR)) fs.mkdirSync(OG_DIR, { recursive: true });
    const safe = cacheName.replace(/[^a-z0-9._-]/gi, '_').slice(0, 100);
    // JPEG: ~5x smaller than PNG so WhatsApp/Messenger never skip it (their
    // preview limit is ~600KB). Bump the style version to bust scraper caches
    // whenever the banner design changes.
    const OG_STYLE = 'v2';
    const outAbs = path.join(OG_DIR, `${safe}-${OG_STYLE}.jpg`);
    const outPublic = `/images/og-cache/${safe}-${OG_STYLE}.jpg`;
    // (re)generate if missing or older than the source image
    if (!fs.existsSync(outAbs) || fs.statSync(outAbs).mtimeMs < fs.statSync(srcAbs).mtimeMs) {
      const NAVY = { r: 10, g: 18, b: 40 };
      // Blur-fill: background is the photo itself scaled to cover the full
      // 1200x630 and blurred, so portrait/dark photos never leave dead bars.
      const bg = await sharp(srcAbs)
        .flatten({ background: NAVY })
        .resize(1200, 630, { fit: 'cover' })
        .blur(30)
        .modulate({ brightness: 0.55, saturation: 0.9 })
        .toBuffer();
      const fg = await sharp(srcAbs)
        .resize(1080, 566, { fit: 'inside' })
        .toBuffer();
      await sharp(bg)
        .composite([{ input: fg, gravity: 'centre' }])
        .jpeg({ quality: 84, mozjpeg: true })
        .toFile(outAbs);
    }
    return outPublic;
  } catch {
    return null;
  }
}

// Homepage — must be BEFORE express.static (which would otherwise serve index.html raw)
app.get('/', async (req, res) => {
  const url = currentDomain().replace(/\/+$/, '') + '/';
  const src = siteOgSource();
  const og = await ensureOgImage(src, 'home-' + baseNoExt(src));
  const img = absoluteUrl(og || src);
  const jsonld = {
    '@context': 'https://schema.org', '@type': 'Store',
    name: 'American Pride Store', url,
    description: 'Premium American Trump merchandise — hats, tees, flags and more.',
    image: img
  };
  res.type('html').send(renderPage('index.html', buildMetaTags({
    title: 'American Pride Store — Official Patriot Merchandise',
    description: 'Premium American Trump merchandise. Hats, tees, flags & more. Secure checkout with Stripe.',
    url, image: img, type: 'website', jsonld
  })));
});

app.use(express.static(path.join(__dirname, 'public')));

/* ============================================================
   Helpers: sessions (signed cookies), passwords, slugs
   ============================================================ */
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function setCookie(res, name, value, maxAgeSec) {
  res.append('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`);
}

function clearCookie(res, name) {
  res.append('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'product';
}

function uniqueProductSlug(base) {
  let slug = base;
  let n = 2;
  while (db.prepare('SELECT 1 FROM products WHERE slug = ?').get(slug)) slug = `${base}-${n++}`;
  return slug;
}

/* ---------- Pricing & product options ---------- */
// Normalise the option groups an admin submits into a safe, stored shape.
function sanitizeOptions(raw) {
  let arr = raw;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { arr = []; } }
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 8).map((g) => {
    const name = String(g && g.name || '').trim().slice(0, 40);
    const type = g && g.type === 'addon' ? 'addon' : 'select';
    const choices = Array.isArray(g && g.choices) ? g.choices : [];
    const cleanChoices = choices.slice(0, 20).map((c) => ({
      label: String(c && c.label || '').trim().slice(0, 40),
      price: Math.min(Math.max(Math.round(Number(c && c.price) || 0), 0), 1000000)
    })).filter((c) => c.label);
    return { name, type, choices: cleanChoices };
  }).filter((g) => g.name && g.choices.length);
}

// The price a customer actually pays for one unit (sale price wins if valid).
function effectivePrice(product) {
  const sale = Number(product.sale_price) || 0;
  return sale > 0 && sale < product.price ? sale : product.price;
}

// An approved affiliate by referral code (or null).
function affiliateByRef(ref) {
  if (!ref || !/^[A-Za-z0-9]{4,20}$/.test(ref)) return null;
  return db.prepare("SELECT * FROM affiliates WHERE code = ? AND status = 'approved'").get(ref.toUpperCase());
}

// The selling base for a product in an affiliate's context.
// Affiliates may only mark UP: their price is clamped to at least the platform price.
function sellingBase(product, affiliate) {
  const eff = effectivePrice(product);
  if (!affiliate) return eff;
  const row = db.prepare('SELECT price FROM affiliate_prices WHERE affiliate_id = ? AND product_slug = ?').get(affiliate.id, product.slug);
  const custom = row ? Number(row.price) || 0 : 0;
  return custom > 0 ? Math.max(custom, eff) : eff;
}

// Compute the unit price for a product given the customer's option selections,
// validating every selection against what the product actually offers.
function priceWithOptions(product, selected, baseOverride) {
  let options = product.options;
  if (typeof options === 'string') { try { options = JSON.parse(options); } catch { options = []; } }
  if (!Array.isArray(options)) options = [];
  const sel = selected && typeof selected === 'object' ? selected : {};

  let unit = typeof baseOverride === 'number' ? baseOverride : effectivePrice(product);
  const chosen = [];
  for (const group of options) {
    if (group.type === 'addon') {
      const picked = Array.isArray(sel[group.name]) ? sel[group.name] : (sel[group.name] ? [sel[group.name]] : []);
      for (const choice of group.choices) {
        if (picked.includes(choice.label)) {
          unit += choice.price;
          chosen.push({ group: group.name, label: choice.label, price: choice.price });
        }
      }
    } else {
      // "select" — customer must pick exactly one; fall back to the first choice.
      const wanted = sel[group.name];
      let choice = group.choices.find((c) => c.label === wanted) || group.choices[0];
      if (choice) {
        unit += choice.price;
        chosen.push({ group: group.name, label: choice.label, price: choice.price });
      }
    }
  }
  return { unit: Math.max(unit, 0), chosen };
}

// Short human label for chosen options, e.g. "Size: XXL · Color: Red"
function chosenLabel(chosen) {
  return chosen.map((c) => `${c.group}: ${c.label}`).join(' · ');
}

function requireAdmin(req, res, next) {
  const session = verify(cookies(req).ap_admin);
  if (!session || session.role !== 'admin') return res.status(401).json({ error: 'Not logged in' });
  next();
}

function requireAffiliate(req, res, next) {
  const session = verify(cookies(req).ap_aff);
  if (!session || session.role !== 'affiliate') return res.status(401).json({ error: 'Not logged in' });
  const affiliate = db.prepare('SELECT * FROM affiliates WHERE id = ?').get(session.id);
  if (!affiliate) return res.status(401).json({ error: 'Account not found' });
  req.affiliate = affiliate;
  next();
}

/* ============================================================
   PUBLIC API — storefront
   ============================================================ */
app.get('/api/categories', (req, res) => {
  res.json(db.prepare(`
    SELECT c.id, c.name, c.slug,
           (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.active = 1) AS product_count
    FROM categories c ORDER BY c.name
  `).all());
});

app.get('/api/products', (req, res) => {
  const rows = db.prepare(`
    SELECT p.slug AS id, p.slug, p.name, p.description, p.price, p.sale_price, p.image, p.badge, p.featured, p.options,
           c.name AS category_name, c.slug AS category_slug
    FROM products p LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.active = 1
    ORDER BY p.featured DESC, p.created_at DESC
  `).all();
  const affiliate = affiliateByRef(req.query.ref);
  for (const r of rows) {
    try { r.options = JSON.parse(r.options) || []; } catch { r.options = []; }
    applyAffiliatePrice(r, affiliate);
  }
  res.json(rows);
});

// When viewing via an affiliate link, show that affiliate's (marked-up) price.
function applyAffiliatePrice(row, affiliate) {
  if (!affiliate) return;
  const base = sellingBase(row, affiliate);
  if (base > effectivePrice(row)) { row.price = base; row.sale_price = 0; row.aff_price = 1; }
}

app.get('/api/product/:slug', (req, res) => {
  const product = db.prepare(`
    SELECT p.slug AS id, p.slug, p.name, p.description, p.long_description, p.price, p.sale_price, p.image, p.images, p.badge, p.featured, p.options,
           c.name AS category_name, c.slug AS category_slug, p.category_id
    FROM products p LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.slug = ? AND p.active = 1
  `).get(req.params.slug);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  try { product.images = JSON.parse(product.images) || []; } catch { product.images = []; }
  try { product.options = JSON.parse(product.options) || []; } catch { product.options = []; }

  const related = db.prepare(`
    SELECT p.slug AS id, p.slug, p.name, p.price, p.sale_price, p.image, p.badge
    FROM products p
    WHERE p.active = 1 AND p.slug != ? AND (p.category_id = ? OR ? IS NULL)
    ORDER BY p.featured DESC, RANDOM() LIMIT 4
  `).all(product.slug, product.category_id, product.category_id);

  const affiliate = affiliateByRef(req.query.ref);
  applyAffiliatePrice(product, affiliate);
  for (const r of related) applyAffiliatePrice(r, affiliate);

  res.json({ product, related });
});

/* ---------- Blog (public) ---------- */
app.get('/api/posts', (req, res) => {
  res.json(db.prepare(`
    SELECT slug, title, excerpt, cover, created_at FROM posts
    WHERE published = 1 ORDER BY created_at DESC LIMIT 100
  `).all());
});

app.get('/api/post/:slug', (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE slug = ? AND published = 1').get(req.params.slug);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  // How many products the chosen ad layout shows.
  const style = post.ad_style || 'banner';
  const limit = style === 'grid3' ? 6 : style === 'grid2' || style === 'strip' ? 4 : style === 'spotlight' ? 1 : 2;

  // Products advertised inside the post: admin's picks, else featured products.
  let slugs = [];
  try { slugs = JSON.parse(post.product_slugs) || []; } catch {}
  let ads = [];
  if (slugs.length) {
    const get = db.prepare(`
      SELECT p.slug AS id, p.slug, p.name, p.description, p.price, p.sale_price, p.image, p.badge, p.options
      FROM products p WHERE p.slug = ? AND p.active = 1`);
    ads = slugs.map((s) => get.get(s)).filter(Boolean);
  }
  if (!ads.length) {
    ads = db.prepare(`
      SELECT p.slug AS id, p.slug, p.name, p.description, p.price, p.sale_price, p.image, p.badge, p.options
      FROM products p WHERE p.active = 1 ORDER BY p.featured DESC, RANDOM() LIMIT ?`).all(limit);
  }
  ads = ads.slice(0, limit);
  const affiliate = affiliateByRef(req.query.ref);
  for (const a of ads) {
    try { a.options = JSON.parse(a.options) || []; } catch { a.options = []; }
    applyAffiliatePrice(a, affiliate);
  }

  const more = db.prepare(`
    SELECT slug, title, excerpt, cover, created_at FROM posts
    WHERE published = 1 AND slug != ? ORDER BY created_at DESC LIMIT 3
  `).all(post.slug);

  res.json({ post: { slug: post.slug, title: post.title, excerpt: post.excerpt, content: post.content, cover: post.cover, created_at: post.created_at, ad_style: style }, ads, more });
});

app.post('/api/track/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  db.prepare('UPDATE affiliates SET clicks = clicks + 1 WHERE code = ?').run(code);
  // Remember the referral for 24h so a returning buyer still credits this affiliate.
  if (/^[A-Za-z0-9]{4,20}$/.test(code)) setCookie(res, 'ap_ref', code, 24 * 3600);
  res.json({ ok: true });
});

// Storefront page-view logger (called by app.js on every store page load).
app.post('/api/pageview', (req, res) => {
  let path = String(req.body.path || '').slice(0, 200);
  if (!path.startsWith('/') || path.startsWith('/admin') || path.startsWith('/api')) return res.json({ ok: false });
  path = path.split('?')[0].split('#')[0];
  const ref = /^[A-Za-z0-9]{4,20}$/.test(String(req.body.ref || '')) ? req.body.ref.toUpperCase() : '';
  db.prepare('INSERT INTO pageviews (path, ref, country) VALUES (?, ?, ?)').run(path, ref, countryOf(req));
  res.json({ ok: true });
});

// Storefront interaction logger — records Add-to-cart / Buy-now button clicks
// so both admin and affiliates can see how many people click "Add to cart".
app.post('/api/event', (req, res) => {
  const type = String(req.body.type || '');
  if (type !== 'add_to_cart' && type !== 'buy_now') return res.json({ ok: false });
  const slug = String(req.body.slug || '').slice(0, 100);
  const ref = /^[A-Za-z0-9]{4,20}$/.test(String(req.body.ref || '')) ? req.body.ref.toUpperCase() : '';
  db.prepare('INSERT INTO events (type, slug, ref) VALUES (?, ?, ?)').run(type, slug, ref);
  res.json({ ok: true });
});

/* ---------- Stripe checkout ---------- */
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const stripe = getStripe();
    if (!stripe) {
      return res.status(500).json({ error: 'Stripe is not configured yet. Add your secret key in Admin → Settings.' });
    }

    const items = Array.isArray(req.body.items) ? req.body.items : [];
    // Prefer the ref the client sends; fall back to the 24h referral cookie.
    let ref = typeof req.body.ref === 'string' ? req.body.ref.toUpperCase().slice(0, 20) : '';
    if (!ref) ref = (cookies(req).ap_ref || '').toUpperCase().slice(0, 20);

    const affiliate = affiliateByRef(ref);
    const getProduct = db.prepare('SELECT * FROM products WHERE slug = ? AND active = 1');
    const lineItems = [];
    const detail = []; // full record we keep for fulfillment + profit
    for (const item of items) {
      const product = getProduct.get(String(item.id));
      const quantity = Math.min(Math.max(parseInt(item.quantity, 10) || 0, 0), 99);
      if (!product || quantity === 0) continue;

      // Base price = the affiliate's (marked-up) price if they referred this sale, else platform price.
      const { unit, chosen } = priceWithOptions(product, item.options, sellingBase(product, affiliate));
      const label = chosenLabel(chosen);
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: product.name,
            description: [product.description, label].filter(Boolean).join(' — ').slice(0, 250) || undefined
          },
          unit_amount: unit
        },
        quantity
      });
      detail.push({
        slug: product.slug,
        name: product.name,
        qty: quantity,
        unit,                       // price actually charged per unit (incl. options + sale)
        cost: Number(product.cost) || 0,
        options: chosen             // [{group,label,price}] — what to order from the supplier
      });
    }
    if (lineItems.length === 0) return res.status(400).json({ error: 'No valid items in cart.' });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: lineItems,
      shipping_address_collection: { allowed_countries: ['US', 'CA', 'GB', 'AU', 'IE', 'NZ', 'DE', 'FR'] },
      phone_number_collection: { enabled: true }, // require a phone number (email is always collected)
      locale: 'en', // force English checkout + US-style phone default (not Macedonian)
      metadata: { ref },
      success_url: `${currentDomain()}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${currentDomain()}/cancel.html`
    });

    // Keep the full line detail server-side, keyed by the Stripe session id.
    db.prepare('INSERT OR REPLACE INTO pending_checkouts (session_id, ref, items_json) VALUES (?, ?, ?)')
      .run(session.id, ref, JSON.stringify(detail));

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).json({ error: 'Unable to start checkout. Please try again.' });
  }
});

/* ---------- Order confirmation (records sale + commission) ---------- */
app.post('/api/confirm', async (req, res) => {
  try {
    const stripe = getStripe();
    if (!stripe) return res.status(400).json({ error: 'Stripe not configured' });
    const sessionId = String(req.body.session_id || '');
    if (!sessionId) return res.status(400).json({ error: 'Missing session_id' });

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== 'paid') return res.json({ recorded: false, status: session.payment_status });

    // Already recorded? Nothing to do.
    if (db.prepare('SELECT 1 FROM orders WHERE session_id = ?').get(session.id)) {
      return res.json({ recorded: true });
    }

    // Pull the full line detail we stored when the checkout was created.
    const pending = db.prepare('SELECT * FROM pending_checkouts WHERE session_id = ?').get(session.id);
    let items = [];
    let ref = (session.metadata && session.metadata.ref) || '';
    if (pending) {
      try { items = JSON.parse(pending.items_json) || []; } catch { items = []; }
      ref = ref || pending.ref || '';
    }

    // Profit = what the customer paid minus what the goods cost us, per unit.
    let profit = 0;
    for (const it of items) {
      const perUnitProfit = Math.max((Number(it.unit) || 0) - (Number(it.cost) || 0), 0);
      profit += perUnitProfit * (Number(it.qty) || 0);
    }

    // Affiliate earns their % of the PROFIT (not the full sale).
    let affiliateId = null;
    let commission = 0;
    if (ref) {
      const affiliate = db.prepare("SELECT * FROM affiliates WHERE code = ? AND status = 'approved'").get(ref);
      if (affiliate) {
        affiliateId = affiliate.id;
        commission = Math.round(profit * (affiliate.commission_pct / 100));
      }
    }

    db.prepare(`
      INSERT OR IGNORE INTO orders (session_id, amount_total, currency, customer_email, customer_phone, affiliate_id, commission, profit, items_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id,
      session.amount_total,
      session.currency,
      (session.customer_details && session.customer_details.email) || '',
      (session.customer_details && session.customer_details.phone) || '',
      affiliateId,
      commission,
      profit,
      JSON.stringify(items)
    );

    db.prepare('DELETE FROM pending_checkouts WHERE session_id = ?').run(session.id);
    res.json({ recorded: true });
  } catch (err) {
    console.error('Confirm error:', err.message);
    res.status(500).json({ error: 'Could not confirm order' });
  }
});

/* ============================================================
   AFFILIATE API
   ============================================================ */
// Public self-registration is closed — accounts are created by the admin only.
app.post('/api/affiliate/register', (req, res) => {
  res.status(403).json({ error: 'Sign-ups are closed. Accounts are opened by the store owner — send us a message to apply.' });
});

// "Send us a message" from the affiliate page (people who want to apply).
app.post('/api/affiliate/contact', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const email = String(req.body.email || '').trim().slice(0, 120);
  const body = String(req.body.body || '').trim().slice(0, 2000);
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !body) {
    return res.status(400).json({ error: 'Please enter your name, a valid email and a message.' });
  }
  db.prepare('INSERT INTO contact_requests (name, email, body) VALUES (?, ?, ?)').run(name, email, body);
  res.json({ ok: true });
});

// "Contact us" form on the storefront → lands in Admin → Messages.
app.post('/api/contact', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const email = String(req.body.email || '').trim().slice(0, 120);
  const subject = String(req.body.subject || '').trim().slice(0, 160);
  const body = String(req.body.body || '').trim().slice(0, 3000);
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !body) {
    return res.status(400).json({ error: 'Please enter your name, a valid email and a message.' });
  }
  db.prepare('INSERT INTO contact_messages (name, email, subject, body) VALUES (?, ?, ?, ?)').run(name, email, subject, body);
  res.json({ ok: true });
});

app.post('/api/affiliate/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const affiliate = db.prepare('SELECT * FROM affiliates WHERE email = ?').get(email);
  const bad = () => res.status(401).json({ error: 'Wrong email or password.' });
  if (!affiliate) return bad();
  const hash = hashPassword(password, affiliate.salt);
  if (!crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(affiliate.password_hash))) return bad();
  setCookie(res, 'ap_aff', sign({ role: 'affiliate', id: affiliate.id, exp: Date.now() + 30 * 864e5 }), 30 * 86400);
  res.json({ ok: true });
});

app.post('/api/affiliate/logout', (req, res) => {
  clearCookie(res, 'ap_aff');
  res.json({ ok: true });
});

app.get('/api/affiliate/me', requireAffiliate, (req, res) => {
  const a = req.affiliate;
  const stats = db.prepare(`
    SELECT COUNT(*) AS orders, COALESCE(SUM(amount_total), 0) AS sales, COALESCE(SUM(commission), 0) AS earned
    FROM orders WHERE affiliate_id = ?
  `).get(a.id);
  const orders = db.prepare(`
    SELECT id, amount_total, commission, created_at FROM orders
    WHERE affiliate_id = ? ORDER BY created_at DESC LIMIT 50
  `).all(a.id);
  const unread = db.prepare(
    "SELECT COUNT(*) AS c FROM messages WHERE affiliate_id = ? AND sender = 'admin' AND read_by_affiliate = 0"
  ).get(a.id).c;
  res.json({
    name: a.name, email: a.email, code: a.code, status: a.status,
    commission_pct: a.commission_pct, clicks: a.clicks,
    stats, orders, unread,
    payout_info: a.payout_info || '',
    link: `${currentDomain()}/?ref=${a.code}`
  });
});

// Change password
app.post('/api/affiliate/password', requireAffiliate, (req, res) => {
  const current = String(req.body.current || '');
  const next = String(req.body.next || '');
  const a = req.affiliate;
  const curHash = hashPassword(current, a.salt);
  if (!crypto.timingSafeEqual(Buffer.from(curHash), Buffer.from(a.password_hash))) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }
  if (next.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE affiliates SET password_hash = ?, salt = ? WHERE id = ?').run(hashPassword(next, salt), salt, a.id);
  res.json({ ok: true });
});

// Save payout details (Payoneer / Wise / bank)
app.post('/api/affiliate/payout-info', requireAffiliate, (req, res) => {
  const method = String(req.body.method || '').trim().slice(0, 40);
  const details = String(req.body.details || '').trim().slice(0, 1000);
  db.prepare('UPDATE affiliates SET payout_info = ? WHERE id = ?').run(JSON.stringify({ method, details }), req.affiliate.id);
  res.json({ ok: true });
});

// The affiliate's payouts
app.get('/api/affiliate/payouts', requireAffiliate, (req, res) => {
  const list = db.prepare('SELECT id, amount, method, note, status, created_at, paid_at FROM payouts WHERE affiliate_id = ? ORDER BY created_at DESC').all(req.affiliate.id);
  const paid = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM payouts WHERE affiliate_id = ? AND status = 'paid'").get(req.affiliate.id).s;
  const pending = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM payouts WHERE affiliate_id = ? AND status = 'pending'").get(req.affiliate.id).s;
  res.json({ list, paid, pending });
});

// Affiliate's own per-product prices (they may only mark up, floor = platform price)
app.get('/api/affiliate/prices', requireAffiliate, (req, res) => {
  const rows = db.prepare(`
    SELECT p.slug, p.name, p.image, p.price, p.sale_price,
           (SELECT price FROM affiliate_prices ap WHERE ap.affiliate_id = ? AND ap.product_slug = p.slug) AS my_price
    FROM products p WHERE p.active = 1 ORDER BY p.featured DESC, p.created_at DESC
  `).all(req.affiliate.id);
  res.json(rows.map((r) => ({
    slug: r.slug, name: r.name, image: r.image,
    platform_price: effectivePrice(r),   // the floor
    my_price: r.my_price || 0
  })));
});

app.post('/api/affiliate/prices', requireAffiliate, (req, res) => {
  const slug = String(req.body.slug || '');
  const product = db.prepare('SELECT * FROM products WHERE slug = ? AND active = 1').get(slug);
  if (!product) return res.status(404).json({ error: 'Product not found.' });
  const floor = effectivePrice(product);
  const price = Math.round(Number(req.body.price) || 0);
  if (price <= 0) {
    // clear → revert to platform price
    db.prepare('DELETE FROM affiliate_prices WHERE affiliate_id = ? AND product_slug = ?').run(req.affiliate.id, slug);
    return res.json({ ok: true, cleared: true });
  }
  if (price < floor) return res.status(400).json({ error: `Your price can't be below the platform price ($${(floor / 100).toFixed(2)}).` });
  db.prepare('INSERT OR REPLACE INTO affiliate_prices (affiliate_id, product_slug, price) VALUES (?, ?, ?)').run(req.affiliate.id, slug, price);
  res.json({ ok: true });
});

// The affiliate's clicks broken down by product
app.get('/api/affiliate/clicks', requireAffiliate, (req, res) => {
  const rows = db.prepare(`
    SELECT pv.path, pr.name AS product_name, COUNT(*) AS views
    FROM pageviews pv LEFT JOIN products pr ON ('/product/' || pr.slug) = pv.path
    WHERE pv.ref = ? AND pv.path LIKE '/product/%'
    GROUP BY pv.path ORDER BY views DESC LIMIT 100
  `).all(req.affiliate.code);
  res.json(rows);
});

// Period-filtered stats for the affiliate (Today / Yesterday / 7 days / custom)
app.get('/api/affiliate/stats', requireAffiliate, (req, res) => {
  const { from, to } = dateRange(req);
  const code = req.affiliate.code;
  const id = req.affiliate.id;
  const views = db.prepare('SELECT COUNT(*) AS c FROM pageviews WHERE ref = ? AND date(created_at) BETWEEN ? AND ?').get(code, from, to).c;
  const o = db.prepare('SELECT COUNT(*) AS orders, COALESCE(SUM(amount_total),0) AS sales, COALESCE(SUM(commission),0) AS earned FROM orders WHERE affiliate_id = ? AND date(created_at) BETWEEN ? AND ?').get(id, from, to);
  const conversion = views > 0 ? Math.round((o.orders / views) * 1000) / 10 : 0;
  const add_to_cart = db.prepare("SELECT COUNT(*) AS c FROM events WHERE type = 'add_to_cart' AND ref = ? AND date(created_at) BETWEEN ? AND ?").get(code, from, to).c;
  // Add-to-cart clicks per product, keyed by product slug so the client can
  // line them up next to the click counts.
  const cartRows = db.prepare(`
    SELECT e.slug, COUNT(*) AS adds FROM events e
    WHERE e.type = 'add_to_cart' AND e.ref = ? AND date(e.created_at) BETWEEN ? AND ?
    GROUP BY e.slug
  `).all(code, from, to);
  const carts_by_slug = {};
  cartRows.forEach((r) => { carts_by_slug[r.slug] = r.adds; });
  const by_product = db.prepare(`
    SELECT pv.path, pr.slug AS product_slug, COALESCE(pr.name, '📝 ' || po.title) AS product_name, COUNT(*) AS views
    FROM pageviews pv
    LEFT JOIN products pr ON ('/product/' || pr.slug) = pv.path
    LEFT JOIN posts po ON ('/blog/' || po.slug) = pv.path
    WHERE pv.ref = ? AND (pv.path LIKE '/product/%' OR pv.path LIKE '/blog/%')
      AND date(pv.created_at) BETWEEN ? AND ?
    GROUP BY pv.path ORDER BY views DESC LIMIT 100
  `).all(code, from, to).map((r) => ({ ...r, adds: carts_by_slug[r.product_slug] || 0 }));
  res.json({ from, to, views, orders: o.orders, sales: o.sales, earned: o.earned, conversion, add_to_cart, by_product });
});

// Marketing assets the affiliate can download / copy
app.get('/api/affiliate/marketing', requireAffiliate, (req, res) => {
  res.json(db.prepare(`
    SELECT m.id, m.title, m.description, m.path, m.created_at, pr.name AS product_name
    FROM marketing_assets m LEFT JOIN products pr ON pr.slug = m.product_slug
    ORDER BY m.created_at DESC
  `).all());
});

/* ---------- Affiliate ↔ admin messaging ---------- */
app.get('/api/affiliate/messages', requireAffiliate, (req, res) => {
  const list = db.prepare('SELECT id, sender, body, created_at FROM messages WHERE affiliate_id = ? ORDER BY created_at').all(req.affiliate.id);
  // Viewing the thread clears the affiliate's unread notifications.
  db.prepare("UPDATE messages SET read_by_affiliate = 1 WHERE affiliate_id = ? AND sender = 'admin'").run(req.affiliate.id);
  res.json(list);
});

app.post('/api/affiliate/messages', requireAffiliate, (req, res) => {
  const body = String(req.body.body || '').trim().slice(0, 2000);
  if (!body) return res.status(400).json({ error: 'Message cannot be empty.' });
  db.prepare("INSERT INTO messages (affiliate_id, sender, body, read_by_admin, read_by_affiliate) VALUES (?, 'affiliate', ?, 0, 1)").run(req.affiliate.id, body);
  res.json({ ok: true });
});

/* ============================================================
   ADMIN API
   ============================================================ */
app.post('/api/admin/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const grant = () => {
    setCookie(res, 'ap_admin', sign({ role: 'admin', exp: Date.now() + 7 * 864e5 }), 7 * 86400);
    res.json({ ok: true });
  };

  // Admin account login (email + password)
  const admin = email ? db.prepare('SELECT * FROM admin_users WHERE email = ?').get(email) : null;
  if (admin) {
    const hash = hashPassword(password, admin.salt);
    if (crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(admin.password_hash))) return grant();
  }

  // Fallback: master password from .env (works with any/empty email)
  if (ADMIN_PASSWORD && password) {
    const given = crypto.createHash('sha256').update(password).digest();
    const expected = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
    if (crypto.timingSafeEqual(given, expected)) return grant();
  }

  res.status(401).json({ error: 'Wrong email or password.' });
});

app.post('/api/admin/logout', (req, res) => {
  clearCookie(res, 'ap_admin');
  res.json({ ok: true });
});

/* ---------- Settings (Stripe + site URL) ---------- */
function maskKey(k) {
  if (!k) return '';
  return k.slice(0, 8) + '••••••••' + k.slice(-4);
}
app.get('/api/admin/settings', requireAdmin, (req, res) => {
  const key = currentStripeKey();
  const fromDb = !!getSetting('stripe_secret_key');
  res.json({
    stripe_configured: !!key,
    stripe_masked: maskKey(key),
    stripe_mode: key.startsWith('sk_live') || key.startsWith('rk_live') ? 'live' : (key ? 'test' : ''),
    stripe_source: fromDb ? 'admin panel' : (key ? '.env file' : ''),
    domain: getSetting('domain'),
    effective_domain: currentDomain(),
    og_image: getSetting('og_image'),
    og_effective: siteOgImage()
  });
});

app.post('/api/admin/settings', requireAdmin, async (req, res) => {
  // Save the default social share image if provided
  if (typeof req.body.og_image === 'string') {
    setSetting('og_image', req.body.og_image.trim().slice(0, 300));
  }

  // Save the site URL if provided
  if (typeof req.body.domain === 'string') {
    let d = req.body.domain.trim().replace(/\/+$/, '').slice(0, 200);
    if (d && !/^https?:\/\//i.test(d)) return res.status(400).json({ error: 'Site URL must start with http:// or https://' });
    setSetting('domain', d);
  }

  // Save + verify the Stripe key if provided (empty string clears it → falls back to .env)
  if (typeof req.body.stripe_secret_key === 'string') {
    const key = req.body.stripe_secret_key.trim();
    if (key === '') {
      setSetting('stripe_secret_key', '');
      _stripeKeyUsed = null;
      return res.json({ ok: true, cleared: true });
    }
    if (!/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(key)) {
      return res.status(400).json({ error: 'That doesn\'t look like a Stripe secret key (should start with sk_test_ or sk_live_).' });
    }
    try {
      await Stripe(key).balance.retrieve(); // authenticates the key
    } catch (err) {
      return res.status(400).json({ error: 'Stripe rejected that key: ' + (err.message || 'invalid key') });
    }
    setSetting('stripe_secret_key', key);
    _stripeKeyUsed = null; // force rebuild of the client with the new key
    return res.json({ ok: true, mode: key.startsWith('sk_live') || key.startsWith('rk_live') ? 'live' : 'test' });
  }

  res.json({ ok: true });
});

app.get('/api/admin/summary', requireAdmin, (req, res) => {
  res.json({
    products: db.prepare('SELECT COUNT(*) AS c FROM products').get().c,
    categories: db.prepare('SELECT COUNT(*) AS c FROM categories').get().c,
    orders: db.prepare('SELECT COUNT(*) AS c FROM orders').get().c,
    revenue: db.prepare('SELECT COALESCE(SUM(amount_total), 0) AS s FROM orders').get().s,
    profit: db.prepare('SELECT COALESCE(SUM(profit), 0) AS s FROM orders').get().s,
    views: db.prepare('SELECT COUNT(*) AS c FROM pageviews').get().c,
    add_to_cart: db.prepare("SELECT COUNT(*) AS c FROM events WHERE type = 'add_to_cart'").get().c,
    commissions: db.prepare('SELECT COALESCE(SUM(commission), 0) AS s FROM orders').get().s,
    affiliates: db.prepare('SELECT COUNT(*) AS c FROM affiliates').get().c,
    pending_affiliates: db.prepare("SELECT COUNT(*) AS c FROM affiliates WHERE status = 'pending'").get().c,
    unread_messages: db.prepare("SELECT COUNT(*) AS c FROM messages WHERE sender = 'affiliate' AND read_by_admin = 0").get().c,
    unread_contact: db.prepare('SELECT COUNT(*) AS c FROM contact_messages WHERE read_by_admin = 0').get().c,
    new_requests: db.prepare('SELECT COUNT(*) AS c FROM contact_requests WHERE handled = 0').get().c,
    pending_payouts: db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM payouts WHERE status = 'pending'").get().s,
    recent_orders: db.prepare(`
      SELECT o.id, o.amount_total, o.customer_email, o.commission, o.created_at, a.name AS affiliate_name
      FROM orders o LEFT JOIN affiliates a ON a.id = o.affiliate_id
      ORDER BY o.created_at DESC LIMIT 8
    `).all()
  });
});

/* ---------- Products ---------- */
app.get('/api/admin/products', requireAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT p.*, c.name AS category_name FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    ORDER BY p.created_at DESC
  `).all());
});

function productFields(body) {
  let rawImages = body.images;
  if (typeof rawImages === 'string') {
    try { rawImages = JSON.parse(rawImages); } catch { rawImages = []; }
  }
  const images = Array.isArray(rawImages)
    ? rawImages.map((s) => String(s).trim().slice(0, 300)).filter(Boolean).slice(0, 12)
    : [];
  return {
    name: String(body.name || '').trim().slice(0, 120),
    description: String(body.description || '').trim().slice(0, 400),
    long_description: String(body.long_description || '').trim().slice(0, 5000),
    price: Math.max(Math.round(Number(body.price) || 0), 0),
    sale_price: Math.max(Math.round(Number(body.sale_price) || 0), 0),
    cost: Math.max(Math.round(Number(body.cost) || 0), 0),
    image: String(body.image || '').trim().slice(0, 300),
    images: JSON.stringify(images),
    options: JSON.stringify(sanitizeOptions(body.options)),
    badge: String(body.badge || '').trim().slice(0, 20),
    category_id: body.category_id ? Number(body.category_id) : null,
    featured: body.featured ? 1 : 0,
    active: body.active ? 1 : 0
  };
}

// Reject a sale price that isn't actually a discount.
function validatePrices(f) {
  if (f.price <= 0) return 'Price must be greater than 0.';
  if (f.sale_price && f.sale_price >= f.price) return 'Sale price must be lower than the regular price.';
  return null;
}

app.post('/api/admin/products', requireAdmin, (req, res) => {
  const f = productFields(req.body);
  if (!f.name) return res.status(400).json({ error: 'Product name is required.' });
  const priceErr = validatePrices(f);
  if (priceErr) return res.status(400).json({ error: priceErr });
  const slug = uniqueProductSlug(slugify(f.name));
  db.prepare(`
    INSERT INTO products (slug, name, description, long_description, price, sale_price, cost, image, images, options, badge, category_id, featured, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(slug, f.name, f.description, f.long_description, f.price, f.sale_price, f.cost, f.image, f.images, f.options, f.badge, f.category_id, f.featured, f.active);
  res.json({ ok: true, slug });
});

app.put('/api/admin/products/:slug', requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT slug FROM products WHERE slug = ?').get(req.params.slug);
  if (!existing) return res.status(404).json({ error: 'Product not found.' });
  const f = productFields(req.body);
  if (!f.name) return res.status(400).json({ error: 'Product name is required.' });
  const priceErr = validatePrices(f);
  if (priceErr) return res.status(400).json({ error: priceErr });
  db.prepare(`
    UPDATE products SET name = ?, description = ?, long_description = ?, price = ?, sale_price = ?, cost = ?, image = ?, images = ?, options = ?, badge = ?,
    category_id = ?, featured = ?, active = ? WHERE slug = ?
  `).run(f.name, f.description, f.long_description, f.price, f.sale_price, f.cost, f.image, f.images, f.options, f.badge, f.category_id, f.featured, f.active, req.params.slug);
  res.json({ ok: true });
});

app.delete('/api/admin/products/:slug', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM products WHERE slug = ?').run(req.params.slug);
  res.json({ ok: true });
});

/* ---------- Blog (admin) ---------- */
// Admin-authored HTML, but strip scripts/handlers anyway for safety.
function sanitizeHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript\s*:/gi, '')
    .slice(0, 200000);
}

const AD_STYLES = ['banner', 'grid2', 'grid3', 'strip', 'spotlight'];
function postFields(body) {
  let slugs = body.product_slugs;
  if (typeof slugs === 'string') { try { slugs = JSON.parse(slugs); } catch { slugs = []; } }
  if (!Array.isArray(slugs)) slugs = [];
  return {
    title: String(body.title || '').trim().slice(0, 160),
    excerpt: String(body.excerpt || '').trim().slice(0, 400),
    content: sanitizeHtml(body.content),
    cover: String(body.cover || '').trim().slice(0, 300),
    product_slugs: JSON.stringify(slugs.map((s) => String(s).slice(0, 60)).slice(0, 6)),
    ad_style: AD_STYLES.includes(body.ad_style) ? body.ad_style : 'banner',
    published: body.published ? 1 : 0
  };
}

app.get('/api/admin/posts', requireAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM pageviews pv WHERE pv.path = '/blog/' || p.slug) AS views
    FROM posts p ORDER BY p.created_at DESC
  `).all());
});

app.post('/api/admin/posts', requireAdmin, (req, res) => {
  const f = postFields(req.body);
  if (!f.title) return res.status(400).json({ error: 'Post title is required.' });
  let base = slugify(f.title);
  let slug = base, n = 2;
  while (db.prepare('SELECT 1 FROM posts WHERE slug = ?').get(slug)) slug = `${base}-${n++}`;
  db.prepare(`
    INSERT INTO posts (slug, title, excerpt, content, cover, product_slugs, ad_style, published)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(slug, f.title, f.excerpt, f.content, f.cover, f.product_slugs, f.ad_style, f.published);
  res.json({ ok: true, slug });
});

app.put('/api/admin/posts/:slug', requireAdmin, (req, res) => {
  if (!db.prepare('SELECT 1 FROM posts WHERE slug = ?').get(req.params.slug)) return res.status(404).json({ error: 'Post not found.' });
  const f = postFields(req.body);
  if (!f.title) return res.status(400).json({ error: 'Post title is required.' });
  db.prepare(`
    UPDATE posts SET title = ?, excerpt = ?, content = ?, cover = ?, product_slugs = ?, ad_style = ?, published = ?, updated_at = datetime('now')
    WHERE slug = ?
  `).run(f.title, f.excerpt, f.content, f.cover, f.product_slugs, f.ad_style, f.published, req.params.slug);
  res.json({ ok: true });
});

app.delete('/api/admin/posts/:slug', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM posts WHERE slug = ?').run(req.params.slug);
  res.json({ ok: true });
});

/* ---------- Image upload (base64 from admin form) ---------- */
app.post('/api/admin/upload', requireAdmin, (req, res) => {
  const match = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(String(req.body.data || ''));
  if (!match) return res.status(400).json({ error: 'Only PNG, JPG or WEBP images are supported.' });
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > 4 * 1024 * 1024) return res.status(400).json({ error: 'Image too large (max 4MB).' });
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  const dir = path.join(__dirname, 'public', 'images', 'uploads');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filename = `prod-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(dir, filename), buffer);
  res.json({ ok: true, path: `/images/uploads/${filename}` });
});

/* ---------- Media library ---------- */
const UPLOAD_DIR = path.join(__dirname, 'public', 'images', 'uploads');

// Image paths referenced by a product (main image + gallery) — these are protected.
function productImagePaths() {
  const used = new Set();
  for (const r of db.prepare('SELECT image, images FROM products').all()) {
    if (r.image) used.add(r.image);
    try { (JSON.parse(r.images) || []).forEach((s) => used.add(s)); } catch {}
  }
  return used;
}
// Image paths referenced by a marketing asset.
function marketingImagePaths() {
  const used = new Set();
  for (const m of db.prepare('SELECT path FROM marketing_assets').all()) if (m.path) used.add(m.path);
  return used;
}
// Everything referenced anywhere — the pruner leaves these alone.
function usedImagePaths() {
  const used = productImagePaths();
  marketingImagePaths().forEach((p) => used.add(p));
  return used;
}

app.get('/api/admin/media', requireAdmin, (req, res) => {
  let files = [];
  if (fs.existsSync(UPLOAD_DIR)) {
    files = fs.readdirSync(UPLOAD_DIR).filter((f) => /\.(png|jpe?g|webp)$/i.test(f));
  }
  const prod = productImagePaths();
  const mkt = marketingImagePaths();
  const order = { product: 2, marketing: 1, unused: 0 };
  const list = files.map((f) => {
    const p = `/images/uploads/${f}`;
    let size = 0;
    try { size = fs.statSync(path.join(UPLOAD_DIR, f)).size; } catch {}
    const usage = prod.has(p) ? 'product' : (mkt.has(p) ? 'marketing' : 'unused');
    return { file: f, path: p, usage, used: usage === 'product', size };
  }).sort((a, b) => order[b.usage] - order[a.usage]);
  res.json(list);
});

app.post('/api/admin/media/delete', requireAdmin, (req, res) => {
  const file = path.basename(String(req.body.file || '')); // strip any path traversal
  if (!/^[\w.-]+\.(png|jpe?g|webp)$/i.test(file)) return res.status(400).json({ error: 'Invalid file name.' });
  const p = `/images/uploads/${file}`;
  if (productImagePaths().has(p)) return res.status(400).json({ error: 'This photo is used by a product. Remove it from the product first.' });
  // If a marketing card uses it, delete that card too.
  db.prepare('DELETE FROM marketing_assets WHERE path = ?').run(p);
  const full = path.join(UPLOAD_DIR, file);
  if (fs.existsSync(full)) fs.unlinkSync(full);
  res.json({ ok: true });
});

app.post('/api/admin/media/prune', requireAdmin, (req, res) => {
  if (!fs.existsSync(UPLOAD_DIR)) return res.json({ ok: true, deleted: 0 });
  const used = usedImagePaths(); // products + marketing — only truly orphaned files are pruned
  let deleted = 0;
  for (const f of fs.readdirSync(UPLOAD_DIR)) {
    if (!/\.(png|jpe?g|webp)$/i.test(f)) continue;
    if (!used.has(`/images/uploads/${f}`)) {
      try { fs.unlinkSync(path.join(UPLOAD_DIR, f)); deleted++; } catch {}
    }
  }
  res.json({ ok: true, deleted });
});

/* ---------- Categories ---------- */
app.get('/api/admin/categories', requireAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS product_count
    FROM categories c ORDER BY c.name
  `).all());
});

app.post('/api/admin/categories', requireAdmin, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Category name is required.' });
  let slug = slugify(name);
  let n = 2;
  while (db.prepare('SELECT 1 FROM categories WHERE slug = ?').get(slug)) slug = `${slugify(name)}-${n++}`;
  db.prepare('INSERT INTO categories (name, slug) VALUES (?, ?)').run(name, slug);
  res.json({ ok: true });
});

app.put('/api/admin/categories/:id', requireAdmin, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Category name is required.' });
  db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name, Number(req.params.id));
  res.json({ ok: true });
});

app.delete('/api/admin/categories/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  db.prepare('UPDATE products SET category_id = NULL WHERE category_id = ?').run(id);
  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  res.json({ ok: true });
});

/* ---------- Affiliates ---------- */
app.get('/api/admin/affiliates', requireAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT a.id, a.name, a.email, a.code, a.commission_pct, a.status, a.clicks, a.created_at, a.payout_info,
           COUNT(o.id) AS orders, COALESCE(SUM(o.amount_total), 0) AS sales, COALESCE(SUM(o.commission), 0) AS earned,
           (SELECT COALESCE(SUM(p.amount),0) FROM payouts p WHERE p.affiliate_id = a.id AND p.status = 'paid') AS paid_out
    FROM affiliates a LEFT JOIN orders o ON o.affiliate_id = a.id
    GROUP BY a.id ORDER BY a.created_at DESC
  `).all());
});

app.post('/api/admin/affiliates', requireAdmin, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 120);
  const password = String(req.body.password || '');
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid name and email.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (db.prepare('SELECT 1 FROM affiliates WHERE email = ?').get(email)) {
    return res.status(400).json({ error: 'An affiliate with this email already exists.' });
  }
  let pct = Number(req.body.commission_pct);
  if (!Number.isFinite(pct)) pct = 10;
  pct = Math.min(Math.max(pct, 0), 90);
  const status = ['pending', 'approved', 'suspended'].includes(req.body.status) ? req.body.status : 'approved';

  const salt = crypto.randomBytes(16).toString('hex');
  let code;
  do { code = 'AP' + crypto.randomBytes(3).toString('hex').toUpperCase(); }
  while (db.prepare('SELECT 1 FROM affiliates WHERE code = ?').get(code));

  db.prepare(
    'INSERT INTO affiliates (name, email, password_hash, salt, code, commission_pct, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(name, email, hashPassword(password, salt), salt, code, pct, status);

  res.json({ ok: true, code });
});

app.put('/api/admin/affiliates/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const affiliate = db.prepare('SELECT * FROM affiliates WHERE id = ?').get(id);
  if (!affiliate) return res.status(404).json({ error: 'Affiliate not found.' });
  const status = ['pending', 'approved', 'suspended'].includes(req.body.status) ? req.body.status : affiliate.status;
  let pct = Number(req.body.commission_pct);
  if (!Number.isFinite(pct)) pct = affiliate.commission_pct;
  pct = Math.min(Math.max(pct, 0), 90);
  db.prepare('UPDATE affiliates SET status = ?, commission_pct = ? WHERE id = ?').run(status, pct, id);
  res.json({ ok: true });
});

app.put('/api/admin/affiliates/:id/password', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM affiliates WHERE id = ?').get(id)) return res.status(404).json({ error: 'Affiliate not found.' });
  const next = String(req.body.password || '');
  if (next.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE affiliates SET password_hash = ?, salt = ? WHERE id = ?').run(hashPassword(next, salt), salt, id);
  res.json({ ok: true });
});

app.delete('/api/admin/affiliates/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  db.prepare('UPDATE orders SET affiliate_id = NULL WHERE affiliate_id = ?').run(id);
  db.prepare('DELETE FROM messages WHERE affiliate_id = ?').run(id);
  db.prepare('DELETE FROM affiliate_prices WHERE affiliate_id = ?').run(id);
  db.prepare('DELETE FROM affiliates WHERE id = ?').run(id);
  res.json({ ok: true });
});

/* ---------- Marketing assets ---------- */
app.get('/api/admin/marketing', requireAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT m.*, pr.name AS product_name FROM marketing_assets m
    LEFT JOIN products pr ON pr.slug = m.product_slug
    ORDER BY m.created_at DESC
  `).all());
});
app.post('/api/admin/marketing', requireAdmin, (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 120);
  const description = String(req.body.description || '').trim().slice(0, 1000);
  const productSlug = String(req.body.product_slug || '').trim().slice(0, 60);
  const path_ = String(req.body.path || '').trim().slice(0, 300);
  if (!path_) return res.status(400).json({ error: 'Please upload an image first.' });
  db.prepare('INSERT INTO marketing_assets (title, description, product_slug, path) VALUES (?, ?, ?, ?)').run(title, description, productSlug, path_);
  res.json({ ok: true });
});
app.delete('/api/admin/marketing/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM marketing_assets WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

/* ---------- Traffic / analytics ---------- */
app.get('/api/admin/traffic', requireAdmin, (req, res) => {
  const { from, to } = dateRange(req);
  const R = 'date(created_at) BETWEEN ? AND ?'; // range clause on pageviews/orders

  const total = db.prepare('SELECT COUNT(*) AS c FROM pageviews').get().c; // all-time
  const views = db.prepare(`SELECT COUNT(*) AS c FROM pageviews WHERE ${R}`).get(from, to).c;
  const via_affiliate = db.prepare(`SELECT COUNT(*) AS c FROM pageviews WHERE ${R} AND ref != ''`).get(from, to).c;
  const orders = db.prepare(`SELECT COUNT(*) AS c FROM orders WHERE ${R}`).get(from, to).c;
  const conversion = views > 0 ? Math.round((orders / views) * 1000) / 10 : 0;
  const add_to_cart = db.prepare(`SELECT COUNT(*) AS c FROM events WHERE type = 'add_to_cart' AND ${R}`).get(from, to).c;
  const cart_conversion = add_to_cart > 0 ? Math.round((orders / add_to_cart) * 1000) / 10 : 0;

  // Which products get added to the cart most (period), and via affiliate links
  const cart_by_product = db.prepare(`
    SELECT e.slug, COALESCE(pr.name, e.slug) AS product_name,
           COUNT(*) AS adds,
           SUM(CASE WHEN e.ref != '' THEN 1 ELSE 0 END) AS via_affiliate
    FROM events e LEFT JOIN products pr ON pr.slug = e.slug
    WHERE e.type = 'add_to_cart' AND date(e.created_at) BETWEEN ? AND ?
    GROUP BY e.slug ORDER BY adds DESC LIMIT 20
  `).all(from, to);

  const top_pages = db.prepare(`
    SELECT p.path, COUNT(*) AS views, COALESCE(pr.name, po.title) AS product_name
    FROM pageviews p
    LEFT JOIN products pr ON ('/product/' || pr.slug) = p.path
    LEFT JOIN posts po ON ('/blog/' || po.slug) = p.path
    WHERE date(p.created_at) BETWEEN ? AND ?
    GROUP BY p.path ORDER BY views DESC LIMIT 15
  `).all(from, to);
  const daily = db.prepare(`
    SELECT date(created_at) AS day, COUNT(*) AS views
    FROM pageviews WHERE ${R}
    GROUP BY day ORDER BY day
  `).all(from, to);
  const by_country = db.prepare(`
    SELECT country, COUNT(*) AS views FROM pageviews
    WHERE ${R} AND country != ''
    GROUP BY country ORDER BY views DESC LIMIT 30
  `).all(from, to);
  const unknown_country = db.prepare(`SELECT COUNT(*) AS c FROM pageviews WHERE ${R} AND country = ''`).get(from, to).c;
  const by_affiliate = db.prepare(`
    SELECT a.name, a.code, COUNT(p.id) AS views
    FROM affiliates a JOIN pageviews p ON p.ref = a.code
    WHERE date(p.created_at) BETWEEN ? AND ?
    GROUP BY a.id HAVING views > 0 ORDER BY views DESC LIMIT 15
  `).all(from, to);
  const affiliate_products = db.prepare(`
    SELECT a.name AS affiliate_name, a.code, pv.path,
           COALESCE(pr.name, '📝 ' || po.title) AS product_name, COUNT(*) AS views
    FROM pageviews pv
    JOIN affiliates a ON a.code = pv.ref
    LEFT JOIN products pr ON ('/product/' || pr.slug) = pv.path
    LEFT JOIN posts po ON ('/blog/' || po.slug) = pv.path
    WHERE pv.ref != '' AND (pv.path LIKE '/product/%' OR pv.path LIKE '/blog/%')
      AND date(pv.created_at) BETWEEN ? AND ?
    GROUP BY a.code, pv.path ORDER BY views DESC LIMIT 50
  `).all(from, to);
  res.json({ from, to, total, views, orders, conversion, add_to_cart, cart_conversion, cart_by_product, via_affiliate, top_pages, daily, by_country, unknown_country, by_affiliate, affiliate_products });
});

/* ---------- Payouts (admin side) ---------- */
app.get('/api/admin/payouts', requireAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT p.*, a.name AS affiliate_name, a.code AS affiliate_code
    FROM payouts p LEFT JOIN affiliates a ON a.id = p.affiliate_id
    ORDER BY p.created_at DESC LIMIT 300
  `).all());
});

app.post('/api/admin/payouts', requireAdmin, (req, res) => {
  const affiliateId = Number(req.body.affiliate_id);
  if (!db.prepare('SELECT 1 FROM affiliates WHERE id = ?').get(affiliateId)) return res.status(404).json({ error: 'Affiliate not found.' });
  const amount = Math.max(Math.round(Number(req.body.amount) || 0), 0);
  if (amount <= 0) return res.status(400).json({ error: 'Amount must be greater than 0.' });
  const method = String(req.body.method || '').trim().slice(0, 40);
  const note = String(req.body.note || '').trim().slice(0, 300);
  const status = req.body.status === 'paid' ? 'paid' : 'pending';
  const paidAt = status === 'paid' ? new Date().toISOString().slice(0, 16).replace('T', ' ') : '';
  db.prepare('INSERT INTO payouts (affiliate_id, amount, method, note, status, paid_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(affiliateId, amount, method, note, status, paidAt);
  res.json({ ok: true });
});

app.put('/api/admin/payouts/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const payout = db.prepare('SELECT * FROM payouts WHERE id = ?').get(id);
  if (!payout) return res.status(404).json({ error: 'Payout not found.' });
  const status = req.body.status === 'paid' ? 'paid' : 'pending';
  const paidAt = status === 'paid' ? (payout.paid_at || new Date().toISOString().slice(0, 16).replace('T', ' ')) : '';
  db.prepare('UPDATE payouts SET status = ?, paid_at = ? WHERE id = ?').run(status, paidAt, id);
  res.json({ ok: true });
});

app.delete('/api/admin/payouts/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM payouts WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

/* ---------- Affiliate applications (contact requests) ---------- */
app.get('/api/admin/contact-requests', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM contact_requests ORDER BY created_at DESC LIMIT 200').all());
});
app.put('/api/admin/contact-requests/:id', requireAdmin, (req, res) => {
  db.prepare('UPDATE contact_requests SET handled = 1 WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});
app.delete('/api/admin/contact-requests/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM contact_requests WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

/* ---------- Contact messages (admin side) ---------- */
app.get('/api/admin/contact-messages', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM contact_messages ORDER BY created_at DESC LIMIT 300').all());
});
app.put('/api/admin/contact-messages/:id/read', requireAdmin, (req, res) => {
  db.prepare('UPDATE contact_messages SET read_by_admin = 1 WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});
app.delete('/api/admin/contact-messages/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM contact_messages WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

/* ---------- Messaging (admin side) ---------- */
app.get('/api/admin/messages', requireAdmin, (req, res) => {
  // One row per affiliate that has a conversation, newest activity first.
  const threads = db.prepare(`
    SELECT a.id AS affiliate_id, a.name, a.email, a.code,
           (SELECT body FROM messages m WHERE m.affiliate_id = a.id ORDER BY m.created_at DESC LIMIT 1) AS last_body,
           (SELECT created_at FROM messages m WHERE m.affiliate_id = a.id ORDER BY m.created_at DESC LIMIT 1) AS last_at,
           (SELECT COUNT(*) FROM messages m WHERE m.affiliate_id = a.id AND m.sender = 'affiliate' AND m.read_by_admin = 0) AS unread
    FROM affiliates a
    WHERE EXISTS (SELECT 1 FROM messages m WHERE m.affiliate_id = a.id)
    ORDER BY last_at DESC
  `).all();
  res.json(threads);
});

app.get('/api/admin/messages/:affiliateId', requireAdmin, (req, res) => {
  const id = Number(req.params.affiliateId);
  const list = db.prepare('SELECT id, sender, body, created_at FROM messages WHERE affiliate_id = ? ORDER BY created_at').all(id);
  db.prepare("UPDATE messages SET read_by_admin = 1 WHERE affiliate_id = ? AND sender = 'affiliate'").run(id);
  res.json(list);
});

app.post('/api/admin/messages/:affiliateId', requireAdmin, (req, res) => {
  const id = Number(req.params.affiliateId);
  if (!db.prepare('SELECT 1 FROM affiliates WHERE id = ?').get(id)) return res.status(404).json({ error: 'Affiliate not found.' });
  const body = String(req.body.body || '').trim().slice(0, 2000);
  if (!body) return res.status(400).json({ error: 'Message cannot be empty.' });
  db.prepare("INSERT INTO messages (affiliate_id, sender, body, read_by_admin, read_by_affiliate) VALUES (?, 'admin', ?, 1, 0)").run(id, body);
  res.json({ ok: true });
});

/* ---------- Orders ---------- */
app.get('/api/admin/orders', requireAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT o.*, a.name AS affiliate_name, a.code AS affiliate_code
    FROM orders o LEFT JOIN affiliates a ON a.id = o.affiliate_id
    ORDER BY o.created_at DESC LIMIT 200
  `).all());
});

/* ============================================================
   Pages
   ============================================================ */
app.get('/product/:slug', async (req, res) => {
  const p = db.prepare(`
    SELECT p.*, c.name AS category_name FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.slug = ? AND p.active = 1
  `).get(req.params.slug);

  if (!p) {
    return res.status(404).type('html').send(renderPage('product.html', buildMetaTags({
      title: 'Product not found — American Pride Store',
      description: 'This product is no longer available.',
      url: absoluteUrl('/product/' + req.params.slug), image: siteOgImage()
    })));
  }

  const price = (effectivePrice(p) / 100).toFixed(2);
  const url = absoluteUrl('/product/' + p.slug);
  // Build a 1200x630 landscape share image from the product photo.
  let og = await ensureOgImage(p.image, p.slug + '-' + baseNoExt(p.image));
  if (!og) { const s = siteOgSource(); og = await ensureOgImage(s, 'home-' + baseNoExt(s)); }
  const img = og ? absoluteUrl(og) : rasterOrDefault(p.image);
  const desc = p.description || `${p.name} — premium patriotic merchandise from American Pride Store.`;
  const jsonld = {
    '@context': 'https://schema.org', '@type': 'Product',
    name: p.name, image: [img], description: desc, sku: p.slug,
    category: p.category_name || undefined,
    brand: { '@type': 'Brand', name: 'American Pride Store' },
    offers: { '@type': 'Offer', url, priceCurrency: 'usd'.toUpperCase(), price, availability: 'https://schema.org/InStock' }
  };
  const extra = `\n  <meta property="product:price:amount" content="${price}" />\n  <meta property="product:price:currency" content="USD" />`;
  res.type('html').send(renderPage('product.html', buildMetaTags({
    title: `${p.name} — American Pride Store`,
    description: desc, url, image: img, type: 'product', jsonld, extra
  })));
});

/* ---------- Blog pages (server-rendered meta) ---------- */
app.get('/blog', async (req, res) => {
  const src = siteOgSource();
  const og = await ensureOgImage(src, 'home-' + baseNoExt(src));
  res.type('html').send(renderPage('blog.html', buildMetaTags({
    title: 'Patriot Blog — American Pride Store',
    description: 'Stories, guides and news for true patriots — from the American Pride Store.',
    url: absoluteUrl('/blog'), image: absoluteUrl(og || src), type: 'website'
  })));
});

app.get('/blog/:slug', async (req, res) => {
  const p = db.prepare('SELECT * FROM posts WHERE slug = ? AND published = 1').get(req.params.slug);
  if (!p) {
    return res.status(404).type('html').send(renderPage('post.html', buildMetaTags({
      title: 'Post not found — American Pride Store',
      description: 'This article is no longer available.',
      url: absoluteUrl('/blog/' + req.params.slug), image: siteOgImage()
    })));
  }
  const url = absoluteUrl('/blog/' + p.slug);
  let og = await ensureOgImage(p.cover, 'post-' + p.slug + '-' + baseNoExt(p.cover));
  if (!og) { const s = siteOgSource(); og = await ensureOgImage(s, 'home-' + baseNoExt(s)); }
  const img = og ? absoluteUrl(og) : siteOgImage();
  const desc = p.excerpt || p.title;
  const jsonld = {
    '@context': 'https://schema.org', '@type': 'BlogPosting',
    headline: p.title, description: desc, image: [img],
    datePublished: p.created_at, dateModified: p.updated_at || p.created_at,
    author: { '@type': 'Organization', name: 'American Pride Store' },
    mainEntityOfPage: url
  };
  res.type('html').send(renderPage('post.html', buildMetaTags({
    title: `${p.title} — American Pride Store`,
    description: desc, url, image: img, type: 'article', jsonld
  })));
});

app.get('/contact', async (req, res) => {
  const src = siteOgSource();
  const og = await ensureOgImage(src, 'home-' + baseNoExt(src));
  res.type('html').send(renderPage('contact.html', buildMetaTags({
    title: 'Contact Us — American Pride Store',
    description: 'Questions about an order, shipping or our gear? Send us a message — we usually reply within 24 hours.',
    url: absoluteUrl('/contact'), image: absoluteUrl(og || src), type: 'website'
  })));
});

/* ---------- SEO: robots.txt + sitemap.xml ---------- */
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /admin/\nDisallow: /api/\n\nSitemap: ${absoluteUrl('/sitemap.xml')}\n`);
});
app.get('/sitemap.xml', (req, res) => {
  const base = currentDomain().replace(/\/+$/, '');
  const prods = db.prepare('SELECT slug FROM products WHERE active = 1').all();
  const posts = db.prepare('SELECT slug FROM posts WHERE published = 1').all();
  let urls = `<url><loc>${base}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>`;
  urls += `<url><loc>${base}/blog</loc><changefreq>daily</changefreq><priority>0.7</priority></url>`;
  urls += `<url><loc>${base}/contact</loc><changefreq>monthly</changefreq><priority>0.4</priority></url>`;
  for (const p of prods) urls += `<url><loc>${base}/product/${p.slug}</loc><changefreq>weekly</changefreq><priority>0.8</priority></url>`;
  for (const p of posts) urls += `<url><loc>${base}/blog/${p.slug}</loc><changefreq>weekly</changefreq><priority>0.6</priority></url>`;
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);
});

app.listen(PORT, () => {
  console.log(`🇺🇸 American Pride Store running at http://localhost:${PORT}`);
  console.log(`   Storefront: http://localhost:${PORT}`);
  console.log(`   Admin:      http://localhost:${PORT}/admin/`);
  console.log(`   Affiliates: http://localhost:${PORT}/affiliate/`);
  if (!currentStripeKey()) console.warn('⚠️  Stripe key not set — add it in Admin → Settings (or STRIPE_SECRET_KEY in .env).');
  if (!ADMIN_PASSWORD) console.warn('⚠️  ADMIN_PASSWORD is not set — the admin panel is locked until you add it to .env');
});
