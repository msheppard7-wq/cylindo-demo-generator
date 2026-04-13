This folder is a STATIC copy of the Cylindo product demo (templates + config).

Why the live site did not update
-------------------------------
The Vercel project cylindo-demo-haverty-s was connected to this Git repo with the
DEFAULT ROOT, so Vercel serves public/index.html — the "Cylindo Demo Generator"
landing page — NOT this PDP.

Fix in Vercel (one time)
------------------------
1. Open the cylindo-demo-haverty-s project on vercel.com
2. Settings → General → Root Directory → set to:  demo-sites/haverty-s
3. Framework Preset: Other (static HTML)
4. Build Command: (leave empty)
5. Output Directory: .   (or leave default)
6. Save → Redeploy

Cylindo credentials
-------------------
Edit config.json in this folder:
- Replace REPLACE_CYLINDO_CUSTOMER_ID with your CMS account number
- Replace REPLACE_CURATOR_CODE with your published Curator remote-config code

Then replace the "features" / "options" block with values from the Content API
for product code E80I3SS (or regenerate once via Slack and paste products[] +
cylindo from the deployment).

Keeping in sync with templates
-------------------------------
From repo root:
  cp templates/index.html templates/styles.css templates/app.js demo-sites/haverty-s/

Then commit and push.
