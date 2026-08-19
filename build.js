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

// ── 4b. trust pages (About / Privacy / Terms / Contact) ─────────────────
// AdSense and most ad networks require these. They're also just honest:
// people deserve to know what a site does with their files.
const CONTACT = process.env.CONTACT_EMAIL || 'you@example.com';

function shellPage(slug, title, desc, bodyHtml) {
  const url = `${BASE}/${slug}/`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)} — ${SITE_NAME}</title>
<meta name="description" content="${esc(desc)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="canonical" href="${url}">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23FFB100'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,800&family=Geist:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{--paper:#F2F1EA;--surface:#fff;--ink:#12211E;--muted:#5E6D68;--line:#0000001a;--accent:#FFB100}
@media (prefers-color-scheme:dark){:root{--paper:#0F1817;--surface:#161616;--ink:#E9EDE9;--muted:#93A19C;--line:#ffffff1a}}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:Geist,system-ui,sans-serif;font-size:16px;line-height:1.7}
.w{max-width:720px;margin:0 auto;padding:38px 22px 70px}
.card{background:var(--surface);border-radius:16px;padding:34px;box-shadow:0 0 0 1px var(--line)}
h1{font-family:'Bricolage Grotesque',sans-serif;font-weight:800;font-size:clamp(27px,5vw,38px);letter-spacing:-.03em;margin:0 0 6px}
h2{font-family:'Bricolage Grotesque',sans-serif;font-weight:800;font-size:19px;letter-spacing:-.02em;margin:32px 0 8px}
p,li{color:var(--muted)}
a{color:var(--ink)}
ul{padding-left:20px}
.back{display:inline-block;margin-bottom:22px;color:var(--muted);text-decoration:none;font-size:14px}
.upd{font-size:13px;color:var(--muted);margin-top:32px;padding-top:16px;border-top:1px solid var(--line)}
</style>
</head>
<body>
<div class="w">
  <a class="back" href="${BASE}/">← ${SITE_NAME}</a>
  <div class="card">
    <h1>${esc(title)}</h1>
${bodyHtml}
    <p class="upd">Last updated ${new Date().toISOString().slice(0,10)}.</p>
  </div>
</div>
</body>
</html>`;
}

const byCat = {};
TOOLS.forEach(t => { (byCat[t.cat] = byCat[t.cat] || []).push(t); });

const PAGES = [
  ['about', 'About', `What ${SITE_NAME} is, who built it and why it is free.`, `
    <p>${SITE_NAME} is a free collection of ${TOOLS.length} everyday utilities — PDF tools, image tools, text tools, developer tools and calculators built for Indian users, including GST, EMI and SIP.</p>
    <h2>Why it exists</h2>
    <p>Most free tool sites take your file, upload it to a server you know nothing about, process it there, and ask you to trust that it was deleted afterwards. For a holiday photo that hardly matters. For a salary slip, a rent agreement or a bank statement, it matters a great deal.</p>
    <p>${SITE_NAME} was built the other way round. ${TOOLS.filter(t => !/^(docx|word|pptx|odf|xps|mobi|protect|unlock|url)-/.test(t.id)).length} of the ${TOOLS.length} tools run entirely inside your own browser using standard web APIs. Your file is opened by your own computer, processed by your own computer, and saved back to your own computer. It is never transmitted anywhere.</p>
    <h2>The tools that are different</h2>
    <p>A small number of jobs genuinely cannot be done in a browser — converting a Word document to PDF needs a full document layout engine, and password-protecting a PDF needs cryptography libraries that browsers do not expose. Those tools do send your file to a conversion server, and each one says so clearly before you use it. The file is deleted as soon as the conversion finishes.</p>
    <h2>What it costs</h2>
    <p>Nothing. There is no account, no upload limit that unlocks with payment, no watermark on anything you produce, and no trial that expires.</p>
    <h2>Categories</h2>
    <ul>${Object.keys(byCat).map(c => `<li><strong>${esc(c)}</strong> — ${byCat[c].length} tools, including ${esc(byCat[c].slice(0,3).map(t=>t.name).join(', '))}</li>`).join('\n    ')}</ul>
    <h2>Contact</h2>
    <p>Found a bug, or a tool that gets something wrong? Please tell me: <a href="mailto:${CONTACT}">${CONTACT}</a>.</p>`],

  ['privacy', 'Privacy policy', `How ${SITE_NAME} handles your files and data. Short version: almost nothing leaves your device.`, `
    <p>This policy explains exactly what happens to your data when you use ${SITE_NAME}. It is deliberately specific rather than vague.</p>
    <h2>Your files</h2>
    <p>For the large majority of tools here, files you open are processed entirely by JavaScript running inside your own browser. They are never uploaded, never transmitted, and never seen by any server. Closing the tab discards them.</p>
    <p>Nine tools are exceptions, because the work is impossible in a browser: DOCX to PDF, Word to PDF, PPTX to PDF, ODF to PDF, XPS to PDF, MOBI to PDF, Protect PDF, Unlock PDF and URL to PDF. These upload your file to a conversion server. Each of these tools displays a clear notice before you use it. On that server the file is written to a temporary folder, converted, returned to you, and the folder is deleted immediately. Nothing is retained, logged or backed up.</p>
    <h2>What is stored on your device</h2>
    <p>The site uses your browser's local storage — data that stays on your machine and is never sent anywhere — to remember:</p>
    <ul>
      <li>which tools you have starred</li>
      <li>which tools you used recently</li>
      <li>whether you prefer light or dark mode</li>
      <li>the conversion server address, if you set one</li>
    </ul>
    <p>Clearing your browser data removes all of it.</p>
    <h2>Analytics</h2>
    <p>This site runs no analytics scripts and sets no tracking cookies of its own.</p>
    <h2>Third parties</h2>
    <p>Some tools load open-source libraries from public CDNs (cdnjs and jsDelivr) at the moment you open them. Doing so reveals your IP address to those CDNs, as with any website that loads external resources. No file data is shared with them.</p>
    <p>Fonts are loaded from Google Fonts, which likewise receives your IP address.</p>
    <p>If advertising is enabled on this site in future, this section will be updated to name the ad network and describe the cookies it sets, before any ads appear.</p>
    <h2>Children</h2>
    <p>This site is a general-purpose utility and is not directed at children under 13. It collects no personal information from anyone.</p>
    <h2>Your rights</h2>
    <p>Because no personal data is collected or stored on any server, there is nothing to request, export or delete. Data held in your own browser is under your control at all times.</p>
    <h2>Questions</h2>
    <p>Email <a href="mailto:${CONTACT}">${CONTACT}</a>.</p>`],

  ['terms', 'Terms of use', `The terms under which ${SITE_NAME} is provided.`, `
    <p>By using ${SITE_NAME} you agree to the following. They are short and written in plain language.</p>
    <h2>The service is free and provided as-is</h2>
    <p>These tools are offered at no cost and with no warranty of any kind. They may contain errors. They may be unavailable at times. They may change or be withdrawn without notice.</p>
    <h2>Check important results</h2>
    <p>Several tools produce approximations, and say so where they do. Converting a PDF to Word, Excel or PowerPoint involves guessing at structure that a PDF does not actually store. Financial calculators are estimates and are not financial advice — confirm any figure that matters with your bank, lender or a qualified professional before relying on it.</p>
    <p>You are responsible for checking any output before you use it for anything consequential.</p>
    <h2>Keep your own backups</h2>
    <p>Always keep the original of any file you process. No copy is retained here, so nothing can be recovered if something goes wrong.</p>
    <h2>Acceptable use</h2>
    <p>Do not use these tools to break the law or to infringe anyone's rights. In particular, the Unlock PDF tool is for removing a password you already know from a document you are entitled to open. It does not defeat encryption on files you do not have access to, and must not be used to circumvent protection on material that is not yours.</p>
    <p>Do not attempt to overload, disrupt or abuse the conversion server.</p>
    <h2>Liability</h2>
    <p>To the fullest extent permitted by law, no liability is accepted for any loss or damage arising from use of this site, including lost or corrupted files, or decisions taken on the basis of a tool's output.</p>
    <h2>Questions</h2>
    <p>Email <a href="mailto:${CONTACT}">${CONTACT}</a>.</p>`],

  ['contact', 'Contact', `Get in touch about ${SITE_NAME} — bug reports, corrections and tool requests.`, `
    <p>${SITE_NAME} is maintained by one person. Email is the only channel, and I read everything.</p>
    <h2>Email</h2>
    <p><a href="mailto:${CONTACT}">${CONTACT}</a></p>
    <h2>Reporting a bug</h2>
    <p>The more specific you are, the faster it gets fixed. Useful details:</p>
    <ul>
      <li>which tool, and what you were trying to do</li>
      <li>what happened instead of what you expected</li>
      <li>your browser and device</li>
    </ul>
    <p>Please do not email the file itself. If a particular document breaks a tool, describe it — how many pages, whether it is a scan, roughly how large — and I can usually reproduce it.</p>
    <h2>Requesting a tool</h2>
    <p>Suggestions are welcome. Tools that can run in the browser are far easier to add than ones needing a server, so mention what you are trying to accomplish rather than only naming a format.</p>
    <h2>Corrections</h2>
    <p>If a calculator gives a figure you believe is wrong — particularly the GST, EMI or SIP tools — please tell me and show your working. Correctness matters more here than features.</p>`],
];

for (const [slug, title, desc, body] of PAGES) {
  fs.mkdirSync(slug, { recursive: true });
  fs.writeFileSync(path.join(slug, 'index.html'), shellPage(slug, title, desc, body));
}
console.log(`Wrote ${PAGES.length} trust pages (about, privacy, terms, contact)`);

// 404 — GitHub Pages serves this for any unknown path
fs.writeFileSync('404.html', shellPage('404', 'Page not found',
  'That page does not exist on ' + SITE_NAME + '.',
  `    <p>That address does not exist. It may have been mistyped, or a tool may have been renamed.</p>
    <p><a href="${BASE}/">Browse all ${TOOLS.length} tools →</a></p>`));
console.log('Wrote 404.html');

const today = new Date().toISOString().slice(0, 10);
const urls = [
  { loc: `${BASE}/`, pri: '1.0' },
  ...TOOLS.filter(t => t && t.id).map(t => ({ loc: `${BASE}/t/${t.id}/`, pri: '0.8' })),
  ...PAGES.map(([slug]) => ({ loc: `${BASE}/${slug}/`, pri: '0.3' })),
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
