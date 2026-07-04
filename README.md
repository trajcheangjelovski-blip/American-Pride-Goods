# 🇺🇸 American Pride Store

Patriotic e-commerce website with **Stripe** checkout, a **Shopify-style admin panel**
and a built-in **affiliate program**.

## The three parts of your store

| URL | What it is |
|---|---|
| `http://localhost:4242/` | **Storefront** — what customers see |
| `http://localhost:4242/admin/` | **Admin panel** — manage products, categories, affiliates, orders |
| `http://localhost:4242/affiliate/` | **Affiliate portal** — partners sign up and get their referral link |

## Quick start

1. Install dependencies (already done): `npm install`
2. Open `.env` and set:
   - `STRIPE_SECRET_KEY` — from https://dashboard.stripe.com/apikeys
     (use `sk_test_...` while testing, `sk_live_...` in production)
   - `ADMIN_PASSWORD` — **change it** to your own strong password
3. Start the site: `npm start` → open http://localhost:4242

## Testing payments

With a test Stripe key, pay with card `4242 4242 4242 4242`,
any future expiry, any CVC, any ZIP.

## Admin panel (`/admin`)

Log in with your admin account (email + password) or the `ADMIN_PASSWORD` from `.env`. You can:

- **Products** — add/edit/delete, set price, **sale price** (a discount; the homepage shows the
  struck-through original + a −% badge), **cost / buying price** (private; what you pay on
  AliExpress — used for profit-based affiliate commission), badge (NEW / HOT / BEST SELLER /
  LIMITED / SALE), a **main photo + gallery photos** (PNG/JPG/WEBP), **options & add-ons**
  (e.g. Size / Color as "choose one", or extras as multi-select add-ons — each choice can add
  to the price), and toggles for **Featured on homepage** and **Visible in store**.
- **Categories** — create/rename/delete; the homepage gets a filter tab per category automatically.
- **Media** — every uploaded photo, marked **USED** or **UNUSED**. Delete individual unused
  photos or click **Delete all unused** to clean house.
- **Traffic** — site-wide page views: total, today, last 7 days (bar chart), how many came
  through affiliate links, most-viewed pages, views per affiliate link, and the **conversion
  rate** (orders ÷ views) for the whole platform. Every storefront page load is counted
  automatically (admin/API pages are excluded).

### Conversion rate
- **Platform** (Traffic view): orders ÷ total page views.
- **Per affiliate** (Affiliates table, "Conv." column): their orders ÷ their link clicks.
- **Each affiliate** sees their own conversion rate on their dashboard.
- **Affiliates** — **create accounts yourself** (name, email, password, commission %), approve
  applicants, change each one's **commission %**, suspend or delete them.
- **Orders** — every paid Stripe order with customer email, the exact items **and chosen options**
  (size/color — what to order from your supplier), total, **profit**, and affiliate commission.

### Product options / variants
Add an "option group" per product. Two types:
- **Choose one** (e.g. Size, Color) — the customer must pick one; each choice can add a surcharge
  (e.g. XXL +$3.00).
- **Add-ons** — optional multi-select extras (e.g. Gift box +$3.00).
Prices update live on the product page as the customer chooses, and the chosen options travel
all the way into the order so you know exactly what to ship.

### Discounts
Set a **sale price** lower than the regular price. Storefront cards and the product page show the
discount and the savings %. Checkout always charges the sale price (validated server-side).

### Affiliate commission on PROFIT
Commission is paid on **profit = (sale price − your cost) per item**, not on the full sale.
Set each product's **cost** so this is accurate. If you leave cost at 0, commission falls back to
the full sale price. Set each affiliate's % in the admin panel.

## Affiliate program (`/affiliate`)

1. A partner signs up at `/affiliate/` → account starts as **pending**.
2. You approve them in **Admin → Affiliates** and set the commission % you agreed on.
3. They share their personal link (e.g. `https://yourstore.com/?ref=AP1A2B3C`).
4. Visits are tracked for **30 days** — when a referred visitor pays, the order is
   recorded with the affiliate's commission automatically.
5. Their dashboard shows clicks, orders, sales and earnings live.
   Payouts to affiliates are made by you manually (bank/PayPal), per your agreement.

## Data & files

```
server.js            → Express server, Stripe checkout, all APIs
db.js                → SQLite database (auto-created in data/store.db)
data/store.db        → your live data — BACK THIS UP
products.json        → only used to seed the database on first run
.env                 → secret keys (never share or commit)
public/
  index.html         → storefront homepage
  product.html       → product detail page (/product/<slug>)
  admin/             → admin panel
  affiliate/         → affiliate portal
  images/uploads/    → photos uploaded via the admin panel
```

## Deploying (moving to a server)

The **code** lives in git. Your **live data is NOT in git** and must be copied to the
server separately (it's intentionally kept private):

- `data/store.db` — all your products, categories, affiliates, orders, payouts,
  messages, and the Stripe key you saved in the admin panel.
- `public/images/uploads/` — your uploaded product photos and marketing images.

On a fresh server with no `data/store.db`, the app re-seeds the placeholder demo
products from `products.json`. To bring your real store over, copy those two paths
to the server after deploying the code. Also create a `.env` from `.env.example`.

## Going live

1. Deploy to any Node.js host (Render, Railway, Heroku, a VPS…). Node 22.5+ required (for SQLite).
2. Set environment variables on the host: `STRIPE_SECRET_KEY` (live key),
   `DOMAIN` (e.g. `https://www.yourstore.com`), `ADMIN_PASSWORD`, `SESSION_SECRET`.
3. Activate your Stripe account (business details + bank account) to accept real payments.
4. Recommended once live: add a Stripe **webhook** for `checkout.session.completed`
   as a backup way to record orders (currently orders are recorded when the
   customer lands on the success page, which covers the normal flow).
