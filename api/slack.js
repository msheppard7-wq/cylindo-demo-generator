/* ============================================
   Cylindo Demo Generator — Slack Handler

   Single entry point for all Slack interactions:
   - /cylindo-demo slash command → opens modal
   - /cylindo-demo setup → posts channel button
   - Button click → opens modal
   - Modal submit → closes modal, runs generation via waitUntil()
   - Status tracker updates in-place in channel

   Env vars:
     SLACK_BOT_TOKEN     - xoxb-... token
     VERCEL_TOKEN        - Vercel deploy token
     SLACK_DEMO_CHANNEL  - Channel ID for status messages
     VERCEL_TEAM_ID      - (optional) Vercel team ID
   ============================================ */

const https = require('https');
const { URL } = require('url');
const { waitUntil } = require('@vercel/functions');

// ---- Config ----
const CONTENT_API = 'https://content.cylindo.com/api/v2';
const VERCEL_API = 'https://api.vercel.com';
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID || '';
const DEMO_CHANNEL = process.env.SLACK_DEMO_CHANNEL || 'C0AQS5JV0KE';

// ---- Logging ----
function log(label, ...args) {
  console.log(`[cylindo-demo][${label}]`, new Date().toISOString(), ...args);
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

// ---- Brand URL Scraping ----

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)),
  ]);
}

function fetchBrandPage(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
    };
    let redirects = 0;
    function doFetch(fetchOpts) {
      https.get(fetchOpts, (res) => {
        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location && redirects < 5) {
          redirects++;
          try {
            const next = new URL(res.headers.location, `https://${fetchOpts.hostname}`);
            return doFetch({ hostname: next.hostname, path: next.pathname + next.search, headers: fetchOpts.headers });
          } catch { return reject(new Error('Bad redirect')); }
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        let data = '';
        let bytes = 0;
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 2 * 1024 * 1024) { res.destroy(); return reject(new Error('Response too large')); }
          data += chunk;
        });
        res.on('end', () => resolve(data));
      }).on('error', reject);
    }
    doFetch(opts);
  });
}

function extractInlineCSS(html) {
  const re = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let result = '';
  let m;
  while ((m = re.exec(html)) !== null) result += m[1] + '\n';
  return result;
}

async function fetchExternalCSS(html, baseUrl) {
  const linkRe = /<link[^>]+(?:rel=["']stylesheet["'][^>]+href=["']([^"']+)["']|href=["']([^"']+)["'][^>]+rel=["']stylesheet["'])[^>]*>/gi;
  const urls = [];
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const href = m[1] || m[2];
    if (!href || href.includes('fonts.googleapis.com')) continue;
    try {
      const abs = new URL(href, baseUrl);
      const base = new URL(baseUrl);
      if (abs.hostname === base.hostname || abs.hostname.endsWith('.' + base.hostname.replace(/^www\./, ''))) {
        urls.push(abs.href);
      }
    } catch {}
    if (urls.length >= 2) break;
  }
  const results = [];
  for (const cssUrl of urls) {
    try {
      const text = await withTimeout(fetchRawText(cssUrl), 5000);
      results.push(text);
    } catch (e) {
      log('scrape', 'CSS fetch failed:', cssUrl, e.message);
    }
  }
  return results;
}

function extractFonts(html, css) {
  const result = { heading: null, body: null, googleFontsUrl: null };

  // 1. Google Fonts <link> — highest confidence
  const gfRe = /fonts\.googleapis\.com\/css2?\?[^"'>\s]*family=([^"'>\s]+)/gi;
  const gfMatch = gfRe.exec(html);
  if (gfMatch) {
    // Capture the full URL for injection
    const fullUrlRe = /(https?:\/\/fonts\.googleapis\.com\/css2?\?[^"'>\s]+)/gi;
    const fullMatch = fullUrlRe.exec(html);
    if (fullMatch) result.googleFontsUrl = fullMatch[1].replace(/&amp;/g, '&');

    // Parse family names: family=Roboto:wght@400;700&family=Open+Sans:wght@300
    const familyStr = gfMatch[1].replace(/&amp;/g, '&');
    const families = familyStr.split(/&family=|family=/i).filter(Boolean);
    const fontNames = families.map(f => {
      const name = f.split(':')[0].replace(/\+/g, ' ').trim();
      return `'${name}'`;
    }).filter(Boolean);

    if (fontNames.length >= 1) result.heading = fontNames[0] + ', sans-serif';
    if (fontNames.length >= 2) result.body = fontNames[1] + ', sans-serif';
    else if (fontNames.length === 1) result.body = fontNames[0] + ', sans-serif';
  }

  // 2. @font-face declarations
  if (!result.heading) {
    const ffRe = /@font-face\s*\{[^}]*font-family:\s*['"]?([^;'"}\n]+)['"]?/gi;
    const ffNames = new Set();
    let fm;
    while ((fm = ffRe.exec(css)) !== null) {
      ffNames.add(fm[1].trim().replace(/['"]/g, ''));
    }
    const names = [...ffNames];
    if (names.length >= 1) result.heading = `'${names[0]}', sans-serif`;
    if (names.length >= 2) result.body = `'${names[1]}', sans-serif`;
    else if (names.length === 1 && !result.body) result.body = `'${names[0]}', sans-serif`;
  }

  // 3. font-family on body/html/:root
  if (!result.body) {
    const bodyFontRe = /(?:body|:root|html)\s*\{[^}]*font-family:\s*([^;}\n]+)/i;
    const bm = bodyFontRe.exec(css);
    if (bm) result.body = bm[1].trim();
  }

  return result;
}

function normalizeHex(color) {
  if (!color) return null;
  color = color.trim().toLowerCase();
  // Handle rgb/rgba
  const rgbRe = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/;
  const rgbMatch = rgbRe.exec(color);
  if (rgbMatch) {
    const r = parseInt(rgbMatch[1]).toString(16).padStart(2, '0');
    const g = parseInt(rgbMatch[2]).toString(16).padStart(2, '0');
    const b = parseInt(rgbMatch[3]).toString(16).padStart(2, '0');
    return `#${r}${g}${b}`;
  }
  // Handle 3-digit hex
  if (/^#[0-9a-f]{3}$/.test(color)) {
    return `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`;
  }
  if (/^#[0-9a-f]{6}$/.test(color)) return color;
  return null;
}

function isLightColor(hex) {
  if (!hex) return true;
  hex = normalizeHex(hex) || '#ffffff';
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.5;
}

function darkenColor(hex, pct) {
  hex = normalizeHex(hex);
  if (!hex) return null;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const factor = 1 - pct / 100;
  const dr = Math.round(r * factor).toString(16).padStart(2, '0');
  const dg = Math.round(g * factor).toString(16).padStart(2, '0');
  const db = Math.round(b * factor).toString(16).padStart(2, '0');
  return `#${dr}${dg}${db}`;
}

function extractColors(html, css) {
  const result = { bg: null, accent: null, text: null, border: null, headerBg: null };

  // 1. CSS custom properties
  const varPatterns = [
    { key: 'accent', re: /--(?:primary|brand|accent|main)[-_]?colou?r\s*:\s*([^;}\n]+)/gi },
    { key: 'bg', re: /--(?:bg|background)[-_]?colou?r\s*:\s*([^;}\n]+)/gi },
    { key: 'text', re: /--(?:text|foreground)[-_]?colou?r\s*:\s*([^;}\n]+)/gi },
    { key: 'border', re: /--(?:border)[-_]?colou?r\s*:\s*([^;}\n]+)/gi },
  ];
  for (const { key, re } of varPatterns) {
    const vm = re.exec(css);
    if (vm) {
      const c = normalizeHex(vm[1]);
      if (c) result[key] = c;
    }
  }

  // 2. <meta name="theme-color">
  if (!result.accent) {
    const tcRe = /<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']+)["']/i;
    const tcAlt = /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']theme-color["']/i;
    const tcm = tcRe.exec(html) || tcAlt.exec(html);
    if (tcm) {
      const c = normalizeHex(tcm[1]);
      if (c) result.accent = c;
    }
  }

  // 3. Body background/color from CSS
  if (!result.bg || !result.text) {
    const bodyRe = /(?:^|\})\s*(?:body|html)\s*\{([^}]+)\}/gim;
    const bm = bodyRe.exec(css);
    if (bm) {
      const block = bm[1];
      if (!result.bg) {
        const bgRe = /background(?:-color)?\s*:\s*([^;}\n]+)/i;
        const bgm = bgRe.exec(block);
        if (bgm) { const c = normalizeHex(bgm[1]); if (c) result.bg = c; }
      }
      if (!result.text) {
        const clrRe = /(?:^|;)\s*color\s*:\s*([^;}\n]+)/i;
        const clrm = clrRe.exec(block);
        if (clrm) { const c = normalizeHex(clrm[1]); if (c) result.text = c; }
      }
    }
  }

  // 4. Header background
  const hdrRe = /(?:\.header|header|\.site-header|\.navbar|nav)\s*\{([^}]+)\}/gi;
  const hm = hdrRe.exec(css);
  if (hm) {
    const bgRe = /background(?:-color)?\s*:\s*([^;}\n]+)/i;
    const bgm = bgRe.exec(hm[1]);
    if (bgm) { const c = normalizeHex(bgm[1]); if (c) result.headerBg = c; }
  }

  // 5. Color frequency analysis as fallback for accent
  if (!result.accent) {
    const hexRe = /#[0-9a-fA-F]{3,6}\b/g;
    const counts = {};
    let hm2;
    while ((hm2 = hexRe.exec(css)) !== null) {
      const c = normalizeHex(hm2[0]);
      if (c && c !== '#ffffff' && c !== '#000000' && c !== '#fff' && c !== '#000') {
        counts[c] = (counts[c] || 0) + 1;
      }
    }
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    // Pick top non-white non-black non-gray color
    for (const [color] of sorted) {
      const r = parseInt(color.slice(1, 3), 16);
      const g = parseInt(color.slice(3, 5), 16);
      const b = parseInt(color.slice(5, 7), 16);
      const isGray = Math.abs(r - g) < 20 && Math.abs(g - b) < 20 && Math.abs(r - b) < 20;
      if (!isGray) { result.accent = color; break; }
    }
  }

  return result;
}

function extractLogo(html, baseUrl) {
  // 1. <img> with "logo" in class/id/alt/src
  const logoImgPatterns = [
    /<img[^>]+(?:class|id|alt)=["'][^"']*logo[^"']*["'][^>]*src=["']([^"']+)["']/gi,
    /<img[^>]+src=["']([^"']+)["'][^>]*(?:class|id|alt)=["'][^"']*logo[^"']*["']/gi,
    /<img[^>]+src=["']([^"']*logo[^"']+)["']/gi,
  ];
  for (const re of logoImgPatterns) {
    const m = re.exec(html);
    if (m && m[1]) {
      try { return new URL(m[1], baseUrl).href; } catch {}
    }
  }

  // 2. First <img> inside <header>
  const headerImgRe = /<header[\s\S]{0,3000}?<img[^>]+src=["']([^"']+)["']/i;
  const hm = headerImgRe.exec(html);
  if (hm && hm[1]) {
    try { return new URL(hm[1], baseUrl).href; } catch {}
  }

  // 3. Apple touch icon or favicon
  const iconRe = /<link[^>]+rel=["'](?:apple-touch-icon|icon)["'][^>]+href=["']([^"']+)["']/i;
  const iconAlt = /<link[^>]+href=["']([^"']+)["'][^>]+rel=["'](?:apple-touch-icon|icon)["']/i;
  const im = iconRe.exec(html) || iconAlt.exec(html);
  if (im && im[1]) {
    try { return new URL(im[1], baseUrl).href; } catch {}
  }

  // 4. OG image
  const ogRe = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i;
  const ogAlt = /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i;
  const om = ogRe.exec(html) || ogAlt.exec(html);
  if (om && om[1]) {
    try { return new URL(om[1], baseUrl).href; } catch {}
  }

  return null;
}

function buildScrapedTheme(fonts, colors, logo) {
  const theme = {};
  if (fonts.heading) theme.fontHeading = fonts.heading;
  if (fonts.body) theme.fontBody = fonts.body;
  if (colors.bg) theme.colorBg = colors.bg;
  if (colors.accent) {
    theme.colorAccent = colors.accent;
    const hover = darkenColor(colors.accent, 15);
    if (hover) theme.colorAccentHover = hover;
  }
  if (colors.text) theme.colorText = colors.text;
  if (colors.border) theme.colorBorder = colors.border;
  if (colors.headerBg) {
    theme.colorHeaderBg = colors.headerBg;
    if (!isLightColor(colors.headerBg)) {
      theme.colorHeaderDarkBg = colors.headerBg;
    }
  }

  const result = { theme };
  if (logo) result.logoImageUrl = logo;
  if (fonts.googleFontsUrl) result.googleFontsUrl = fonts.googleFontsUrl;
  return result;
}

async function scrapeTheme(url) {
  if (!url) return {};
  try {
    log('scrape', 'Fetching brand page:', url);
    const html = await withTimeout(fetchBrandPage(url), 10000);
    log('scrape', 'Got HTML:', html.length, 'bytes');

    // Check for SPA shell (very little content)
    if (html.length < 1000 && /<div\s+id=["'](?:root|app|__next)["']\s*>\s*<\/div>/i.test(html)) {
      log('scrape', 'SPA shell detected, skipping extraction');
      return {};
    }

    const externalCSS = await fetchExternalCSS(html, url);
    const allCSS = extractInlineCSS(html) + '\n' + externalCSS.join('\n');
    log('scrape', 'CSS collected:', allCSS.length, 'bytes');

    const fonts = extractFonts(html, allCSS);
    const colors = extractColors(html, allCSS);
    const logo = extractLogo(html, url);

    log('scrape', 'Extracted fonts:', JSON.stringify(fonts));
    log('scrape', 'Extracted colors:', JSON.stringify(colors));
    log('scrape', 'Extracted logo:', logo);

    const scraped = buildScrapedTheme(fonts, colors, logo);
    log('scrape', 'Theme keys:', Object.keys(scraped.theme || {}));
    return scraped;
  } catch (err) {
    log('scrape', 'Theme scrape failed, using defaults:', err.message);
    return {};
  }
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
  if (ts == null || ts === '') return;
  const tsStr = String(ts);
  const result = await slackAPI('chat.update', { channel, ts: tsStr, text, blocks });
  if (result.data && result.data.ok === false) {
    log('slack', 'chat.update FAILED:', result.data.error, '| channel:', channel, '| ts:', tsStr);
  }
  return result;
}

// ---- Status Tracker Blocks ----

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

// ---- Channel Button ----

async function postButtonMessage(channelId) {
  return await slackPostMessage(channelId, 'Cylindo Demo Generator', [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ':rocket: *Cylindo Demo Generator*\nCreate a branded product demo page with interactive 360\u00b0 Cylindo viewer, real-time material/finish selectors, and downloadable tear sheet. Deployed instantly to a shareable URL.',
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: 'open_demo_form',
          text: { type: 'plain_text', text: '\u25b6\ufe0f Create Demo' },
          style: 'primary',
        },
      ],
    },
  ]);
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
        text: { type: 'plain_text', text: 'Generate a Cylindo Product Demo' },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: 'Creates a branded product page with interactive 360\u00b0 Cylindo viewer, real-time material/finish selectors with swatch images, and a downloadable tear sheet. Deployed instantly to a shareable URL.' }],
      },
      { type: 'divider' },
      {
        type: 'input',
        block_id: 'customer_id',
        label: { type: 'plain_text', text: 'Cylindo Account Number' },
        hint: { type: 'plain_text', text: 'CMS \u2192 Settings \u2192 Account. Use 4404 for Demo Customer.' },
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
        hint: { type: 'plain_text', text: 'Exact product code from CMS \u2192 Products. Comma-separate for multiple products on one page.' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          placeholder: { type: 'plain_text', text: 'EVERLY SIDE DINING CHAIR, OLIVIA DINING TABLE' },
        },
      },
      {
        type: 'input',
        block_id: 'curator_code',
        label: { type: 'plain_text', text: 'Curator Code' },
        hint: { type: 'plain_text', text: 'Alphanumeric code at top of the Curator page (e.g. pw70b37m). Curator must be published.' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          placeholder: { type: 'plain_text', text: 'pw70b37m' },
        },
      },
      {
        type: 'input',
        block_id: 'brand_name',
        label: { type: 'plain_text', text: 'Brand / Client Name' },
        hint: { type: 'plain_text', text: 'Used for page branding, header, and the deployed URL (e.g. cylindo-demo-james-james.vercel.app).' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          placeholder: { type: 'plain_text', text: 'James & James' },
        },
      },
      {
        type: 'input',
        block_id: 'brand_url',
        label: { type: 'plain_text', text: 'Client Website URL (optional)' },
        hint: { type: 'plain_text', text: 'Link to a product page on the client\'s site. Used as the "Shop" button destination.' },
        optional: true,
        element: {
          type: 'url_text_input',
          action_id: 'value',
          placeholder: { type: 'plain_text', text: 'https://jamesandjamesfurniture.com/products/everly-side-chair' },
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

/** When the brand name matches a known retail site, apply header + theme preset (layout only; no scraping). */
function brandPresetForName(brandName) {
  const n = (brandName || '').toLowerCase().replace(/\u2019/g, "'");
  if (!n.includes('haverty')) return null;
  return {
    logoText: 'HAVERTYS',
    logoSubline: 'FURNITURE \u00b7 EST 1885',
    headerVariant: 'dark-retail',
    announcementText: '',
    searchPlaceholder: 'Search',
    navLinks: [
      'LIVING', 'BEDROOM', 'DINING', 'MATTRESSES', 'OFFICE', 'DECOR',
      'FREE DESIGN SERVICE', 'FINANCING', 'REGRET-FREE GUARANTEE',
    ],
    navLinksRight: [
      { label: 'SALE', accent: true },
      { label: 'Spring Style Event', accent: false },
    ],
    navHighlight: 'LIVING',
    theme: {
      fontHeading: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
      fontBody: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
      colorBg: '#ffffff',
      colorBgAlt: '#f7f7f6',
      colorText: '#2c3138',
      colorTextSecondary: '#5a6169',
      colorAccent: '#2c3138',
      colorAccentHover: '#1a1e23',
      colorBorder: '#d9d9d9',
      colorSuccess: '#4a5d4a',
      colorAnnouncementBg: '#f5f5f5',
      colorAnnouncementText: '#333333',
      colorHeaderBg: '#ffffff',
      colorHeaderBorder: '#e8e8e8',
      colorHeaderDarkBg: '#2c3138',
      colorHeaderDarkBorder: '#3d444d',
      colorHeaderDarkText: '#ffffff',
      colorHeaderDarkMuted: 'rgba(255, 255, 255, 0.72)',
      colorNavSaleAccent: '#c9a86a',
      headerStickyOffset: '214px',
    },
  };
}

function buildConfig(customerId, curatorCode, brandName, brandUrl, products, scraped) {
  const preset = brandPresetForName(brandName) || {};
  const presetTheme = preset.theme || {};
  const scrapedTheme = (scraped && scraped.theme) || {};
  const { theme: _t, ...presetRest } = preset;

  // Layer: defaults → scraped from URL → manual preset (preset wins)
  const theme = {
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
    colorAnnouncementBg: '#f5f5f5',
    colorAnnouncementText: '#333333',
    colorHeaderBg: '#ffffff',
    colorHeaderBorder: '#e8e8e8',
    colorHeaderDarkBg: '#2c3138',
    colorHeaderDarkBorder: '#3d444d',
    colorHeaderDarkText: '#ffffff',
    colorHeaderDarkMuted: 'rgba(255, 255, 255, 0.72)',
    colorNavSaleAccent: '#c9a86a',
    ...scrapedTheme,
    ...presetTheme,
  };

  return {
    brand: {
      name: brandName,
      logoText: brandName,
      logoImageUrl: scraped?.logoImageUrl || undefined,
      tagline: 'Cylindo 3D Product Visualization Demo',
      website: brandUrl || '#',
      announcementText: `Cylindo 3D Product Visualization Demo \u2014 ${brandName}`,
      navLinks: ['Living', 'Bedroom', 'Dining', 'Outdoor', 'Sale'],
      navHighlight: 'Living',
      navLinksRight: [],
      headerVariant: undefined,
      logoSubline: '',
      searchPlaceholder: 'Search',
      footerCopyright: `${brandName} \u2014 Cylindo Demo`,
      footerColumns: [
        { title: 'Customer Care', links: ['Contact Us', 'Shipping & Returns', 'FAQ', 'Design Services'] },
        { title: 'About', links: ['Our Story', 'Design Philosophy', 'Sustainability', 'Careers'] },
        { title: 'Explore', links: ['New Arrivals', 'Best Sellers', 'Collections', 'Inspiration'] },
      ],
      ...presetRest,
      theme,
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
    description: `Explore the ${name} in full 360\u00b0 with Cylindo's interactive 3D viewer. Select different options to see the product update in real-time.`,
    badges: [{ text: 'Cylindo 3D', type: 'new' }],
    breadcrumb: ['Home', 'Products'],
    features,
    highlights: [
      { title: 'Interactive 3D', description: "Rotate, zoom, and explore every angle with Cylindo's 360\u00b0 viewer." },
      { title: 'Real-Time Configuration', description: 'Select different options and watch the product update instantly.' },
      { title: 'Material Swatches', description: 'View accurate material representations pulled from Cylindo Content API.' },
      { title: 'Tear Sheet', description: 'Generate a downloadable tear sheet with current configuration.' },
      { title: 'Seamless Integration', description: 'This viewer integrates directly into any e-commerce platform.' },
    ],
    specs: [{
      group: 'Product Information',
      items: [['Product Code', productCode], ['Available Options', `${features.reduce((s, f) => s + f.options.length, 0)} configurations`], ['3D Viewer', 'Cylindo Viewer v5'], ['Viewer Type', '360\u00b0 + Zoom']],
    }],
    faqs: [
      { q: 'What am I looking at?', a: 'This is a Cylindo-powered product demo showing how the 3D viewer integrates into a branded product page.' },
      { q: 'Can I interact with the 3D view?', a: 'Yes! Click and drag to rotate, scroll to zoom, and use the option selectors to change configuration in real-time.' },
      { q: 'What is the tear sheet?', a: 'Click "Download Tear Sheet" to generate a printable product sheet showing the current configuration with specs and swatches.' },
    ],
    leadTime: 'Demo product \u2014 contact for availability',
  };
}

// ---- HTML template (keep in sync with templates/index.html) ----

function getIndexHTML() {
  const fs = require('fs');
  const path = require('path');
  const candidates = [
    path.join(process.cwd(), 'templates', 'index.html'),
    path.join(__dirname, '..', 'templates', 'index.html'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8');
    } catch (_) {}
  }
  throw new Error('templates/index.html not found for deployment');
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

// ---- Core Generation Logic ----

async function generateDemo({ customerId, productCodes, curatorCode, brandName, brandUrl, onStatusUpdate }) {
  log('gen', 'Starting for', brandName, '| products:', productCodes.join(', '));
  const products = [];
  const statusParts = [];

  // Start brand scrape in parallel with product fetches
  if (onStatusUpdate) await onStatusUpdate(':mag: Analyzing brand website & fetching product data...');
  const scrapePromise = withTimeout(scrapeTheme(brandUrl), 15000).catch((err) => {
    log('gen', 'Scrape timed out or failed:', err.message);
    return {};
  });

  for (const code of productCodes) {
    log('gen', 'Fetching product config:', code.trim());
    const configData = await fetchProductConfig(customerId, code.trim());
    if (!configData) log('gen', 'WARNING: No config data returned for', code.trim());
    const features = extractFeatures(configData);
    products.push(buildProduct(code.trim(), features));
    const totalOpts = features.reduce((s, f) => s + f.options.length, 0);
    log('gen', 'Product ready:', code.trim(), '|', features.length, 'features,', totalOpts, 'options');
    statusParts.push(`\u2022 *${formatName(code.trim())}*: ${features.length} feature group(s), ${totalOpts} options`);
  }

  // Wait for scrape result (likely done by now since it ran in parallel)
  const scraped = await scrapePromise;
  const scrapedKeyCount = Object.keys(scraped.theme || {}).length;
  if (scrapedKeyCount > 0) {
    statusParts.push(`\u2022 *Brand style:* ${scrapedKeyCount} properties extracted from PDP`);
    if (scraped.logoImageUrl) statusParts.push(`\u2022 *Logo:* Extracted from brand site`);
  } else if (brandUrl) {
    statusParts.push(`\u2022 *Brand style:* Using default theme`);
  }

  const config = buildConfig(customerId, curatorCode, brandName, brandUrl, products, scraped);

  // Read template files
  const fs = require('fs');
  const path = require('path');
  let stylesCSS, appJS;
  try {
    const cssPath = path.join(process.cwd(), 'templates', 'styles.css');
    const jsPath = path.join(process.cwd(), 'templates', 'app.js');
    log('gen', 'Reading templates from:', cssPath);
    stylesCSS = fs.readFileSync(cssPath, 'utf-8');
    appJS = fs.readFileSync(jsPath, 'utf-8');
    log('gen', 'Templates OK | CSS:', stylesCSS.length, 'bytes | JS:', appJS.length, 'bytes');
  } catch (fsErr) {
    log('gen', 'Filesystem read failed:', fsErr.message, '| Falling back to GitHub');
    const ghBase = 'https://raw.githubusercontent.com/msheppard7-wq/cylindo-demo-generator/main/templates';
    [stylesCSS, appJS] = await Promise.all([fetchRawText(`${ghBase}/styles.css`), fetchRawText(`${ghBase}/app.js`)]);
    log('gen', 'Templates from GitHub | CSS:', stylesCSS.length, 'bytes | JS:', appJS.length, 'bytes');
  }

  if (onStatusUpdate) await onStatusUpdate(':arrows_counterclockwise: Deploying to Vercel...');

  // Inject scraped Google Fonts into index.html if available
  let indexHTML = getIndexHTML();
  if (scraped.googleFontsUrl) {
    indexHTML = indexHTML.replace('</head>', `  <link href="${scraped.googleFontsUrl}" rel="stylesheet">\n</head>`);
    log('gen', 'Injected Google Fonts link:', scraped.googleFontsUrl.substring(0, 80));
  }

  const slug = slugify(brandName);
  const projectName = `cylindo-demo-${slug}`;
  const files = [
    { path: 'index.html', content: indexHTML },
    { path: 'styles.css', content: stylesCSS },
    { path: 'app.js', content: appJS },
    { path: 'config.json', content: JSON.stringify(config, null, 2) },
  ];

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

// ---- Generation with Status Tracker ----

async function runGenerationWithTracker({ customerId, productCodes, curatorCode, brandName, brandUrl, userId, channelId }) {
  const channel = channelId || DEMO_CHANNEL;
  const trackerParams = { brandName, customerId, curatorCode, productCodes, brandUrl, userId };

  // 1. Post initial "Submitted" message
  let messageTs = null;
  try {
    const initResult = await slackPostMessage(channel, `Demo request: ${brandName}`,
      buildTrackerBlocks({ ...trackerParams, status: 'Submitted', statusEmoji: ':hourglass_flowing_sand:', statusDetail: 'Your demo is queued and will begin generating shortly...' })
    );
    messageTs = initResult.data?.ts != null ? String(initResult.data.ts) : null;
    if (!messageTs || initResult.data?.ok === false) {
      log('tracker', 'Initial post missing ts or not ok:', JSON.stringify(initResult.data || {}));
    } else {
      log('tracker', 'Initial message posted, ts:', messageTs);
    }
  } catch (msgErr) {
    log('tracker', 'FAILED to post initial message:', msgErr.message);
  }

  // Status update callback
  const onStatusUpdate = async (detail) => {
    try {
      await slackUpdateMessage(channel, messageTs, `Generating: ${brandName}`,
        buildTrackerBlocks({ ...trackerParams, status: 'In Progress', statusEmoji: ':arrows_counterclockwise:', statusDetail: detail })
      );
    } catch (e) {
      log('tracker', 'Status update failed:', e.message);
    }
  };

  // 2. Run generation
  try {
    const result = await generateDemo({ customerId, productCodes, curatorCode, brandName, brandUrl, onStatusUpdate });

    // 3. Final update — "Created"
    await slackUpdateMessage(channel, messageTs, `Demo ready: ${brandName}`,
      buildTrackerBlocks({ ...trackerParams, status: 'Created', statusEmoji: ':white_check_mark:', demoUrl: result.demoUrl, statusParts: result.statusParts })
    );
    log('tracker', 'Final status: Created |', result.demoUrl);
  } catch (error) {
    log('error', 'GENERATION FAILED:', error.message, error.stack);

    // 3. Final update — "Failed"
    try {
      await slackUpdateMessage(channel, messageTs, `Demo failed: ${brandName}`,
        buildTrackerBlocks({ ...trackerParams, status: 'Failed', statusEmoji: ':x:', errorMessage: error.message })
      );
    } catch (postErr) {
      log('error', 'Also failed to update tracker:', postErr.message);
    }
  }
}

// ============================================
//  MAIN HANDLER (Web `fetch` — required so @vercel/functions waitUntil registers)
// ============================================

async function parseSlackRequestBody(request) {
  const raw = await request.text();
  if (!raw || !raw.trim()) return {};
  const ct = (request.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('application/json')) {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  const params = new URLSearchParams(raw);
  const out = {};
  for (const [key, value] of params) out[key] = value;
  return out;
}

const slackFetchHandler = {
  async fetch(request) {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    let body;
    try {
      body = await parseSlackRequestBody(request);
    } catch (e) {
      log('handler', 'Body parse error:', e.message);
      return new Response('', { status: 400 });
    }

    // ---- Slash command: /cylindo-demo ----
    if (body.command === '/cylindo-demo') {
      if (body.text && body.text.trim().toLowerCase() === 'setup') {
        try {
          await postButtonMessage(body.channel_id);
          return Response.json({
            response_type: 'ephemeral',
            text: ':white_check_mark: Demo Generator button posted! Pin the message to keep it accessible.',
          });
        } catch (err) {
          return Response.json({
            response_type: 'ephemeral',
            text: `:x: Failed to post button: ${err.message}`,
          });
        }
      }

      const triggerId = body.trigger_id;
      if (!triggerId) {
        return Response.json({
          response_type: 'ephemeral',
          text: ':warning: No trigger_id received. Please try again.',
        });
      }

      try {
        const result = await openModal(triggerId, body.channel_id);
        if (result.data && !result.data.ok) {
          return Response.json({
            response_type: 'ephemeral',
            text: `:warning: Could not open form: ${result.data.error || 'unknown error'}`,
          });
        }
        return new Response('', { status: 200 });
      } catch (err) {
        return Response.json({
          response_type: 'ephemeral',
          text: `:x: Error opening form: ${err.message}`,
        });
      }
    }

    // ---- Interactive payloads (button clicks + modal submissions) ----
    if (body.payload) {
      const payload = JSON.parse(body.payload);

      if (payload.type === 'block_actions') {
        const action = payload.actions && payload.actions[0];
        if (action && action.action_id === 'open_demo_form') {
          log('button', 'Create Demo button clicked by', payload.user?.name);
          try {
            await openModal(payload.trigger_id, payload.channel?.id || DEMO_CHANNEL);
          } catch (err) {
            log('button', 'Failed to open modal:', err.message);
          }
          return new Response('', { status: 200 });
        }
        return new Response('', { status: 200 });
      }

      if (payload.type === 'view_submission' && payload.view.callback_id === 'cylindo_demo_submit') {
        const values = payload.view.state.values;
        const userId = payload.user.id;

        const customerId = values.customer_id.value.value.trim();
        const productCodesRaw = values.product_codes.value.value.trim();
        const curatorCode = values.curator_code.value.value.trim();
        const brandName = values.brand_name.value.value.trim();
        const brandUrl = values.brand_url?.value?.value?.trim() || '';

        let channelId = DEMO_CHANNEL;
        try {
          const meta = JSON.parse(payload.view.private_metadata || '{}');
          if (meta.channel_id) channelId = meta.channel_id;
        } catch {}

        const productCodes = productCodesRaw.split(',').map((p) => p.trim()).filter(Boolean);

        log('submit', 'Modal submitted by', payload.user?.name, '| brand:', brandName, '| products:', productCodes.join(', '));

        waitUntil(
          runGenerationWithTracker({
            customerId, productCodes, curatorCode, brandName, brandUrl, userId, channelId,
          }).catch((err) => {
            log('waitUntil', 'runGenerationWithTracker rejected:', err.message, err.stack);
          })
        );

        return Response.json({ response_action: 'clear' });
      }

      return new Response('', { status: 200 });
    }

    if (body.trigger_id) {
      try {
        await openModal(body.trigger_id);
        return new Response('', { status: 200 });
      } catch (err) {
        return Response.json({ response_type: 'ephemeral', text: `:x: Error: ${err.message}` });
      }
    }

    return Response.json({ response_type: 'ephemeral', text: 'Type `/cylindo-demo` to open the demo generator form.' });
  },
};

module.exports = slackFetchHandler;
module.exports.default = slackFetchHandler;
