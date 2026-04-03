/* ============================================
   Slack Slash Command Handler
   /cylindo-demo [customer-id] "[product-codes]" [curator-code] "[brand-name]"

   Receives Slack command → fetches from Content API →
   deploys demo site to Vercel → posts URL back to Slack
   ============================================ */

const https = require('https');

// ---- Config ----
const CONTENT_API = 'https://content.cylindo.com/api/v2';
const VERCEL_API = 'https://api.vercel.com';
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID || '';

// ---- HTTP Helpers ----

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Accept: 'application/json' } }, (res) => {
      if (res.statusCode === 404) return resolve(null);
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    }).on('error', reject);
  });
}

function httpRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const opts = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'POST',
      headers: options.headers || {},
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// ---- Slack Helpers ----

async function slackRespond(responseUrl, message) {
  await httpRequest(responseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, JSON.stringify(message));
}

// ---- Content API ----

async function fetchProductConfig(customerId, productCode) {
  const encoded = encodeURIComponent(productCode);
  const url = `${CONTENT_API}/${customerId}/products/${encoded}/configuration`;
  return await fetchJSON(url);
}

function extractFeatures(configData) {
  const features = [];
  if (!configData || !configData.features) return features;
  for (const feature of configData.features) {
    const featureCode = feature.code || feature.name || 'UNKNOWN';
    const options = [];
    if (feature.options) {
      for (const opt of feature.options) {
        options.push({
          name: formatName(opt.name || opt.code || String(opt)),
          value: opt.code || opt.name || String(opt),
        });
      }
    }
    features.push({ code: featureCode, label: formatName(featureCode), options });
  }
  return features;
}

function formatName(name) {
  if (!name) return 'Unknown';
  return name.split(/[\s_-]+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ').trim();
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// ---- Site Generator ----

function buildConfig(customerId, curatorCode, brandName, products) {
  return {
    brand: {
      name: brandName,
      logoText: brandName,
      tagline: 'Cylindo 3D Product Visualization Demo',
      website: '#',
      announcementText: `Cylindo 3D Product Visualization Demo — ${brandName}`,
      navLinks: ['Living', 'Bedroom', 'Dining', 'Outdoor', 'Sale'],
      navHighlight: 'Living',
      footerCopyright: `${brandName} — Cylindo Demo`,
      footerColumns: [
        { title: 'Customer Care', links: ['Contact Us', 'Shipping & Returns', 'FAQ', 'Design Services'] },
        { title: 'About', links: ['Our Story', 'Design Philosophy', 'Sustainability', 'Careers'] },
        { title: 'Explore', links: ['New Arrivals', 'Best Sellers', 'Collections', 'Inspiration'] },
      ],
      theme: {
        fontHeading: "'Libre Baskerville', 'Georgia', serif",
        fontBody: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
        colorBg: '#ffffff',
        colorBgAlt: '#f7f5f0',
        colorText: '#2c3e50',
        colorTextSecondary: '#7a8a8e',
        colorAccent: '#2c5f7c',
        colorAccentHover: '#1e4a61',
        colorBorder: '#ddd8ce',
        colorSuccess: '#5a7c65',
      },
    },
    cylindo: { customerId, remoteConfig: curatorCode },
    products,
  };
}

function buildProduct(productCode, features) {
  const name = formatName(productCode);
  return {
    id: slugify(productCode),
    name,
    code: productCode,
    price: '$0.00',
    priceNote: 'Contact for pricing',
    rating: 4.8,
    reviewCount: 0,
    description: `Explore the ${name} in full 360° with Cylindo's interactive 3D viewer. Select different options to see the product update in real-time.`,
    badges: [{ text: 'Cylindo 3D', type: 'new' }],
    breadcrumb: ['Home', 'Products'],
    features,
    highlights: [
      { title: 'Interactive 3D', description: "Rotate, zoom, and explore every angle with Cylindo's 360° viewer." },
      { title: 'Real-Time Configuration', description: 'Select different options and watch the product update instantly.' },
      { title: 'Material Swatches', description: 'View accurate material representations pulled from Cylindo Content API.' },
      { title: 'Tear Sheet', description: 'Generate a downloadable tear sheet with current configuration.' },
      { title: 'Seamless Integration', description: 'This viewer integrates directly into any e-commerce platform.' },
    ],
    specs: [
      {
        group: 'Product Information',
        items: [
          ['Product Code', productCode],
          ['Available Options', `${features.reduce((sum, f) => sum + f.options.length, 0)} configurations`],
          ['3D Viewer', 'Cylindo Viewer v5'],
          ['Viewer Type', '360° + Zoom'],
        ],
      },
    ],
    faqs: [
      { q: 'What am I looking at?', a: 'This is a Cylindo-powered product demo showing how the 3D viewer integrates into a branded product page.' },
      { q: 'Can I interact with the 3D view?', a: 'Yes! Click and drag to rotate, scroll to zoom, and use the option selectors to change the product configuration in real-time.' },
      { q: 'How are the material swatches generated?', a: 'Swatches are pulled directly from the Cylindo Content API, ensuring they match the actual rendered materials.' },
      { q: 'What is the tear sheet?', a: 'Click "Download Tear Sheet" to generate a printable product sheet showing the current configuration with specs and swatches.' },
    ],
    leadTime: 'Demo product — contact for availability',
  };
}

// ---- Template Files (inlined for serverless) ----

function getIndexHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cylindo Demo</title>
  <link rel="preconnect" href="https://content.cylindo.com" crossorigin />
  <script type="module" src="https://viewer-cdn.cylindo.com/v1/index.mjs" async></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <div class="announcement-bar" id="announcement-bar"></div>
  <header class="site-header">
    <div class="header-inner">
      <a href="#" class="logo" id="logo"></a>
      <nav class="main-nav" id="main-nav"></nav>
      <div class="header-actions">
        <button class="icon-btn" aria-label="Search"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg></button>
        <button class="icon-btn" aria-label="Account"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></button>
        <button class="icon-btn cart-btn" aria-label="Cart"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg><span class="cart-count">0</span></button>
      </div>
    </div>
  </header>
  <div class="product-switcher" id="product-switcher"></div>
  <div class="breadcrumb"><div class="container" id="breadcrumb"></div></div>
  <main class="product-section">
    <div class="container product-grid">
      <div class="product-media">
        <div class="cylindo-wrapper" id="cylindo-container"></div>
        <button class="tearsheet-btn" id="tearsheet-btn" type="button">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><polyline points="9 15 12 18 15 15"/></svg>
          <span>Download Tear Sheet</span>
        </button>
      </div>
      <div class="product-info" id="product-info"></div>
    </div>
  </main>
  <section class="features-section"><div class="container"><h2 class="section-title">What Makes It Special</h2><div class="features-grid" id="features-grid"></div></div></section>
  <section class="specs-section"><div class="container"><h2 class="section-title">Specifications</h2><div class="specs-grid" id="specs-grid"></div></div></section>
  <section class="faq-section"><div class="container"><h2 class="section-title">Frequently Asked Questions</h2><div class="faq-list" id="faq-list"></div></div></section>
  <section class="cylindo-banner"><div class="container"><div class="cylindo-badge-large"><span class="powered-by">3D Product Visualization Powered by</span><span class="cylindo-brand">Cylindo</span></div><p>This demo showcases how Cylindo's interactive 3D viewer integrates seamlessly into a branded product page.</p></div></section>
  <footer class="site-footer"><div class="container footer-grid" id="footer-grid"></div><div class="footer-bottom"><p id="footer-copyright"></p></div></footer>
  <div class="tearsheet-overlay" id="tearsheet-overlay">
    <div class="tearsheet-modal" id="tearsheet-modal">
      <button class="tearsheet-close" id="tearsheet-close" type="button">&times;</button>
      <div class="tearsheet-actions"><button class="tearsheet-print-btn" id="tearsheet-print-btn" type="button"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg> Print / Save as PDF</button></div>
      <div class="tearsheet-content" id="tearsheet-content"></div>
    </div>
  </div>
  <script src="app.js"></script>
</body>
</html>`;
}

// ---- Vercel Deployment ----

async function deployToVercel(projectName, files) {
  const teamParam = VERCEL_TEAM_ID ? `?teamId=${VERCEL_TEAM_ID}` : '';

  const deployment = await httpRequest(
    `${VERCEL_API}/v13/deployments${teamParam}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${VERCEL_TOKEN}`,
        'Content-Type': 'application/json',
      },
    },
    JSON.stringify({
      name: projectName,
      files: files.map((f) => ({
        file: f.path,
        data: Buffer.from(f.content).toString('base64'),
        encoding: 'base64',
      })),
      projectSettings: {
        framework: null,
      },
      target: 'production',
    })
  );

  return deployment;
}

// ---- Parse Slack Command Text ----

function parseSlackText(text) {
  // Format: [customer-id] "[product-codes]" [curator-code] "[brand-name]"
  // Or:     [customer-id] [product-code] [curator-code] [brand-name]
  const parts = [];
  let current = '';
  let inQuotes = false;

  for (const char of text) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ' ' && !inQuotes) {
      if (current) parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current) parts.push(current);

  if (parts.length < 3) return null;

  return {
    customer: parts[0],
    products: parts[1].split(',').map((p) => p.trim()),
    curator: parts[2],
    brand: parts[3] || 'Demo',
  };
}

// ---- Main Handler ----

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { text, response_url, user_name } = req.body;

  // Parse the command
  const parsed = parseSlackText(text || '');
  if (!parsed) {
    return res.status(200).json({
      response_type: 'ephemeral',
      text: [
        '*Usage:* `/cylindo-demo [customer-id] "[product-codes]" [curator-code] "[brand-name]"`',
        '',
        '*Example:*',
        '`/cylindo-demo 4404 "HAVEN COMFORT ARM SOFA,NORFOLK WIDE ARM PLEATED SOFA" a7ap4vak "Serena & Lily"`',
        '',
        '*Arguments:*',
        '• `customer-id` — Cylindo account number (from CMS Settings)',
        '• `product-codes` — Comma-separated product codes (wrap in quotes if multiple)',
        '• `curator-code` — Curator remote-config code',
        '• `brand-name` — Display name for the demo (wrap in quotes if spaces)',
      ].join('\n'),
    });
  }

  // Immediately acknowledge (Slack requires response within 3 seconds)
  res.status(200).json({
    response_type: 'in_channel',
    text: `:hourglass_flowing_sand: *Generating demo for ${parsed.brand}...*\nRequested by @${user_name}\n\n:satellite: Fetching product data from Cylindo Content API...`,
  });

  // Do the actual work asynchronously
  try {
    // Fetch product configs from Content API
    const products = [];
    const statusParts = [];

    for (const code of parsed.products) {
      const configData = await fetchProductConfig(parsed.customer, code);
      const features = extractFeatures(configData);
      const product = buildProduct(code, features);
      products.push(product);

      const totalOptions = features.reduce((sum, f) => sum + f.options.length, 0);
      statusParts.push(`• *${formatName(code)}*: ${features.length} feature group(s), ${totalOptions} options`);
    }

    // Build config
    const config = buildConfig(parsed.customer, parsed.curator, parsed.brand, products);

    // Read template files from the templates directory
    // For serverless, we inline the critical files and fetch others from GitHub
    const fs = require('fs');
    const path = require('path');

    let stylesCSS, appJS;
    try {
      // Try reading from local templates (works in development)
      stylesCSS = fs.readFileSync(path.join(process.cwd(), 'templates', 'styles.css'), 'utf-8');
      appJS = fs.readFileSync(path.join(process.cwd(), 'templates', 'app.js'), 'utf-8');
    } catch {
      // Fallback: fetch from GitHub raw
      const baseUrl = 'https://raw.githubusercontent.com/msheppard7-wq/cylindo-demo-generator/main/templates';
      const [cssRes, jsRes] = await Promise.all([fetchRawText(`${baseUrl}/styles.css`), fetchRawText(`${baseUrl}/app.js`)]);
      stylesCSS = cssRes;
      appJS = jsRes;
    }

    // Prepare deployment files
    const slug = slugify(parsed.brand);
    const projectName = `cylindo-demo-${slug}`;

    const files = [
      { path: 'index.html', content: getIndexHTML() },
      { path: 'styles.css', content: stylesCSS },
      { path: 'app.js', content: appJS },
      { path: 'config.json', content: JSON.stringify(config, null, 2) },
    ];

    // Deploy to Vercel
    const deployment = await deployToVercel(projectName, files);

    let demoUrl = '';
    if (deployment.status === 200 || deployment.status === 201) {
      demoUrl = deployment.data.url
        ? `https://${deployment.data.url}`
        : `https://${projectName}.vercel.app`;
    }

    // Post result back to Slack
    await slackRespond(response_url, {
      response_type: 'in_channel',
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: `✅ Demo Ready: ${parsed.brand}` },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: [
              `*Customer ID:* ${parsed.customer}`,
              `*Curator Code:* ${parsed.curator}`,
              `*Products:*`,
              ...statusParts,
              '',
              `:rocket: *Demo URL:* <${demoUrl}|${demoUrl}>`,
              `:page_facing_up: Tear sheet available on the demo page`,
            ].join('\n'),
          },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `Generated by @${user_name} via Cylindo Demo Generator`,
            },
          ],
        },
      ],
    });
  } catch (error) {
    // Post error back to Slack
    await slackRespond(response_url, {
      response_type: 'ephemeral',
      text: `:x: *Error generating demo:*\n\`\`\`${error.message}\`\`\`\n\nPlease check your inputs and try again.`,
    });
  }
};

// ---- Helper: fetch raw text ----
function fetchRawText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchRawText(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}
