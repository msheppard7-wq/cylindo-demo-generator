#!/usr/bin/env node
/**
 * Regenerate a demo with latest templates + push a new production deployment
 * to the existing Vercel project (same name Slack uses: cylindo-demo-<slug>).
 *
 * Usage:
 *   VERCEL_TOKEN=... [VERCEL_TEAM_ID=...] node scripts/redeploy-vercel-demo.js --preset maine-cottage
 *
 * Requires: same Content API access as generate.js (no extra deps).
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');
const { spawnSync } = require('child_process');

const VERCEL_API = 'https://api.vercel.com';

const PRESETS = {
  'maine-cottage': {
    brand: 'Maine Cottage',
    customer: '4404',
    products: 'HAVEN COMFORT ARM SOFA,NORFOLK WIDE ARM PLEATED SOFA',
    curator: 'a7ap4vak',
    url: 'https://www.mainecottage.com',
    /** Vercel project name (must match prior Slack deploy). */
    projectName: 'cylindo-demo-maine-cottage',
  },
};

function httpRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const opts = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function deployToVercel(projectName, files, token, teamId) {
  const teamParam = teamId ? `?teamId=${teamId}` : '';
  const payload = JSON.stringify({
    name: projectName,
    files: files.map((f) => ({
      file: f.path,
      data: Buffer.from(f.content, 'utf8').toString('base64'),
      encoding: 'base64',
    })),
    projectSettings: { framework: null },
    target: 'production',
  });
  return httpRequest(`${VERCEL_API}/v13/deployments${teamParam}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  }, payload);
}

async function disableDeploymentProtection(projectName, token, teamId) {
  const teamParam = teamId ? `?teamId=${teamId}` : '';
  return httpRequest(`${VERCEL_API}/v9/projects/${encodeURIComponent(projectName)}${teamParam}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  }, JSON.stringify({ ssoProtection: null }));
}

function parsePresetArg() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--preset');
  if (i < 0 || !argv[i + 1]) return null;
  return argv[i + 1];
}

async function main() {
  const presetKey = parsePresetArg();
  const preset = presetKey ? PRESETS[presetKey] : null;
  if (!preset) {
    console.error('Usage: node scripts/redeploy-vercel-demo.js --preset maine-cottage');
    console.error('Env: VERCEL_TOKEN (required), VERCEL_TEAM_ID (optional)');
    process.exit(1);
  }

  const token = process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID || '';
  if (!token) {
    console.error('Missing VERCEL_TOKEN. Add it to your shell or .env and retry.');
    process.exit(1);
  }

  const root = path.join(__dirname, '..');
  const slug = preset.brand.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const outDir = path.join(root, 'output', slug);
  const gen = path.join(root, 'generate.js');

  console.log('Generating demo into', outDir);
  const genRun = spawnSync(
    process.execPath,
    [
      gen,
      '--customer',
      preset.customer,
      '--products',
      preset.products,
      '--curator',
      preset.curator,
      '--brand',
      preset.brand,
      '--url',
      preset.url,
      '--output',
      outDir,
    ],
    { stdio: 'inherit', cwd: root }
  );
  if (genRun.status !== 0) {
    console.error('generate.js exited with code', genRun.status);
    process.exit(genRun.status || 1);
  }

  const files = ['index.html', 'styles.css', 'app.js', 'config.json'].map((name) => ({
    path: name,
    content: fs.readFileSync(path.join(outDir, name), 'utf8'),
  }));

  console.log('Deploying to Vercel project', preset.projectName, '...');
  const deployment = await deployToVercel(preset.projectName, files, token, teamId);

  if (deployment.status !== 200 && deployment.status !== 201) {
    const msg = deployment.data?.error?.message || JSON.stringify(deployment.data);
    console.error('Vercel deploy failed:', deployment.status, msg);
    process.exit(1);
  }

  await disableDeploymentProtection(preset.projectName, token, teamId);

  let demoUrl = `https://${preset.projectName}.vercel.app`;
  if (deployment.data?.url) demoUrl = `https://${deployment.data.url}`;
  console.log('Done. Production URL:', demoUrl);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
