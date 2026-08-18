#!/usr/bin/env node
/**
 * Toolshed static page generator
 * ==============================
 * Reads the TOOLS registry straight out of index.html and writes one real,
 * indexable HTML page per tool — plus sitemap.xml and robots.txt.
 *
 * Why this exists: the app is a single page with hash routes, so Google only
 * ever sees one URL. After this runs there are ~45 URLs, each with its own
 * title, description and canonical tag.
 *
 * No dependencies. Node 18+. Run:  node build.js
 */
const fs = require('fs');
const path = require('path');

// ── config ───────────────────────────────────────────────────────────────
const BASE = (process.env.SITE_URL || 'https://koljacks.github.io/Toolshed')
  .replace(/\/+$/, '');
const SRC = process.env.SRC || 'index.html';
const OUT = process.env.OUT || 't';           // pages land in /t/<id>/
const SITE_NAME = 'Toolshed';

// ── 1. read the app ──────────────────────────────────────────────────────
const html = fs.readFileSync(SRC, 'utf8');

const scripts = [...html.matchAll(/<script>\n([\s\S]*?)\n<\/script>/g)].map(m => m[1]);
if (!scripts.length) { console.error('No inline <script> found in ' + SRC); process.exit(1); }
const appScript = scripts[scripts.length - 1];

// Everything before the ENGINE banner is helpers + the registry. That section
// only *declares* functions, so it can be evaluated with tiny stubs — far more
// reliable than regex-scraping the tool objects.
const ENGINE = '/* ==================================================================\n   ENGINE';
const cut = appScript.indexOf(ENGINE);
if (cut < 0) { console.error('ENGINE marker not found — did the file structure change?'); process.exit(1); }
// Skip past the IIFE wrapper, or the slice leaves an unclosed function.
const strict = appScript.indexOf('"use strict";');
const start = strict >= 0 ? strict + '"use strict";'.length : 0;
const registryCode = appScript.slice(start, cut);

// ── 2. evaluate it in a sandbox to get the real TOOLS array ──────────────
function extractTools(code) {
  const noop = () => {};
  const el = new Proxy({}, {
    get: (t, k) => (k === 'style' || k === 'dataset' || k === 'classList')
      ? new Proxy({}, { get: () => noop }) : (k === 'value' || k === 'textContent') ? '' : noop,
    set: () => true,
  });
  const documentStub = {
    querySelector: () => el, querySelectorAll: () => [], createElement: () => el,
    addEventListener: noop, head: el, body: el, documentElement: { classList: { add: noop, toggle: noop, contains: () => false } },
  };
  const sandbox = {
    document: documentStub,
    window: { matchMedia: () => ({ matches: false }), addEventListener: noop, location: { hash: '' } },
    localStorage: { getItem: () => null, setItem: noop },
    navigator: { clipboard: null },
    crypto: { getRandomValues: a => a, randomUUID: () => '' },
    fetch: () => Promise.reject(new Error('no network at build time')),
    URL: { createObjectURL: () => '', revokeObjectURL: noop },
    console: { log: noop, error: noop, warn: noop },
    setTimeout: noop, clearTimeout: noop, atob: s => s, btoa: s => s,
    Image: function () {}, FileReader: function () {}, FormData: function () {},
    TextEncoder: function () {}, TextDecoder: function () {},
  };
  const names = Object.keys(sandbox);
  const body = `"use strict";\n${code}\n;return (typeof TOOLS !== 'undefined') ? TOOLS : [];`;
  // eslint-disable-next-line no-new-func
  return new Function(...names, body)(...names.map(n => sandbox[n]));
}

let TOOLS;
try {
  TOOLS = extractTools(registryCode);
} catch (err) {
  console.error('Could not read the registry:', err.message);
  process.exit(1);
}
if (!Array.isArray(TOOLS) || !TOOLS.length) { console.error('Registry came back empty.'); process.exit(1); }
console.log(`Found ${TOOLS.length} tools in ${SRC}`);

// ── 3. helpers ───────────────────────────────────────────────────────────
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const HUE = { PDF:'#FF3B30', Image:'#007AFF', Text:'#AF52DE', Developer:'#5856D6', Money:'#28A745' };

/** Landing copy that a search engine can read without running any JavaScript. */
function seoBlock(tool, siblings) {
  const related = siblings.filter(t => t.id !== tool.id).slice(0, 6);
  return `
<section id="about-tool" style="max-width:820px;margin:0 auto;padding:8px 22px 56px">
  <h2 style="font-family:'Bricolage Grotesque',sans-serif;font-size:19px;margin:28px 0 8px">About ${esc(tool.name)}</h2>
  <p style="color:var(--muted);font-size:14.5px">${esc(tool.blurb)} It runs entirely inside your browser — your files are never uploaded to a server, there is no signup, and there is no watermark on anything you produce.</p>
  <h2 style="font-family:'Bricolage Grotesque',sans-serif;font-size:19px;margin:28px 0 8px">How it works</h2>
  <ol style="color:var(--muted);font-size:14.5px;padding-left:20px;line-height:1.9">
    <li>Open ${esc(tool.name)} above.</li>
    <li>Add your file or enter your details — nothing leaves your device.</li>
    <li>Adjust the options, then download the result.</li>
  </ol>
  ${related.length ? `<h2 style="font-family:'Bricolage Grotesque',sans-serif;font-size:19px;margin:28px 0 8px">More ${esc(tool.cat)} tools</h2>
  <ul style="columns:2;font-size:14.5px;padding-left:20px;line-height:1.9">
    ${related.map(r => `<li><a href="${BASE}/t/${r.id}/" style="color:var(--muted)">${esc(r.name)}</a></li>`).join('\n    ')}
  </ul>` : ''}
  <p style="font-size:14.5px;margin-top:24px"><a href="${BASE}/" style="color:var(--muted)">← All ${TOOLS.length} free tools</a></p>
</section>`;
}

function schema(tool) {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: tool.name,
    description: tool.blurb,
    url: `${BASE}/t/${tool.id}/`,
    applicationCategory: 'UtilitiesApplication',
    operatingSystem: 'Any (runs in a web browser)',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'INR' },
    isAccessibleForFree: true,
    browserRequirements: 'Requires JavaScript',
    publisher: { '@type': 'Organization', name: SITE_NAME, url: BASE + '/' },
  }, null, 2);
}

/** Rewrite the app's <head> for this specific tool and preselect its route. */
function pageFor(tool, siblings) {
  const title = `${tool.name} — free, no signup | ${SITE_NAME}`;
  const desc = `${tool.blurb} Free, runs in your browser, nothing is uploaded.`;
  const url = `${BASE}/t/${tool.id}/`;
  let out = html;

  out = out.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`);
  out = out.replace(/<meta name="description"[^>]*>/,
    `<meta name="description" content="${esc(desc)}">`);

  // social cards + canonical + structured data, injected before </head>
  const head = `
<link rel="canonical" href="${url}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(tool.name)} — ${SITE_NAME}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${url}">
<meta property="og:site_name" content="${SITE_NAME}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(tool.name)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="keywords" content="${esc([tool.name, tool.cat, ...(tool.tags || '').split(/\s+/)].filter(Boolean).slice(0, 14).join(', '))}">
<script type="application/ld+json">${schema(tool)}</script>
<script>
/* Land straight on this tool. Runs before the app boots, so the router
   picks the hash up on its first pass — no flash of the index. */
if (!location.hash) history.replaceState(null, '', '#/${tool.id}');
</script>
</head>`;
  out = out.replace('</head>', head);

  // NOTE: deliberately no path rewriting. The app is one self-contained file
  // with only absolute CDN URLs, and a naive href/src rewrite corrupts
  // src="${...}" inside the JS template literals. Verified: nothing to rewrite.

  // static, crawlable copy after the app shell
  out = out.replace('</div>\n<div class="scrim" id="scrim"></div>',
    `</div>\n${seoBlock(tool, siblings)}\n<div class="scrim" id="scrim"></div>`);

  return out;
}

// ── 4. write everything ──────────────────────────────────────────────────
fs.rmSync(OUT, { recursive: true, force: true });
let written = 0;
for (const tool of TOOLS) {
  if (!tool || !tool.id) continue;
  const siblings = TOOLS.filter(t => t.cat === tool.cat);
  const dir = path.join(OUT, tool.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), pageFor(tool, siblings));
  written++;
}

const today = new Date().toISOString().slice(0, 10);
const urls = [
  { loc: `${BASE}/`, pri: '1.0' },
  ...TOOLS.filter(t => t && t.id).map(t => ({ loc: `${BASE}/t/${t.id}/`, pri: '0.8' })),
];
fs.writeFileSync('sitemap.xml',
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>${u.pri}</priority>
  </url>`).join('\n')}
</urlset>
`);

fs.writeFileSync('robots.txt',
  `User-agent: *
Allow: /

Sitemap: ${BASE}/sitemap.xml
`);

console.log(`Wrote ${written} tool pages into /${OUT}/`);
console.log(`Wrote sitemap.xml (${urls.length} URLs) and robots.txt`);
console.log(`Base URL: ${BASE}`);
