Vercel setup for cylindo-demo-quince

1) In Vercel project settings, set Root Directory to:
   demo-sites/quince

2) Framework preset:
   Other (static)

3) Update demo-sites/quince/config.json:
   - cylindo.customerId
   - cylindo.remoteConfig
   - products[0].code

4) Redeploy.

Notes:
- This folder uses the latest shared templates and includes:
  - Quince-style header variant
  - left-side Curator image carousel
  - color swatch circles
- Keep in sync with templates after future updates:
  cp templates/index.html demo-sites/quince/index.html
  cp templates/styles.css demo-sites/quince/styles.css
  cp templates/app.js demo-sites/quince/app.js
