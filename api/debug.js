const https = require('https');
const fs = require('fs');
const path = require('path');

function fetchJSON(url, headers) {
  return new Promise((resolve) => {
    const opts = { headers: { Accept: 'application/json', ...headers } };
    https.get(url, opts, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    }).on('error', (err) => resolve({ status: 0, data: err.message }));
  });
}

function slackAPI(method, token) {
  return new Promise((resolve) => {
    const opts = {
      hostname: 'slack.com',
      path: `/api/${method}`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ ok: false, error: 'parse_error' }); }
      });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.write('{}');
    req.end();
  });
}

module.exports = async function handler(req, res) {
  const checks = {};
  const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
  const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
  const DEMO_CHANNEL = process.env.SLACK_DEMO_CHANNEL || 'C0AQS5JV0KE';

  // 1. Environment variables
  checks.env = {
    SLACK_BOT_TOKEN: SLACK_BOT_TOKEN ? `${SLACK_BOT_TOKEN.substring(0, 8)}... (set)` : 'NOT SET',
    VERCEL_TOKEN: VERCEL_TOKEN ? `${VERCEL_TOKEN.substring(0, 8)}... (set)` : 'NOT SET',
    SLACK_DEMO_CHANNEL: DEMO_CHANNEL,
    VERCEL_TEAM_ID: process.env.VERCEL_TEAM_ID || '(not set)',
  };

  // 2. Template files accessible?
  const cssPath = path.join(process.cwd(), 'templates', 'styles.css');
  const jsPath = path.join(process.cwd(), 'templates', 'app.js');
  checks.templates = {
    styles_css: fs.existsSync(cssPath) ? `OK (${fs.statSync(cssPath).size} bytes)` : 'MISSING',
    app_js: fs.existsSync(jsPath) ? `OK (${fs.statSync(jsPath).size} bytes)` : 'MISSING',
    cwd: process.cwd(),
  };

  // 3. Slack token validity
  if (SLACK_BOT_TOKEN) {
    const authResult = await slackAPI('auth.test', SLACK_BOT_TOKEN);
    checks.slack_auth = {
      ok: authResult.ok,
      error: authResult.error || null,
      bot_user: authResult.user || null,
      team: authResult.team || null,
      scopes: authResult.ok ? 'Use /api/debug?scopes=1 to test channel access' : null,
    };
  } else {
    checks.slack_auth = { ok: false, error: 'SLACK_BOT_TOKEN not set' };
  }

  // 4. Slack channel access (optional, if ?channel=1)
  if (req.query && req.query.channel && SLACK_BOT_TOKEN) {
    const channelInfo = await new Promise((resolve) => {
      const opts = {
        hostname: 'slack.com',
        path: `/api/conversations.info?channel=${DEMO_CHANNEL}`,
        headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
      };
      https.get(opts, (r) => {
        let d = '';
        r.on('data', (c) => (d += c));
        r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ ok: false }); } });
      }).on('error', () => resolve({ ok: false, error: 'request_failed' }));
    });
    checks.slack_channel = {
      channel_id: DEMO_CHANNEL,
      ok: channelInfo.ok,
      error: channelInfo.error || null,
      name: channelInfo.channel?.name || null,
      is_member: channelInfo.channel?.is_member || null,
    };
  }

  // 5. Cylindo Content API
  const testProduct = req.query?.product || 'EVERLY SIDE DINING CHAIR';
  const testCustomer = req.query?.customer || '4404';
  const cyResult = await fetchJSON(
    `https://content.cylindo.com/api/v2/${testCustomer}/products/${encodeURIComponent(testProduct)}/configuration`
  );
  checks.cylindo_api = {
    status: cyResult.status,
    ok: cyResult.status === 200,
    product: testProduct,
    features: cyResult.status === 200 && cyResult.data?.features ? cyResult.data.features.length : 0,
  };

  // 6. Vercel token
  if (VERCEL_TOKEN) {
    const vResult = await fetchJSON('https://api.vercel.com/v9/projects?limit=1', {
      Authorization: `Bearer ${VERCEL_TOKEN}`,
    });
    checks.vercel_api = {
      ok: vResult.status === 200,
      status: vResult.status,
      error: vResult.status !== 200 ? (vResult.data?.error?.message || 'unknown') : null,
    };
  } else {
    checks.vercel_api = { ok: false, error: 'VERCEL_TOKEN not set' };
  }

  // Summary
  const allOk = checks.slack_auth.ok
    && checks.vercel_api.ok
    && checks.cylindo_api.ok
    && checks.templates.styles_css !== 'MISSING'
    && checks.templates.app_js !== 'MISSING';

  res.status(200).json({
    status: allOk ? 'ALL CHECKS PASSED' : 'ISSUES FOUND',
    timestamp: new Date().toISOString(),
    checks,
  });
};
