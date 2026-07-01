# Brand rollout — implementation handoff

Roll out the new MACPrep "pulse-tile" logo across the website and Stripe. All source assets are in
`brand/` and `brand/social/` (SVG = source of truth). Colors/type in `brand/BRAND.md`.

## 1. Export the PNGs (SVGs don't cover every slot; platforms want raster)
The pulse **mark** (`brand/macprep-mark.svg`) is font-free — exports cleanly. The horizontal logo and
og-image use Figtree, so export them via a browser/Figma (fonts load) or outline the text first.

- From `macprep-mark.svg` → `favicon-16.png`, `favicon-32.png`, `favicon-48.png`, `favicon.ico`
  (bundle 16/32/48), `apple-touch-icon.png` (180×180), `icon-192.png`, `icon-512.png`.
- From `macprep-logo-horizontal.svg` → `logo.png` (transparent, ~600px wide) for Stripe invoices.
- From `brand/social/og-image.svg` → `og-image.png` (1200×630).

## 2. Website (`index.html` head + header)
- Head:
  ```html
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" type="image/svg+xml" href="/brand/macprep-mark.svg">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <meta name="theme-color" content="#146A4A">
  <meta property="og:image" content="https://www.macprep.org/og-image.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="https://www.macprep.org/og-image.png">
  ```
- If there's a web manifest, point its icons at `icon-192.png` + `icon-512.png`.
- Header logo: swap the current header mark for the new pulse mark (inline `macprep-mark.svg` or an
  `<img>`), keep the "MAC"(#0E1512)/"Prep"(#146A4A) wordmark. In dark mode use "MAC" #F5F7F5 / "Prep"
  #4FCC8E. (Or use `macprep-logo-horizontal.svg` for light and `-dark.svg` for dark, swapped by theme.)
- Replace any other old logo/favicon references site-wide. Keep the wordmark font as Figtree 800.

## 3. Stripe branding (Dashboard → Settings → Business → Branding — do in LIVE mode)
- **Icon** (shows in Checkout, customer portal, emails): upload the mark PNG, square, ≥128×128 — use
  `macprep-mark.svg` exported at 512×512.
- **Logo** (shows on invoices/receipts): upload `logo.png` (horizontal, transparent, light-friendly).
- **Brand color:** `#146A4A`
- **Accent color:** `#2FA36B`
- Repeat in test mode if you use it. (Optional API route: Account `settings.branding.icon`/`.logo` via
  Files API + `primary_color`/`secondary_color`.)

## 4. Verify
- Hard-refresh a tab → new favicon shows.
- Paste a macprep.org link into LinkedIn/Facebook/iMessage → OG card shows the new share image (use a
  link-preview debugger to bust cache).
- Run a $0 promo-code checkout → new icon + brand color on the Stripe Checkout page.
- Generate an invoice/receipt → logo appears.

_Note: this is branding only — the code-redemption flow (dashboard "Have a class or cohort code?" box +
the Stripe "Add promotion code" field) is unchanged._
