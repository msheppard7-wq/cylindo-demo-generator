#!/usr/bin/env node

/* ============================================
   Cylindo Demo Generator CLI

   Generates a branded demo site with Cylindo 3D viewer
   and dynamic tear sheet — all data pulled from Content API.

   Usage:
     node generate.js \
       --customer 4404 \
       --products "HAVEN COMFORT ARM SOFA,NORFOLK WIDE ARM PLEATED SOFA" \
       --curator a7ap4vak \
       --brand "Serena & Lily" \
       --url https://www.serenaandlily.com

   Output:
     ./output/<brand-slug>/ — ready-to-deploy site folder
   ============================================ */

const fs = require('fs');
const path = require('path');
const https = require('https');

// ---- Argument Parsing ----

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const value = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
      parsed[key] = value;
      if (value !== true) i++;
    }
  }

  if (!parsed.customer || !parsed.products || !parsed.curator) {
    console.log(`
╔══════════════════════════════════════════════════════╗
║         Cylindo Demo Generator                       ║
╚══════════════════════════════════════════════════════╝

Usage:
  node generate.js \\
    --customer <account-number> \\
    --products "<PRODUCT CODE 1>,<PRODUCT CODE 2>" \\
    --curator <curator-code> \\
    --brand "<Brand Name>" \\
    --url <client-website-url>

Required:
  --customer   Cylindo customer account number (e.g. 4404)
  --products   Comma-separated product codes (from Cylindo CMS)
  --curator    Curator remote-config code (e.g. a7ap4vak)

Optional:
  --brand      Brand display name (e.g. "Serena & Lily")
  --url        Client website URL for branding reference
  --output     Output directory (default: ./output/<brand-slug>)

Example:
  node generate.js \\
    --customer 4404 \\
    --products "HAVEN COMFORT ARM SOFA,NORFOLK WIDE ARM PLEATED SOFA" \\
    --curator a7ap4vak \\
    --brand "Serena & Lily" \\
    --url https://www.serenaandlily.com
`);
    process.exit(1);
  }

  return parsed;
}

// ---- HTTP Helpers ----

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
      if (res.statusCode === 404) return resolve(null);
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve(null); } // Some endpoints return images, not JSON
      });
    }).on('error', reject);
  });
}

function checkImageExists(url) {
  return new Promise((resolve) => {
    https.get(url, { method: 'HEAD' }, (res) => {
      resolve(res.statusCode === 200);
    }).on('error', () => resolve(false));
  });
}

// ---- Content API ----

const CONTENT_API = 'https://content.cylindo.com/api/v2';

async function fetchProductConfig(customerId, productCode) {
  const encoded = encodeURIComponent(productCode);
  const url = `${CONTENT_API}/${customerId}/products/${encoded}/configuration`;
  console.log(`  📡 Fetching configuration for "${productCode}"...`);

  const data = await fetchJSON(url);
  if (!data) {
    console.log(`  ⚠️  No configuration found for "${productCode}"`);
    return null;
  }
  return data;
}

function extractFeatures(configData) {
  const features = [];

  if (!configData || !configData.features) return features;

  for (const feature of configData.features) {
    const featureName = feature.name || feature.code || 'Unknown';
    const featureCode = feature.code || feature.name || 'UNKNOWN';

    const options = [];
    if (feature.options) {
      for (const opt of feature.options) {
        options.push({
          name: formatOptionName(opt.name || opt.code || opt),
          value: opt.code || opt.name || opt
        });
      }
    }

    features.push({
      code: featureCode,
      label: formatFeatureName(featureName),
      options
    });
  }

  return features;
}

function extractDimensions(configData) {
  if (!configData || !configData.dimensions) return null;
  return configData.dimensions;
}

// ---- Name Formatting ----

function formatFeatureName(name) {
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}

function formatOptionName(name) {
  if (!name) return 'Unknown';
  // Clean up codes like "PERENNIALS PERFORMANCE BASKETWEAVE COASTAL BLUE"
  return name
    .split(/[\s_-]+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function productIdFromCode(code) {
  return slugify(code);
}

// ---- Brand Defaults (can be enhanced with scraping in Phase 2) ----

function brandPresetForName(brandName) {
  const n = (brandName || '').toLowerCase().replace(/\u2019/g, "'");
  if (!n.includes('haverty')) return null;
  return {
    logoText: 'HAVERTYS',
    logoSubline: 'FURNITURE · EST 1885',
    headerVariant: 'dark-retail',
    announcementText: '',
    searchPlaceholder: 'Search',
    navLinks: [
      'LIVING', 'BEDROOM', 'DINING', 'MATTRESSES', 'OFFICE', 'DECOR',
      'FREE DESIGN SERVICE', 'FINANCING', 'REGRET-FREE GUARANTEE'
    ],
    navLinksRight: [
      { label: 'SALE', accent: true },
      { label: 'Spring Style Event', accent: false }
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
      headerStickyOffset: '214px'
    }
  };
}

function getBrandConfig(brandName, websiteUrl) {
  const name = brandName || 'Demo Brand';
  const preset = brandPresetForName(name) || {};
  const presetTheme = preset.theme || {};
  const { theme: _pt, ...presetRest } = preset;
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
    ...presetTheme
  };
  return {
    name,
    logoText: name,
    tagline: 'Cylindo 3D Product Visualization Demo',
    website: websiteUrl || '#',
    announcementText: `Cylindo 3D Product Visualization Demo — ${name}`,
    navLinks: ['Living', 'Bedroom', 'Dining', 'Outdoor', 'Sale'],
    navHighlight: 'Living',
    navLinksRight: [],
    headerVariant: undefined,
    logoSubline: '',
    searchPlaceholder: 'Search',
    footerCopyright: `${name} — Cylindo Demo`,
    footerColumns: [
      { title: 'Customer Care', links: ['Contact Us', 'Shipping & Returns', 'FAQ', 'Design Services'] },
      { title: 'About', links: ['Our Story', 'Design Philosophy', 'Sustainability', 'Careers'] },
      { title: 'Explore', links: ['New Arrivals', 'Best Sellers', 'Collections', 'Inspiration'] }
    ],
    ...presetRest,
    theme
  };
}

// ---- Product Template ----

function buildProductEntry(productCode, features, index) {
  const name = formatOptionName(productCode); // "Haven Comfort Arm Sofa"
  const id = productIdFromCode(productCode);

  return {
    id,
    name,
    code: productCode,
    price: '$0.00',
    priceNote: 'Contact for pricing',
    rating: 4.8,
    reviewCount: 0,
    description: `Explore the ${name} in full 360° with Cylindo's interactive 3D viewer. Select different options to see the product update in real-time.`,
    badges: [
      { text: 'Cylindo 3D', type: 'new' }
    ],
    breadcrumb: ['Home', 'Products'],
    features,
    highlights: [
      { title: 'Interactive 3D', description: 'Rotate, zoom, and explore every angle with Cylindo\'s 360° viewer.' },
      { title: 'Real-Time Configuration', description: 'Select different options and watch the product update instantly.' },
      { title: 'Material Swatches', description: 'View accurate material representations pulled from Cylindo Content API.' },
      { title: 'Tear Sheet', description: 'Generate a downloadable tear sheet with current configuration.' },
      { title: 'Seamless Integration', description: 'This viewer integrates directly into any e-commerce platform.' }
    ],
    specs: [
      {
        group: 'Product Information',
        items: [
          ['Product Code', productCode],
          ['Available Options', `${features.reduce((sum, f) => sum + f.options.length, 0)} configurations`],
          ['3D Viewer', 'Cylindo Viewer v5'],
          ['Viewer Type', '360° + Zoom']
        ]
      }
    ],
    faqs: [
      { q: 'What am I looking at?', a: 'This is a Cylindo-powered product demo showing how the 3D viewer integrates into a branded product page.' },
      { q: 'Can I interact with the 3D view?', a: 'Yes! Click and drag to rotate, scroll to zoom, and use the option selectors to change the product configuration in real-time.' },
      { q: 'How are the material swatches generated?', a: 'Swatches are pulled directly from the Cylindo Content API, ensuring they match the actual rendered materials.' },
      { q: 'What is the tear sheet?', a: 'Click "Download Tear Sheet" to generate a printable product sheet showing the current configuration with specs and swatches.' }
    ],
    leadTime: 'Demo product — contact for availability'
  };
}

// ---- File Templates (copy from existing site files) ----

function getIndexHTML() {
  return fs.readFileSync(path.join(__dirname, 'templates', 'index.html'), 'utf-8');
}

function getStylesCSS() {
  return fs.readFileSync(path.join(__dirname, 'templates', 'styles.css'), 'utf-8');
}

function getAppJS() {
  return fs.readFileSync(path.join(__dirname, 'templates', 'app.js'), 'utf-8');
}

// ---- Main Generator ----

async function generate() {
  const args = parseArgs();

  console.log(`
╔══════════════════════════════════════════════════════╗
║         Cylindo Demo Generator                       ║
╚══════════════════════════════════════════════════════╝
`);

  const customerId = args.customer;
  const curatorCode = args.curator;
  const brandName = args.brand || 'Demo';
  const websiteUrl = args.url || '';
  const productCodes = args.products.split(',').map(p => p.trim());

  console.log(`🏢 Brand: ${brandName}`);
  console.log(`🔑 Customer ID: ${customerId}`);
  console.log(`🎨 Curator Code: ${curatorCode}`);
  console.log(`📦 Products: ${productCodes.length}`);
  console.log('');

  // 1. Fetch product data from Content API
  const products = [];

  for (const code of productCodes) {
    console.log(`\n── Product: ${code} ──`);

    const configData = await fetchProductConfig(customerId, code);
    const features = extractFeatures(configData);

    console.log(`  ✅ Found ${features.length} feature group(s)`);
    features.forEach(f => {
      console.log(`     └─ ${f.label}: ${f.options.length} options`);
    });

    // Check placeholder image
    const placeholderUrl = `${CONTENT_API}/${customerId}/products/${encodeURIComponent(code)}/default/${curatorCode}/placeholder.webp?size=768`;
    const hasPlaceholder = await checkImageExists(placeholderUrl);
    console.log(`  ${hasPlaceholder ? '✅' : '⚠️ '} Placeholder image ${hasPlaceholder ? 'available' : 'not found'}`);

    const product = buildProductEntry(code, features);
    products.push(product);
  }

  // 2. Build config
  const brand = getBrandConfig(brandName, websiteUrl);

  const config = {
    brand,
    cylindo: {
      customerId,
      remoteConfig: curatorCode
    },
    products
  };

  // 3. Write output
  const slug = slugify(brandName);
  const outputDir = args.output || path.join(__dirname, 'output', slug);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Write config.json
  fs.writeFileSync(
    path.join(outputDir, 'config.json'),
    JSON.stringify(config, null, 2)
  );

  // Copy site files
  fs.writeFileSync(path.join(outputDir, 'index.html'), getIndexHTML());
  fs.writeFileSync(path.join(outputDir, 'styles.css'), getStylesCSS());
  fs.writeFileSync(path.join(outputDir, 'app.js'), getAppJS());

  console.log(`
╔══════════════════════════════════════════════════════╗
║  ✅ Demo site generated!                              ║
╚══════════════════════════════════════════════════════╝

📁 Output: ${outputDir}

Files:
  ├── config.json    (product data from Content API)
  ├── index.html     (demo page template)
  ├── styles.css     (branded styles)
  └── app.js         (viewer + tear sheet logic)

Next steps:
  1. Review & edit config.json (add pricing, descriptions, etc.)
  2. Test locally:
     cd ${outputDir}
     npx serve .
  3. Deploy:
     - Push to GitHub → auto-deploys to Vercel
     - Or: npx vercel --prod

Tear Sheet:
  Open the demo site → click "Download Tear Sheet"
  → reflects current viewer config → Print/Save as PDF
`);
}

// ---- Run ----
generate().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
