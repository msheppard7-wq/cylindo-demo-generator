/* ============================================
   Generation Worker Endpoint
   Called internally by the Slack modal handler.
   Receives JSON with generation params, does the work,
   posts results to Slack channel.
   ============================================ */

const https = require('https');
const { URL } = require('url');

const CONTENT_API = 'https://content.cylindo.com/api/v2';
const VERCEL_API = 'https://api.vercel.com';
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID || '';
const DEMO_CHANNEL = process.env.SLACK_DEMO_CHANNEL || 'C0AQS5JV0KE';

function log(label, ...args) {
  console.log(`[cylindo-demo][generate][${label}]`, new Date().toISOString(), ...args);
}

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

// ---- Slack API ----

async function slackAPI(method, body) {
  return await httpRequest(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
  }, JSON.stringify(body));
}

async function slackPostMessage(channel, text, blocks) {
  const result = await slackAPI('chat.postMessage', { channel, text, blocks });
  if (result.data && result.data.ok === false) {
    log('slack', 'chat.postMessage FAILED:', result.data.error, '| channel:', channel);
  } else {
    log('slack', 'chat.postMessage OK to channel:', channel, '| ts:', result.data?.ts);
  }
  return result;
}

async function slackUpdateMessage(channel, ts, text, blocks) {
  if (!ts) return;
  const result = await slackAPI('chat.update', { channel, ts, text, blocks });
  if (result.data && result.data.ok === false) {
    log('slack', 'chat.update FAILED:', result.data.error);
  }
  return result;
}

function buildTrackerBlocks({ brandName, customerId, curatorCode, productCodes, brandUrl, userId, status, statusEmoji, statusDetail, demoUrl, errorMessage, statusParts }) {
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `Demo Request: ${brandName}` },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          userId ? `*Requested by:* <@${userId}>` : '',
          `*Customer ID:* ${customerId}`,
          `*Curator Code:* \`${curatorCode}\``,
          `*Products:* ${productCodes.join(', ')}`,
          brandUrl ? `*Reference:* <${brandUrl}|${brandUrl}>` : '',
        ].filter(Boolean).join('\n'),
      },
    },
    { type: 'divider' },
  ];

  // Status section
  let statusText = `${statusEmoji} *Status: ${status}*`;
  if (statusDetail) statusText += `\n${statusDetail}`;
  if (statusParts && statusParts.length > 0) {
    statusText += '\n\n' + statusParts.join('\n');
  }
  if (demoUrl) {
    statusText += `\n\n:rocket: *Demo URL:* <${demoUrl}|${demoUrl}>`;
    statusText += `\n:page_facing_up: Tear sheet available on the demo page`;
  }
  if (errorMessage) {
    statusText += `\n\n\`\`\`${errorMessage}\`\`\`\nPlease check your inputs and try again.`;
  }

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: statusText },
  });

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `Last updated: <!date^${Math.floor(Date.now() / 1000)}^{date_short_pretty} at {time}|${new Date().toISOString()}> | Cylindo Demo Generator` }],
  });

  return blocks;
}

// ---- Content API ----

async function fetchProductConfig(customerId, productCode) {
  const encoded = encodeURIComponent(productCode);
  return await fetchJSON(`${CONTENT_API}/${customerId}/products/${encoded}/configuration`);
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

// ---- Site Builder ----

function buildConfig(customerId, curatorCode, brandName, brandUrl, products) {
  return {
    brand: {
      name: brandName,
      logoText: brandName,
      tagline: 'Cylindo 3D Product Visualization Demo',
      website: brandUrl || '#',
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
        colorBg: '#ffffff', colorBgAlt: '#f7f5f0', colorText: '#2c3e50',
        colorTextSecondary: '#7a8a8e', colorAccent: '#2c5f7c',
        colorAccentHover: '#1e4a61', colorBorder: '#ddd8ce', colorSuccess: '#5a7c65',
      },
    },
    cylindo: { customerId, remoteConfig: curatorCode },
    products,
  };
}

function buildProduct(productCode, features) {
  const name = formatName(productCode);
  return {
    id: slugify(productCode), name, code: productCode,
    price: '$0.00', priceNote: 'Contact for pricing', rating: 4.8, reviewCount: 0,
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
    specs: [{
      group: 'Product Information',
      items: [['Product Code', productCode], ['Available Options', `${features.reduce((s, f) => s + f.options.length, 0)} configurations`], ['3D Viewer', 'Cylindo Viewer v5'], ['Viewer Type', '360° + Zoom']],
    }],
    faqs: [
      { q: 'What am I looking at?', a: 'This is a Cylindo-powered product demo showing how the 3D viewer integrates into a branded product page.' },
      { q: 'Can I interact with the 3D view?', a: 'Yes! Click and drag to rotate, scroll to zoom, and use the option selectors to change configuration in real-time.' },
      { q: 'What is the tear sheet?', a: 'Click "Download Tear Sheet" to generate a printable product sheet showing the current configuration with specs and swatches.' },
    ],
    leadTime: 'Demo product — contact for availability',
  };
}

// ---- Inlined HTML Template ----

function getIndexHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cylindo Demo</title>
  <link rel="preconnect" href="https://content.cylindo.com" crossorigin />
  <script type="module" src="https://viewer-cdn.cylindo.com/v1/index.mjs" async><\/script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header class="site-header">
    <div class="header-announcement"><div class="header-announcement-inner" id="announcement-bar"></div></div>
    <div class="header-main"><div class="header-main-inner">
      <button class="menu-btn" type="button" aria-label="Menu"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg></button>
      <a href="#" class="logo" id="logo"></a>
      <div class="header-actions">
        <a href="#" aria-label="Search"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></a>
        <a href="#" aria-label="Account"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></a>
        <a href="#" aria-label="Cart"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg></a>
      </div>
    </div></div>
    <div class="main-nav-wrap"><nav class="main-nav" id="main-nav"></nav></div>
  </header>
  <div class="product-switcher" id="product-switcher"></div>
  <div class="breadcrumb"><div class="container" id="breadcrumb"></div></div>
  <main class="product-section"><div class="container product-grid"><div class="product-media"><div class="curator-meta" id="curator-meta"></div><div class="cylindo-wrapper" id="cylindo-container"></div><button class="tearsheet-btn" id="tearsheet-btn" type="button"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><polyline points="9 15 12 18 15 15"/></svg> Download Tear Sheet</button></div><div class="product-info" id="product-info"></div></div></main>
  <section class="features-section"><div class="container"><h2 class="section-title">What Makes It Special</h2><div class="features-grid" id="features-grid"></div></div></section>
  <section class="specs-section"><div class="container"><h2 class="section-title">Specifications</h2><div class="specs-grid" id="specs-grid"></div></div></section>
  <section class="faq-section"><div class="container"><h2 class="section-title">Frequently Asked Questions</h2><div class="faq-list" id="faq-list"></div></div></section>
  <section class="cylindo-banner"><div class="container"><div class="cylindo-badge-large"><span class="powered-by">3D Product Visualization Powered by</span><span class="cylindo-brand">Cylindo</span></div><p>This demo showcases how Cylindo's interactive 3D viewer integrates seamlessly into a branded product page.</p></div></section>
  <footer class="site-footer"><div class="container footer-grid" id="footer-grid"></div><div class="footer-bottom"><p id="footer-copyright"></p></div></footer>
  <div class="tearsheet-overlay" id="tearsheet-overlay"><div class="tearsheet-modal" id="tearsheet-modal"><button class="tearsheet-close" id="tearsheet-close" type="button">&times;</button><div class="tearsheet-actions"><button class="tearsheet-print-btn" id="tearsheet-print-btn" type="button"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg> Print / Save as PDF</button></div><div class="tearsheet-content" id="tearsheet-content"></div></div></div>
  <script src="app.js"><\/script>
</body>
</html>`;
}

// ---- Vercel Deployment ----

async function deployToVercel(projectName, files) {
  const teamParam = VERCEL_TEAM_ID ? `?teamId=${VERCEL_TEAM_ID}` : '';
  return await httpRequest(`${VERCEL_API}/v13/deployments${teamParam}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${VERCEL_TOKEN}`, 'Content-Type': 'application/json' },
  }, JSON.stringify({
    name: projectName,
    files: files.map((f) => ({ file: f.path, data: Buffer.from(f.content).toString('base64'), encoding: 'base64' })),
    projectSettings: { framework: null },
    target: 'production',
  }));
}

// ---- Generate Demo (core logic) ----

async function generateDemo({ customerId, productCodes, curatorCode, brandName, brandUrl, onStatusUpdate }) {
  log('gen', 'Starting for', brandName, '| products:', productCodes.join(', '));
  const products = [];
  const statusParts = [];

  if (onStatusUpdate) await onStatusUpdate(':arrows_counterclockwise: Fetching product data from Cylindo Content API...');

  for (const code of productCodes) {
    log('gen', 'Fetching product config:', code.trim());
    const configData = await fetchProductConfig(customerId, code.trim());
    if (!configData) log('gen', 'WARNING: No config data returned for', code.trim());
    const features = extractFeatures(configData);
    products.push(buildProduct(code.trim(), features));
    const totalOpts = features.reduce((s, f) => s + f.options.length, 0);
    log('gen', 'Product ready:', code.trim(), '|', features.length, 'features,', totalOpts, 'options');
    statusParts.push(`• *${formatName(code.trim())}*: ${features.length} feature group(s), ${totalOpts} options`);
  }

  const config = buildConfig(customerId, curatorCode, brandName, brandUrl, products);

  const fs = require('fs');
  const path = require('path');
  let stylesCSS, appJS;
  try {
    const cssPath = path.join(process.cwd(), 'templates', 'styles.css');
    const jsPath = path.join(process.cwd(), 'templates', 'app.js');
    log('gen', 'Reading templates from filesystem:', cssPath);
    stylesCSS = fs.readFileSync(cssPath, 'utf-8');
    appJS = fs.readFileSync(jsPath, 'utf-8');
    log('gen', 'Templates loaded from filesystem OK | CSS:', stylesCSS.length, 'bytes | JS:', appJS.length, 'bytes');
  } catch (fsErr) {
    log('gen', 'Filesystem read failed:', fsErr.message, '| Falling back to GitHub raw URLs');
    const baseUrl = 'https://raw.githubusercontent.com/msheppard7-wq/cylindo-demo-generator/main/templates';
    [stylesCSS, appJS] = await Promise.all([fetchRawText(`${baseUrl}/styles.css`), fetchRawText(`${baseUrl}/app.js`)]);
    log('gen', 'Templates loaded from GitHub | CSS:', stylesCSS.length, 'bytes | JS:', appJS.length, 'bytes');
  }

  const slug = slugify(brandName);
  const projectName = `cylindo-demo-${slug}`;
  const files = [
    { path: 'index.html', content: getIndexHTML() },
    { path: 'styles.css', content: stylesCSS },
    { path: 'app.js', content: appJS },
    { path: 'config.json', content: JSON.stringify(config, null, 2) },
  ];

  if (onStatusUpdate) await onStatusUpdate(':arrows_counterclockwise: Deploying to Vercel...');

  log('gen', 'Deploying to Vercel as', projectName, '| files:', files.length);
  const deployment = await deployToVercel(projectName, files);
  log('gen', 'Vercel response:', deployment.status, JSON.stringify(deployment.data).substring(0, 500));

  if (deployment.status !== 200 && deployment.status !== 201) {
    const errMsg = deployment.data?.error?.message || deployment.data?.error?.code || JSON.stringify(deployment.data);
    throw new Error(`Vercel deployment failed (HTTP ${deployment.status}): ${errMsg}`);
  }

  let demoUrl = `https://${projectName}.vercel.app`;
  if (deployment.data.url) demoUrl = `https://${deployment.data.url}`;

  log('gen', 'Demo URL:', demoUrl);
  return { demoUrl, statusParts, projectName };
}

// ============================================
//  MAIN HANDLER
// ============================================

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body;
  log('start', 'Received request');

  const { customerId, productCodes, curatorCode, brandName, brandUrl, userId } = body;

  if (!customerId || !productCodes || !curatorCode || !brandName) {
    return res.status(400).json({ error: 'Missing required fields: customerId, productCodes, curatorCode, brandName' });
  }

  const trackerParams = { brandName, customerId, curatorCode, productCodes, brandUrl, userId };

  // Post initial tracker message — "Submitted"
  let messageTs = null;
  try {
    const initResult = await slackPostMessage(DEMO_CHANNEL, `Demo request: ${brandName}`,
      buildTrackerBlocks({ ...trackerParams, status: 'Submitted', statusEmoji: ':hourglass_flowing_sand:' })
    );
    messageTs = initResult.data?.ts;
    log('tracker', 'Initial message posted, ts:', messageTs);
  } catch (msgErr) {
    log('tracker', 'FAILED to post initial tracker:', msgErr.message);
  }

  // Status update callback for generateDemo
  const onStatusUpdate = async (detail) => {
    try {
      await slackUpdateMessage(DEMO_CHANNEL, messageTs, `Generating: ${brandName}`,
        buildTrackerBlocks({ ...trackerParams, status: 'In Progress', statusEmoji: ':arrows_counterclockwise:', statusDetail: detail })
      );
    } catch (e) {
      log('tracker', 'Status update failed:', e.message);
    }
  };

  // Do the work
  try {
    const result = await generateDemo({ customerId, productCodes, curatorCode, brandName, brandUrl, onStatusUpdate });

    // Final update — "Created"
    await slackUpdateMessage(DEMO_CHANNEL, messageTs, `Demo ready: ${brandName}`,
      buildTrackerBlocks({ ...trackerParams, status: 'Created', statusEmoji: ':white_check_mark:', demoUrl: result.demoUrl, statusParts: result.statusParts })
    );
    log('tracker', 'Final status: Created');

    return res.status(200).json({ ok: true, demoUrl: result.demoUrl });
  } catch (error) {
    log('error', 'GENERATION ERROR:', error.message, error.stack);

    // Final update — "Failed"
    try {
      await slackUpdateMessage(DEMO_CHANNEL, messageTs, `Demo failed: ${brandName}`,
        buildTrackerBlocks({ ...trackerParams, status: 'Failed', statusEmoji: ':x:', errorMessage: error.message })
      );
    } catch (postErr) {
      log('error', 'ALSO FAILED to update tracker:', postErr.message);
    }

    return res.status(500).json({ error: error.message });
  }
};
