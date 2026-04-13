/* ============================================
   Cylindo Demo Generator
   Config-driven PDP + Dynamic Tear Sheet

   Required inputs per demo:
   - Customer Account Number (e.g. 4404)
   - Curator Embed Code (e.g. a7ap4vak)
   - Company URL (e.g. serenaandlily.com)
   - Link to demo product(s) from Cylindo CMS

   Everything else auto-populates from config.json
   ============================================ */

let config = null;
let currentProductIndex = 0;
let currentFeatures = {}; // Track current feature selections for tear sheet

const CONTENT_API = 'https://content.cylindo.com/api/v2';

// Feature icons
const featureIcons = [
  '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',
  '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>',
  '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
  '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>'
];

// ---- Helpers ----

function getContentAPIUrl(productCode, path, featureParams) {
  const customerId = config.cylindo.customerId;
  const encodedCode = encodeURIComponent(productCode);
  let url = `${CONTENT_API}/${customerId}/products/${encodedCode}/${path}`;
  if (featureParams) {
    const params = Object.entries(featureParams)
      .map(([k, v]) => `feature=${encodeURIComponent(k)}:${encodeURIComponent(v)}`)
      .join('&');
    url += (url.includes('?') ? '&' : '?') + params;
  }
  return url;
}

function getProductImageUrl(productCode, frame, features, size) {
  let url = `${CONTENT_API}/${config.cylindo.customerId}/products/${encodeURIComponent(productCode)}/frames/${frame || 1}/product.jpg?size=${size || 1024}`;
  if (features) {
    Object.entries(features).forEach(([k, v]) => {
      url += `&feature=${encodeURIComponent(k)}:${encodeURIComponent(v)}`;
    });
  }
  return url;
}

function getSwatchUrl(productCode, featureCode, optionValue, size) {
  return `${CONTENT_API}/${config.cylindo.customerId}/products/${encodeURIComponent(productCode)}/material/swatch.jpeg?feature=${encodeURIComponent(featureCode)}:${encodeURIComponent(optionValue)}&size=${size || 200}`;
}

function getOptionSwatchColor(option) {
  if (!option || typeof option !== 'object') return '';
  const raw = option.swatchColor || option.color || option.hex || '';
  if (typeof raw !== 'string') return '';
  const color = raw.trim();
  if (!color) return '';
  if (color.startsWith('#')) return color;
  if (/^[0-9a-fA-F]{6}$/.test(color) || /^[0-9a-fA-F]{3}$/.test(color)) return `#${color}`;
  return color;
}

function buildSwatchButtonMarkup(productCode, feature, option, isActive) {
  const swatchColor = getOptionSwatchColor(option);
  const classes = `fabric-btn${isActive ? ' active' : ''}${swatchColor ? ' color-swatch' : ''}`;
  const colorMarkup = swatchColor
    ? `<span class="fabric-color-chip" style="background:${swatchColor}"></span>`
    : `<img src="${getSwatchUrl(productCode, feature.code, option.value, 200)}" alt="${option.name}" loading="lazy" onerror="this.style.display='none'; this.parentElement.classList.add('fallback')">`;
  return `<button type="button" class="${classes}" data-value="${option.value}" data-name="${option.name}" aria-label="${feature.label}: ${option.name}" title="${option.name}">${colorMarkup}</button>`;
}

function getPlaceholderUrl(productCode) {
  return `${CONTENT_API}/${config.cylindo.customerId}/products/${encodeURIComponent(productCode)}/default/${config.cylindo.remoteConfig}/placeholder.webp?size=768`;
}

function applyViewerAspectRatio(productCode) {
  const container = document.getElementById('cylindo-container');
  if (!container) return;

  const fallbackRatio = '1 / 1';
  container.style.aspectRatio = fallbackRatio;

  const probe = new Image();
  probe.onload = () => {
    if (probe.naturalWidth > 0 && probe.naturalHeight > 0) {
      container.style.aspectRatio = `${probe.naturalWidth} / ${probe.naturalHeight}`;
    }
  };
  probe.onerror = () => {
    container.style.aspectRatio = fallbackRatio;
  };
  probe.src = getPlaceholderUrl(productCode);
}

function formatDate() {
  return new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

// ---- Config & Routing ----

async function loadConfig() {
  const response = await fetch('config.json');
  config = await response.json();
  return config;
}

function getProductFromURL() {
  const params = new URLSearchParams(window.location.search);
  const productId = params.get('product');
  if (productId) {
    const idx = config.products.findIndex(p => p.id === productId);
    if (idx >= 0) return idx;
  }
  return 0;
}

function updateURL() {
  const product = config.products[currentProductIndex];
  const url = new URL(window.location);
  url.searchParams.set('product', product.id);
  window.history.pushState({}, '', url);
}

// ---- Render Brand (one-time) ----

function applyTheme() {
  const t = config.brand.theme;
  if (!t) return;
  const r = document.documentElement;
  const set = (prop, val) => {
    if (val != null && val !== '') r.style.setProperty(prop, val);
  };
  set('--font-heading', t.fontHeading);
  set('--font-body', t.fontBody);
  set('--color-bg', t.colorBg);
  set('--color-bg-alt', t.colorBgAlt);
  set('--color-text', t.colorText);
  set('--color-text-secondary', t.colorTextSecondary);
  set('--color-accent', t.colorAccent);
  set('--color-accent-hover', t.colorAccentHover);
  set('--color-border', t.colorBorder);
  set('--color-success', t.colorSuccess);
  set('--announcement-bg', t.colorAnnouncementBg);
  set('--announcement-text', t.colorAnnouncementText);
  set('--header-bg', t.colorHeaderBg);
  set('--header-border', t.colorHeaderBorder);
  set('--header-dark-bg', t.colorHeaderDarkBg);
  set('--header-dark-border', t.colorHeaderDarkBorder);
  set('--header-dark-text', t.colorHeaderDarkText);
  set('--header-dark-muted', t.colorHeaderDarkMuted);
  set('--nav-sale-accent', t.colorNavSaleAccent);
  if (t.headerStickyOffset) set('--header-sticky-offset', t.headerStickyOffset);
}

function buildLogoMarkup(brand) {
  if (brand.logoImageUrl) {
    if (brand.logoImageUrlDark) {
      return `<picture class="logo-picture"><source srcset="${brand.logoImageUrlDark}" media="(prefers-color-scheme: dark)" /><img src="${brand.logoImageUrl}" alt="${brand.name}" class="logo-image" /></picture>`;
    }
    return `<img src="${brand.logoImageUrl}" alt="${brand.name}" class="logo-image" />`;
  }
  return '';
}

function renderBrand() {
  applyTheme();
  const { brand } = config;
  const darkRetail = brand.headerVariant === 'dark-retail';

  document.documentElement.classList.toggle('header-variant-dark-retail', darkRetail);

  const annBlock = document.getElementById('header-announcement-block');
  const defWrap = document.getElementById('header-default-wrap');
  const drWrap = document.getElementById('header-dark-retail-wrap');
  const hasAnnouncement = !!(brand.announcementText && String(brand.announcementText).trim());

  if (annBlock) annBlock.hidden = darkRetail || !hasAnnouncement;
  if (defWrap) defWrap.hidden = darkRetail;
  if (drWrap) drWrap.hidden = !darkRetail;

  const announcement = document.getElementById('announcement-bar');
  if (announcement) announcement.textContent = brand.announcementText || '';

  const logoDefault = document.getElementById('logo-default');
  const logoDr = document.getElementById('logo-dark-retail');
  const logoMarkup = buildLogoMarkup(brand);
  [logoDefault, logoDr].forEach((logo) => {
    if (!logo) return;
    if (logoMarkup) logo.innerHTML = logoMarkup;
    else logo.textContent = brand.logoText || brand.name;
  });

  const subline = document.getElementById('logo-subline');
  if (subline) {
    subline.textContent = brand.logoSubline || '';
    subline.style.display = brand.logoSubline ? '' : 'none';
  }

  const searchInput = document.getElementById('hdr-search-input');
  if (searchInput) searchInput.placeholder = brand.searchPlaceholder || 'Search';

  const navDefault = document.getElementById('main-nav');
  if (navDefault) {
    navDefault.innerHTML = (brand.navLinks || []).map((link) =>
      `<a href="#"${link === brand.navHighlight ? ' class="nav-highlight"' : ''}>${link}</a>`
    ).join('');
  }

  const navDr = document.getElementById('main-nav-dark-retail');
  if (navDr) {
    navDr.innerHTML = (brand.navLinks || []).map((link) =>
      `<a href="#"${link === brand.navHighlight ? ' class="nav-highlight"' : ''}>${link}</a>`
    ).join('');
  }

  const navSec = document.getElementById('nav-secondary-dark-retail');
  if (navSec) {
    const right = brand.navLinksRight || [];
    navSec.innerHTML = right.map((item) => {
      const label = typeof item === 'string' ? item : item.label;
      const accent = typeof item === 'object' && item.accent;
      return `<a href="#" class="${accent ? 'nav-sale-accent' : ''}">${label}</a>`;
    }).join('');
  }

  const footerGrid = document.getElementById('footer-grid');
  footerGrid.innerHTML = brand.footerColumns.map(col => {
    if (col.social) {
      return `<div class="footer-col"><h4>${col.title}</h4><div class="social-links">${col.social.map(s => `<a href="#">${s}</a>`).join('')}</div></div>`;
    }
    return `<div class="footer-col"><h4>${col.title}</h4>${col.links.map(l => `<a href="#">${l}</a>`).join('')}</div>`;
  }).join('');

  document.getElementById('footer-copyright').innerHTML = `&copy; 2026 ${brand.footerCopyright}. All rights reserved.`;
  document.title = `Cylindo Demo — ${brand.name}`;
}

// ---- Product Switcher ----

function renderProductSwitcher() {
  const switcher = document.getElementById('product-switcher');
  if (config.products.length <= 1) { switcher.style.display = 'none'; return; }

  switcher.innerHTML = `<div class="switcher-inner">
    <span class="switcher-label">Demo Products:</span>
    ${config.products.map((p, i) =>
      `<button class="switcher-btn${i === currentProductIndex ? ' active' : ''}" data-index="${i}">${p.name}</button>`
    ).join('')}
  </div>`;

  switcher.querySelectorAll('.switcher-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.index);
      if (idx !== currentProductIndex) {
        currentProductIndex = idx;
        updateURL();
        renderProduct();
        renderProductSwitcher();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
  });
}

// ---- Render Product ----

function renderProduct() {
  const product = config.products[currentProductIndex];
  const { cylindo } = config;
  applyViewerAspectRatio(product.code);

  // Reset current features to defaults
  currentFeatures = {};
  product.features.forEach(f => {
    currentFeatures[f.code] = f.options[0].value;
  });

  document.title = `${product.name} — ${config.brand.name} | Cylindo Demo`;

  // Breadcrumb
  const breadcrumb = document.getElementById('breadcrumb');
  breadcrumb.innerHTML = product.breadcrumb.map(c =>
    `<a href="#">${c}</a><span class="sep">/</span>`
  ).join('') + `<span class="current">${product.name}</span>`;

  // Cylindo Viewer — Curator Gallery Mode
  const container = document.getElementById('cylindo-container');
  container.innerHTML = `
    <cylindo-viewer
      customer-id="${cylindo.customerId}"
      code="${product.code}"
      remote-config="${cylindo.remoteConfig}"
      presentation="gallery"
      background-color="#ffffff"
      controls="ar fullscreen nav zoom indicators"
      interaction-hiding-delay="Infinity"
      ignore-unknown-features="true"
      style="background:#ffffff;"
    >
      <img alt="${product.name}" slot="placeholder" src="${getPlaceholderUrl(product.code)}" />
    </cylindo-viewer>
  `;

  // Curator meta badge
  const curatorMeta = document.getElementById('curator-meta');
  if (curatorMeta) {
    curatorMeta.innerHTML = `
      <span class="curator-pill">Cylindo Curator</span>
      <span class="curator-copy">${product.name} \u00b7 ${product.code}</span>
    `;
  }

  // Stars
  const fullStars = Math.floor(product.rating);
  const hasHalf = product.rating % 1 >= 0.5;
  let starsHTML = '';
  for (let i = 0; i < 5; i++) {
    if (i < fullStars) starsHTML += '<span class="star filled">&#9733;</span>';
    else if (i === fullStars && hasHalf) starsHTML += '<span class="star half">&#9733;</span>';
    else starsHTML += '<span class="star">&#9733;</span>';
  }

  // Badges
  const badgesHTML = product.badges.map(b => `<span class="badge badge-${b.type}">${b.text}</span>`).join('');

  // Configurator options (reference PDP: label + selected value row, circular swatches)
  let optionsHTML = '<div class="configurator-block">';
  product.features.forEach(feature => {
    const firstOption = feature.options[0];
    optionsHTML += `
      <div class="option-group">
        <div class="option-label-row">
          <span class="option-label">${feature.label}</span>
          <span class="option-value-label feature-selected" data-feature="${feature.code}">${firstOption.name}</span>
        </div>
        <div class="fabric-options" data-feature-code="${feature.code}">
          ${feature.options.map((opt, i) => buildSwatchButtonMarkup(product.code, feature, opt, i === 0)).join('')}
        </div>
      </div>
    `;
  });
  optionsHTML += '</div>';

  // Product Info (title → price → social proof → description → configurator — common reference order)
  document.getElementById('product-info').innerHTML = `
    <div class="product-badges">${badgesHTML}</div>
    <h1 class="product-title">${product.name}</h1>
    <div class="product-price">
      <span class="price-current">${product.price}</span>
      ${product.priceNote ? `<span class="price-note">${product.priceNote}</span>` : ''}
    </div>
    <div class="product-rating">
      <div class="stars">${starsHTML}</div>
      <span class="rating-count">${product.rating} (${product.reviewCount} reviews)</span>
    </div>
    <p class="product-description">${product.description}</p>
    <hr class="divider">
    ${optionsHTML}
    <div class="purchase-row">
      <div class="quantity-control">
        <button class="qty-btn" id="qty-minus">&minus;</button>
        <input type="number" value="1" min="1" max="99" class="qty-input" id="qty-input">
        <button class="qty-btn" id="qty-plus">+</button>
      </div>
      <button class="add-to-cart-btn">Add to Cart</button>
    </div>
    <div class="lead-time">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
      <span>${product.leadTime}</span>
    </div>
    <div class="trust-badges">
      <div class="trust-badge">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>
        <span>White Glove Delivery</span>
      </div>
      <div class="trust-badge">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        <span>Lifetime Frame Warranty</span>
      </div>
      <div class="trust-badge">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        <span>Free Swatches</span>
      </div>
    </div>
  `;

  // Features section
  document.getElementById('features-grid').innerHTML = product.highlights.map((h, i) => `
    <div class="feature-card">
      <div class="feature-icon">${featureIcons[i % featureIcons.length]}</div>
      <h3>${h.title}</h3>
      <p>${h.description}</p>
    </div>
  `).join('');

  // Specs
  document.getElementById('specs-grid').innerHTML = product.specs.map(group => `
    <div class="spec-group">
      <h3>${group.group}</h3>
      <table class="spec-table">
        ${group.items.map(([label, value]) => `<tr><td>${label}</td><td>${value}</td></tr>`).join('')}
      </table>
    </div>
  `).join('');

  // FAQs
  document.getElementById('faq-list').innerHTML = product.faqs.map(faq => `
    <details class="faq-item">
      <summary>${faq.q}</summary>
      <p>${faq.a}</p>
    </details>
  `).join('');

  bindInteractions();
}

// ---- Interactions ----

function bindInteractions() {
  const viewer = document.querySelector('cylindo-viewer');

  // Fabric buttons
  document.querySelectorAll('.fabric-options').forEach(group => {
    const featureCode = group.dataset.featureCode;
    const selectedLabel = document.querySelector(`.feature-selected[data-feature="${featureCode}"]`);

    group.querySelectorAll('.fabric-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        group.querySelectorAll('.fabric-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        if (selectedLabel) selectedLabel.textContent = btn.dataset.name;

        // Track the current selection
        currentFeatures[featureCode] = btn.dataset.value;

        // Update Cylindo viewer
        if (viewer) {
          try {
            const features = {};
            features[featureCode] = btn.dataset.value;
            viewer.features = features;
          } catch (e) {
            console.log('Cylindo feature update:', featureCode, btn.dataset.value);
          }
        }
      });
    });
  });

  // Quantity
  const qtyInput = document.getElementById('qty-input');
  const qtyMinus = document.getElementById('qty-minus');
  const qtyPlus = document.getElementById('qty-plus');

  if (qtyMinus) {
    qtyMinus.addEventListener('click', () => {
      const val = parseInt(qtyInput.value) || 1;
      if (val > 1) qtyInput.value = val - 1;
    });
  }
  if (qtyPlus) {
    qtyPlus.addEventListener('click', () => {
      const val = parseInt(qtyInput.value) || 1;
      if (val < 99) qtyInput.value = val + 1;
    });
  }

  // Add to Cart (update every cart badge — default header + dark-retail header)
  const addToCartBtn = document.querySelector('.add-to-cart-btn');
  const cartCountEls = document.querySelectorAll('.cart-count');

  if (addToCartBtn && cartCountEls.length) {
    addToCartBtn.addEventListener('click', () => {
      const qty = parseInt(qtyInput.value) || 1;
      const current = parseInt(cartCountEls[0].textContent, 10) || 0;
      const next = String(current + qty);
      cartCountEls.forEach((el) => { el.textContent = next; });
      addToCartBtn.textContent = 'Added!';
      addToCartBtn.classList.add('added-state');
      setTimeout(() => {
        addToCartBtn.textContent = 'Add to Cart';
        addToCartBtn.classList.remove('added-state');
      }, 1500);
    });
  }

  // FAQ accordion
  document.querySelectorAll('.faq-item').forEach(item => {
    item.querySelector('summary').addEventListener('click', () => {
      document.querySelectorAll('.faq-item').forEach(other => {
        if (other !== item && other.hasAttribute('open')) other.removeAttribute('open');
      });
    });
  });

  // Tear Sheet button
  document.getElementById('tearsheet-btn').addEventListener('click', openTearSheet);
}

// ============================================
//  TEAR SHEET GENERATION
//  Reflects the current viewer configuration
// ============================================

function openTearSheet() {
  const product = config.products[currentProductIndex];
  const overlay = document.getElementById('tearsheet-overlay');
  const content = document.getElementById('tearsheet-content');

  // Get current feature selections (readable names)
  const currentSelections = {};
  product.features.forEach(f => {
    const activeBtn = document.querySelector(`.fabric-options[data-feature-code="${f.code}"] .fabric-btn.active`);
    currentSelections[f.code] = {
      label: f.label,
      name: activeBtn ? activeBtn.dataset.name : f.options[0].name,
      value: currentFeatures[f.code] || f.options[0].value
    };
  });

  // Build configuration string for display
  const configStr = Object.values(currentSelections).map(s => `${s.label}: ${s.name}`).join(' | ');

  // Hero image URL from Content API with current features
  const heroImageUrl = getProductImageUrl(product.code, 1, currentFeatures, 1024);

  // Second angle
  const angleImageUrl = getProductImageUrl(product.code, 9, currentFeatures, 768);

  // Swatch images for all options in each feature
  let swatchesHTML = '';
  product.features.forEach(feature => {
    swatchesHTML += `
      <div class="ts-swatches-section">
        <h3 class="ts-swatches-title">Available ${feature.label} Options</h3>
        <div class="ts-swatches-grid">
          ${feature.options.map(opt => {
            const isActive = currentFeatures[feature.code] === opt.value;
            const swatchUrl = getSwatchUrl(product.code, feature.code, opt.value, 200);
            return `
              <div class="ts-swatch-item${isActive ? ' active' : ''}">
                <div class="ts-swatch-img"><img src="${swatchUrl}" alt="${opt.name}" onerror="this.style.display='none'"></div>
                <div class="ts-swatch-name">${opt.name}${isActive ? ' (shown)' : ''}</div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  });

  // Specs tables
  const specsHTML = `
    <div class="ts-specs-section">
      <div class="ts-specs-grid">
        ${product.specs.map(group => `
          <div class="ts-specs-group">
            <h4>${group.group}</h4>
            <table class="ts-specs-table">
              ${group.items.map(([label, value]) => `<tr><td>${label}</td><td>${value}</td></tr>`).join('')}
            </table>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  // Highlights
  const highlightsHTML = product.highlights.map(h =>
    `<li><strong>${h.title}</strong> — ${h.description}</li>`
  ).join('');

  // Assemble tear sheet
  content.innerHTML = `
    <div class="ts-header">
      <div>
        <div class="ts-brand">${config.brand.logoText}</div>
        <div class="ts-brand-tag">${config.brand.tagline || ''}</div>
      </div>
      <div class="ts-meta">
        <div class="ts-meta-date">${formatDate()}</div>
        <div>Product Tear Sheet</div>
        <div>Customer #${config.cylindo.customerId}</div>
      </div>
    </div>

    <h2 class="ts-product-title">${product.name}</h2>
    <div class="ts-product-config">${configStr}</div>

    <div class="ts-hero">
      <div class="ts-hero-image">
        <img src="${heroImageUrl}" alt="${product.name} - ${configStr}">
      </div>
      <div class="ts-hero-info">
        <div class="ts-price">${product.price}</div>
        <p class="ts-description">${product.description}</p>
        <ul class="ts-highlights">${highlightsHTML}</ul>
      </div>
    </div>

    ${swatchesHTML}
    ${specsHTML}

    <div class="ts-footer">
      <div>&copy; 2026 ${config.brand.name}. All specifications subject to change.</div>
      <div class="ts-cylindo">3D Visualization by Cylindo</div>
    </div>
  `;

  // Show modal
  overlay.classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeTearSheet() {
  document.getElementById('tearsheet-overlay').classList.remove('active');
  document.body.style.overflow = '';
}

// ---- Browser History ----
window.addEventListener('popstate', () => {
  currentProductIndex = getProductFromURL();
  renderProduct();
  renderProductSwitcher();
});

// ---- Initialize ----
document.addEventListener('DOMContentLoaded', async () => {
  await loadConfig();
  currentProductIndex = getProductFromURL();
  renderBrand();
  renderProductSwitcher();
  renderProduct();

  // Tear sheet modal close handlers
  document.getElementById('tearsheet-close').addEventListener('click', closeTearSheet);
  document.getElementById('tearsheet-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeTearSheet();
  });
  document.getElementById('tearsheet-print-btn').addEventListener('click', () => {
    window.print();
  });

  // Close on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeTearSheet();
  });
});
