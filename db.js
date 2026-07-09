const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'store.db'));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS categories (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT NOT NULL,
    slug  TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS products (
    slug             TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    description      TEXT DEFAULT '',
    long_description TEXT DEFAULT '',
    price            INTEGER NOT NULL,
    image            TEXT DEFAULT '',
    badge            TEXT DEFAULT '',
    category_id      INTEGER,
    featured         INTEGER DEFAULT 0,
    active           INTEGER DEFAULT 1,
    created_at       TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS affiliates (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL,
    email          TEXT NOT NULL UNIQUE,
    password_hash  TEXT NOT NULL,
    salt           TEXT NOT NULL,
    code           TEXT NOT NULL UNIQUE,
    commission_pct REAL DEFAULT 10,
    status         TEXT DEFAULT 'pending',
    clicks         INTEGER DEFAULT 0,
    created_at     TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS admin_users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    salt          TEXT NOT NULL,
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS orders (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id     TEXT UNIQUE,
    amount_total   INTEGER NOT NULL,
    currency       TEXT DEFAULT 'usd',
    customer_email TEXT DEFAULT '',
    affiliate_id   INTEGER,
    commission     INTEGER DEFAULT 0,
    profit         INTEGER DEFAULT 0,
    items_json     TEXT DEFAULT '[]',
    created_at     TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pending_checkouts (
    session_id TEXT PRIMARY KEY,
    ref        TEXT DEFAULT '',
    items_json TEXT DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS payouts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    affiliate_id INTEGER NOT NULL,
    amount       INTEGER NOT NULL,
    method       TEXT DEFAULT '',
    note         TEXT DEFAULT '',
    status       TEXT DEFAULT 'pending',
    created_at   TEXT DEFAULT (datetime('now')),
    paid_at      TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_payouts_aff ON payouts (affiliate_id);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS affiliate_prices (
    affiliate_id INTEGER NOT NULL,
    product_slug TEXT NOT NULL,
    price        INTEGER NOT NULL,
    PRIMARY KEY (affiliate_id, product_slug)
  );

  CREATE TABLE IF NOT EXISTS posts (
    slug          TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    excerpt       TEXT DEFAULT '',
    content       TEXT DEFAULT '',
    cover         TEXT DEFAULT '',
    product_slugs TEXT DEFAULT '[]',
    published     INTEGER DEFAULT 1,
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS marketing_assets (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    title        TEXT DEFAULT '',
    product_slug TEXT DEFAULT '',
    path         TEXT NOT NULL,
    created_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS contact_messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT DEFAULT '',
    email         TEXT DEFAULT '',
    subject       TEXT DEFAULT '',
    body          TEXT DEFAULT '',
    read_by_admin INTEGER DEFAULT 0,
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS contact_requests (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT DEFAULT '',
    email      TEXT DEFAULT '',
    body       TEXT DEFAULT '',
    handled    INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    affiliate_id       INTEGER NOT NULL,
    sender             TEXT NOT NULL,
    body               TEXT NOT NULL,
    read_by_admin      INTEGER DEFAULT 0,
    read_by_affiliate  INTEGER DEFAULT 0,
    created_at         TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_aff ON messages (affiliate_id);

  CREATE TABLE IF NOT EXISTS pageviews (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    path       TEXT NOT NULL,
    ref        TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_pageviews_created ON pageviews (created_at);
  CREATE INDEX IF NOT EXISTS idx_pageviews_path ON pageviews (path);
`);

/* ---------- Migrations for older databases ---------- */
const productColumns = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name);
if (!productColumns.includes('images')) {
  db.exec("ALTER TABLE products ADD COLUMN images TEXT DEFAULT '[]'");
}
if (!productColumns.includes('sale_price')) {
  db.exec('ALTER TABLE products ADD COLUMN sale_price INTEGER DEFAULT 0');
}
if (!productColumns.includes('cost')) {
  db.exec('ALTER TABLE products ADD COLUMN cost INTEGER DEFAULT 0');
}
if (!productColumns.includes('options')) {
  db.exec("ALTER TABLE products ADD COLUMN options TEXT DEFAULT '[]'");
}
const affColumns = db.prepare('PRAGMA table_info(affiliates)').all().map((c) => c.name);
if (!affColumns.includes('payout_info')) {
  db.exec("ALTER TABLE affiliates ADD COLUMN payout_info TEXT DEFAULT ''");
}
const marketingColumns = db.prepare('PRAGMA table_info(marketing_assets)').all().map((c) => c.name);
if (!marketingColumns.includes('description')) {
  db.exec("ALTER TABLE marketing_assets ADD COLUMN description TEXT DEFAULT ''");
}
const postColumns = db.prepare('PRAGMA table_info(posts)').all().map((c) => c.name);
if (!postColumns.includes('ad_style')) {
  db.exec("ALTER TABLE posts ADD COLUMN ad_style TEXT DEFAULT 'banner'");
}
const orderColumns = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
if (!orderColumns.includes('profit')) {
  db.exec('ALTER TABLE orders ADD COLUMN profit INTEGER DEFAULT 0');
}
if (!orderColumns.includes('customer_phone')) {
  db.exec("ALTER TABLE orders ADD COLUMN customer_phone TEXT DEFAULT ''");
}

/* ---------- One-time seed from products.json ---------- */
const productCount = db.prepare('SELECT COUNT(*) AS c FROM products').get().c;
if (productCount === 0) {
  const seedCategories = [
    { name: 'Hats', slug: 'hats' },
    { name: 'Apparel', slug: 'apparel' },
    { name: 'Flags & Banners', slug: 'flags-banners' },
    { name: 'Drinkware', slug: 'drinkware' },
    { name: 'Accessories', slug: 'accessories' }
  ];
  const insCat = db.prepare('INSERT INTO categories (name, slug) VALUES (?, ?)');
  const catId = {};
  for (const c of seedCategories) {
    catId[c.slug] = insCat.run(c.name, c.slug).lastInsertRowid;
  }

  const categoryOf = {
    'maga-hat-red': 'hats',
    'trump-tee-2024': 'apparel',
    'freedom-hoodie': 'apparel',
    'american-flag-xl': 'flags-banners',
    'trump-flag-banner': 'flags-banners',
    'trump-mug': 'drinkware',
    'patriot-sticker-pack': 'accessories',
    'gold-coin-trump': 'accessories'
  };
  const featured = new Set(['maga-hat-red', 'trump-tee-2024', 'freedom-hoodie', 'gold-coin-trump']);
  const longDesc = {
    'maga-hat-red':
      'The hat that started a movement. Structured 6-panel crown, adjustable brass buckle strap and dense premium embroidery that keeps its shape wash after wash.\n\nEvery cap is cut, stitched and embroidered in American workshops. One size fits most.',
    'trump-tee-2024':
      'Heavyweight 100% American-grown cotton with a bold, crack-resistant front print. Pre-shrunk, true to size, with a reinforced collar that holds up to years of wear.\n\nAvailable while stocks last — this print run is limited.',
    'american-flag-xl':
      'A 3x5 ft American flag built for real weather. Dense 210D oxford nylon, double-stitched fly ends, embroidered stars and solid brass grommets.\n\nFlies beautifully in light wind and stands up to sun, rain and snow.',
    'trump-mug':
      'Start every morning like a winner. 15oz ceramic mug with a rich gold-tone print on both sides. Dishwasher and microwave safe.\n\nShips in a protective double-wall box so it arrives perfect.',
    'freedom-hoodie':
      'Our heaviest fleece — a 420gsm cotton blend hoodie with a soaring eagle chest print, double-lined hood, and a front pouch pocket.\n\nRuns true to size with a relaxed athletic fit. Machine washable.',
    'trump-flag-banner':
      'Double-sided 3x5 ft banner flag printed with UV-stable inks that resist fading season after season. Reinforced header strip with two brass grommets.\n\nPerfect for porches, boats, trucks and rallies.',
    'patriot-sticker-pack':
      'Ten die-cut vinyl stickers with a weatherproof laminate. They survive car washes, coolers, rain and sun without peeling or fading.\n\nSizes range from 2 to 4 inches.',
    'gold-coin-trump':
      'A collector-grade commemorative coin, gold-plated and detailed on both faces, delivered in a crystal-clear protective display capsule.\n\nA striking gift for any patriot — limited mintage.'
  };

  const seedProducts = JSON.parse(fs.readFileSync(path.join(__dirname, 'products.json'), 'utf8'));
  const insProd = db.prepare(`
    INSERT INTO products (slug, name, description, long_description, price, image, badge, category_id, featured, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);
  for (const p of seedProducts) {
    insProd.run(
      p.id,
      p.name,
      p.description,
      longDesc[p.id] || p.description,
      p.price,
      p.image,
      p.badge || '',
      catId[categoryOf[p.id]] || null,
      featured.has(p.id) ? 1 : 0
    );
  }
  console.log('🌱 Seeded database with starter categories and products');
}

module.exports = db;
