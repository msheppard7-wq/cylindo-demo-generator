/* ============================================
   Slack Slash Command + Interactive Modal Handler

   /cylindo-demo → Opens a form modal
   User fills in fields → submits → generates demo → posts URL

   Env vars required:
     SLACK_BOT_TOKEN    - xoxb-... token
     VERCEL_TOKEN       - Vercel deploy token
     SLACK_SIGNING_SECRET - (optional) for request verification
   ============================================ */

const https = require('https');
const { URL } = require('url');

// ---- Config ----
const CONTENT_API = 'https://content.cylindo.com/api/v2';
const VERCEL_API = 'https://api.vercel.com';
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
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
  return await slackAPI('chat.postMessage', { channel, text, blocks });
}

// ---- Open Modal ----

async function openModal(triggerId, channelId) {
  const view = {
    type: 'modal',
    callback_id: 'cylindo_demo_submit',
    private_metadata: JSON.stringify({ channel_id: channelId }),
    title: { type: 'plain_text', text: 'Cylindo Demo Generator' },
    submit: { type: 'plain_text', text: 'Generate Demo' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '🚀 Generate a Cylindo Product Demo' },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: 'Fill in the details below. A branded demo page with 3D viewer and tear sheet will be auto-generated and deployed.' }],
      },
      { type: 'divider' },
      {
        type: 'input',
        block_id: 'customer_id',
        label: { type: 'plain_text', text: 'Cylindo Account Number' },
        hint: { type: 'plain_text', text: 'Found in CMS → Settings → Account number. Demo Customer = 4404' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          placeholder: { type: 'plain_text', text: '4404' },
          initial_value: '4404',
        },
      },
      {
        type: 'input',
        block_id: 'product_codes',
        label: { type: 'plain_text', text: 'Product Code(s)' },
        hint: { type: 'plain_text', text: 'From Cylindo CMS product page. Comma-separate for multiple products.' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          placeholder: { type: 'plain_text', text: 'HAVEN COMFORT ARM SOFA, NORFOLK WIDE ARM PLEATED SOFA' },
        },
      },
      {
        type: 'input',
        block_id: 'curator_code',
        label: { type: 'plain_text', text: 'Curator Code' },
        hint: { type: 'plain_text', text: 'Listed at top of the Curator page. Make sure Curator is published!' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          placeholder: { type: 'plain_text', text: 'a7ap4vak' },
        },
      },
      {
        type: 'input',
        block_id: 'brand_name',
        label: { type: 'plain_text', text: 'Brand / Client Name' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          placeholder: { type: 'plain_text', text: 'Serena & Lily' },
        },
      },
      {
        type: 'input',
        block_id: 'brand_url',
        label: { type: 'plain_text', text: 'Brand PDP Website URL' },
        hint: { type: 'plain_text', text: 'Link to a product page on the client\'s website (for branding reference)' },
        optional: true,
        element: {
          type: 'url_text_input',
          action_id: 'value',
          placeholder: { type: 'plain_text', text: 'https://www.serenaandlily.com/products/haven-sofa/' },
        },
      },
    ],
  };

  return await slackAPI('views.open', { trigger_id: triggerId, view });
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
  <div class="announcement-bar" id="announcement-bar"></div>
  <header class="site-header"><div class="header-inner"><a href="#" class="logo" id="logo"></a><nav class="main-nav" id="main-nav"></nav><div class="header-actions"><button class="icon-btn cart-btn" aria-label="Cart"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg><span class="cart-count">0</span></button></div></div></header>
  <div class="product-switcher" id="product-switcher"></div>
  <div class="breadcrumb"><div class="container" id="breadcrumb"></div></div>
  <main class="product-section"><div class="container product-grid"><div class="product-media"><div class="cylindo-wrapper" id="cylindo-container"></div><button class="tearsheet-btn" id="tearsheet-btn" type="button"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><polyline points="9 15 12 18 15 15"/></svg><span>Download Tear Sheet</span></button></div><div class="product-info" id="product-info"></div></div></main>
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

async function generateDemo({ customerId, productCodes, curatorCode, brandName, brandUrl }) {
  const products = [];
  const statusParts = [];

  for (const code of productCodes) {
    const configData = await fetchProductConfig(customerId, code.trim());
    const features = extractFeatures(configData);
    products.push(buildProduct(code.trim(), features));
    const totalOpts = features.reduce((s, f) => s + f.options.length, 0);
    statusParts.push(`• *${formatName(code.trim())}*: ${features.length} feature group(s), ${totalOpts} options`);
  }

  const config = buildConfig(customerId, curatorCode, brandName, brandUrl, products);

  // Get template files
  const fs = require('fs');
  const path = require('path');
  let stylesCSS, appJS;
  try {
    stylesCSS = fs.readFileSync(path.join(process.cwd(), 'templates', 'styles.css'), 'utf-8');
    appJS = fs.readFileSync(path.join(process.cwd(), 'templates', 'app.js'), 'utf-8');
  } catch {
    const baseUrl = 'https://raw.githubusercontent.com/msheppard7-wq/cylindo-demo-generator/main/templates';
    [stylesCSS, appJS] = await Promise.all([fetchRawText(`${baseUrl}/styles.css`), fetchRawText(`${baseUrl}/app.js`)]);
  }

  const slug = slugify(brandName);
  const projectName = `cylindo-demo-${slug}`;
  const files = [
    { path: 'index.html', content: getIndexHTML() },
    { path: 'styles.css', content: stylesCSS },
    { path: 'app.js', content: appJS },
    { path: 'config.json', content: JSON.stringify(config, null, 2) },
  ];

  const deployment = await deployToVercel(projectName, files);
  let demoUrl = `https://${projectName}.vercel.app`;
  if ((deployment.status === 200 || deployment.status === 201) && deployment.data.url) {
    demoUrl = `https://${deployment.data.url}`;
  }

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

  // ---- Handle: Slash command → open modal ----
  if (body.command === '/cylindo-demo') {
    const triggerId = body.trigger_id;

    if (!triggerId) {
      return res.status(200).json({
        response_type: 'ephemeral',
        text: ':warning: No trigger_id received. Please try again.',
      });
    }

    // Open the modal FIRST, before responding (Vercel may kill the function after res.send)
    try {
      const result = await openModal(triggerId, body.channel_id);
      if (result.data && !result.data.ok) {
        return res.status(200).json({
          response_type: 'ephemeral',
          text: `:warning: Could not open form: ${result.data.error || 'unknown error'}\n\nDebug: token starts with ${SLACK_BOT_TOKEN ? SLACK_BOT_TOKEN.substring(0, 8) : 'NOT SET'}`,
        });
      }
      // Modal opened successfully — send empty 200 to acknowledge
      return res.status(200).send('');
    } catch (err) {
      return res.status(200).json({
        response_type: 'ephemeral',
        text: `:x: Error opening form: ${err.message}`,
      });
    }
  }

  // ---- Handle: Modal submission (interactive payload) ----
  if (body.payload) {
    const payload = JSON.parse(body.payload);

    if (payload.type === 'view_submission' && payload.view.callback_id === 'cylindo_demo_submit') {
      const values = payload.view.state.values;
      const userId = payload.user.id;
      const userName = payload.user.name || payload.user.username || 'someone';

      const customerId = values.customer_id.value.value.trim();
      const productCodesRaw = values.product_codes.value.value.trim();
      const curatorCode = values.curator_code.value.value.trim();
      const brandName = values.brand_name.value.value.trim();
      const brandUrl = values.brand_url?.value?.value?.trim() || '';

      // Get the channel from private_metadata
      let channelId = null;
      try {
        const meta = JSON.parse(payload.view.private_metadata || '{}');
        channelId = meta.channel_id;
      } catch {}

      const productCodes = productCodesRaw.split(',').map((p) => p.trim()).filter(Boolean);

      // Close the modal with a "generating" message
      res.status(200).json({
        response_action: 'update',
        view: {
          type: 'modal',
          title: { type: 'plain_text', text: 'Generating...' },
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: `:hourglass_flowing_sand: *Generating demo for ${brandName}...*\n\n:satellite: Fetching product data from Cylindo Content API...\n:package: Products: ${productCodes.join(', ')}\n\nThis modal will close. Check the channel for the result.` },
            },
          ],
        },
      });

      // Do the work asynchronously
      try {
        const result = await generateDemo({ customerId, productCodes, curatorCode, brandName, brandUrl });

        // Post to the channel where /cylindo-demo was invoked
        // Fall back to DM if no channel context
        let postChannelId = channelId;
        if (!postChannelId) {
          const dmResult = await slackAPI('conversations.open', { users: userId });
          postChannelId = dmResult.data?.channel?.id;
        }

        if (postChannelId) {
          await slackPostMessage(postChannelId, `Demo ready for ${brandName}!`, [
            {
              type: 'header',
              text: { type: 'plain_text', text: `✅ Demo Ready: ${brandName}` },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: [
                  `*Requested by:* <@${userId}>`,
                  `*Customer ID:* ${customerId}`,
                  `*Curator Code:* ${curatorCode}`,
                  `*Products:*`,
                  ...result.statusParts,
                  '',
                  `:rocket: *Demo URL:* <${result.demoUrl}|${result.demoUrl}>`,
                  `:page_facing_up: Tear sheet available on the demo page`,
                  brandUrl ? `\n:link: *Reference site:* <${brandUrl}|${brandUrl}>` : '',
                ].join('\n'),
              },
            },
            {
              type: 'context',
              elements: [{ type: 'mrkdwn', text: `Generated via /cylindo-demo | Cylindo Demo Generator` }],
            },
          ]);
        }
      } catch (error) {
        console.error('Generation error:', error);
        // Post error to channel or DM
        let errChannelId = channelId;
        if (!errChannelId) {
          const dmResult = await slackAPI('conversations.open', { users: userId });
          errChannelId = dmResult.data?.channel?.id;
        }
        if (errChannelId) {
          await slackPostMessage(errChannelId, `Error generating demo`, [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: `:x: *Error generating demo for ${brandName}:*\n\`\`\`${error.message}\`\`\`\n\nPlease check your inputs and try again.` },
            },
          ]);
        }
      }
      return;
    }

    // Other interactive payloads — just acknowledge
    return res.status(200).send('');
  }

  // ---- Fallback: old-style text command still works ----
  if (body.text && body.text.trim()) {
    const parsed = parseSlackText(body.text);
    if (parsed) {
      res.status(200).json({
        response_type: 'in_channel',
        text: `:hourglass_flowing_sand: *Generating demo for ${parsed.brand}...*\nRequested by @${body.user_name}\n\n:satellite: Fetching product data from Cylindo Content API...`,
      });

      try {
        const result = await generateDemo({
          customerId: parsed.customer,
          productCodes: parsed.products,
          curatorCode: parsed.curator,
          brandName: parsed.brand,
          brandUrl: '',
        });

        await httpRequest(body.response_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }, JSON.stringify({
          response_type: 'in_channel',
          blocks: [
            { type: 'header', text: { type: 'plain_text', text: `✅ Demo Ready: ${parsed.brand}` } },
            { type: 'section', text: { type: 'mrkdwn', text: [...result.statusParts, '', `:rocket: *Demo URL:* <${result.demoUrl}|${result.demoUrl}>`].join('\n') } },
          ],
        }));
      } catch (error) {
        await httpRequest(body.response_url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
        }, JSON.stringify({ response_type: 'ephemeral', text: `:x: Error: ${error.message}` }));
      }
      return;
    }
  }

  // No text = open modal (default behavior)
  if (body.trigger_id) {
    try {
      await openModal(body.trigger_id);
      return res.status(200).send('');
    } catch (err) {
      return res.status(200).json({ response_type: 'ephemeral', text: `:x: Error: ${err.message}` });
    }
  }

  res.status(200).json({ response_type: 'ephemeral', text: 'Type `/cylindo-demo` to open the demo generator form.' });
};

// ---- Old-style text parser (backwards compatible) ----
function parseSlackText(text) {
  const parts = [];
  let current = '';
  let inQuotes = false;
  for (const char of text) {
    if (char === '"') { inQuotes = !inQuotes; }
    else if (char === ' ' && !inQuotes) { if (current) parts.push(current); current = ''; }
    else { current += char; }
  }
  if (current) parts.push(current);
  if (parts.length < 3) return null;
  return { customer: parts[0], products: parts[1].split(',').map((p) => p.trim()), curator: parts[2], brand: parts[3] || 'Demo' };
}
