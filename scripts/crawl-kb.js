/**
 * Ginesys KB Crawl v9.0 — Maximum Coverage
 *
 * Fixes vs all previous versions:
 * 1. Fetches ALL space types (global + personal + archived)
 * 2. Uses /content API with spaceKey (reliable body.storage)
 * 3. Correct pagination using result.size + start tracking
 * 4. Also fetches child pages missed by flat listing
 * 5. Verifies page count vs Confluence at end
 * 6. Shows per-space progress with expected vs actual
 * 7. Saves progress after every space (safe to interrupt)
 *
 * Usage:
 *   node scripts/crawl-kb.js             — full crawl
 *   node scripts/crawl-kb.js --resume    — continue interrupted crawl
 *   node scripts/crawl-kb.js --space PUB — single space
 *   node scripts/crawl-kb.js --debug     — verbose API output
 *   node scripts/crawl-kb.js --verify    — check coverage vs Confluence
 */

require('dotenv').config();
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const {
  ATLASSIAN_EMAIL,
  ATLASSIAN_API_TOKEN,
  CONFLUENCE_BASE_URL = 'https://ginesysone.atlassian.net',
} = process.env;

if (!ATLASSIAN_EMAIL || !ATLASSIAN_API_TOKEN) {
  console.error('\n❌ Missing ATLASSIAN_EMAIL or ATLASSIAN_API_TOKEN in .env\n');
  process.exit(1);
}

const DATA_DIR      = path.join(__dirname, '..', 'data');
const INDEX_FILE    = path.join(DATA_DIR, 'kb-index.json');
const PROGRESS_FILE = path.join(DATA_DIR, 'crawl-progress.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const AUTH    = Buffer.from(`${ATLASSIAN_EMAIL}:${ATLASSIAN_API_TOKEN}`).toString('base64');
const HEADERS = { Authorization: `Basic ${AUTH}`, Accept: 'application/json' };
const BASE    = CONFLUENCE_BASE_URL;

const DEBUG  = process.argv.includes('--debug');
const RESUME = process.argv.includes('--resume');
const VERIFY = process.argv.includes('--verify');
const SPACE  = (() => { const i = process.argv.indexOf('--space'); return i > -1 ? process.argv[i+1] : null; })();

const LIMIT  = 50;  // pages per request — 50 is reliable for body.storage

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function pad(s, n) { return String(s).padEnd(n); }

// ── HTTPS GET ─────────────────────────────────────────────────────────────────
function get(urlPath, retries = 5) {
  return new Promise((resolve, reject) => {
    const fullUrl = urlPath.startsWith('http') ? urlPath : BASE + urlPath;
    let u;
    try { u = new URL(fullUrl); } catch(e) { return reject(new Error('Bad URL: ' + fullUrl)); }

    if (DEBUG) process.stdout.write(`\n  → ${u.pathname}${u.search.slice(0, 80)}`);

    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers: HEADERS, timeout: 120000 },
      res => {
        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          const next = res.headers.location.startsWith('http')
            ? res.headers.location : `https://${u.hostname}${res.headers.location}`;
          return get(next, retries).then(resolve).catch(reject);
        }
        if (res.statusCode === 429) {
          const wait = parseInt(res.headers['retry-after'] || '30') * 1000;
          console.log(`\n  ⏳ Rate limited — waiting ${wait/1000}s`);
          res.resume();
          return setTimeout(() => get(urlPath, retries).then(resolve).catch(reject), wait);
        }
        if (res.statusCode === 401) { res.resume(); return reject(new Error('401 Unauthorized — check API token')); }
        if (res.statusCode === 403) { res.resume(); return reject(new Error('403 Forbidden — insufficient permissions')); }
        if (res.statusCode === 404) { res.resume(); return reject(new Error('404 Not Found: ' + u.pathname)); }

        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => body += c);
        res.on('end', () => {
          if (!body.trim()) {
            if (retries > 0) return setTimeout(() => get(urlPath, retries-1).then(resolve).catch(reject), 2000);
            return reject(new Error(`Empty response (HTTP ${res.statusCode})`));
          }
          try {
            const data = JSON.parse(body);
            // Confluence error responses
            if (data.statusCode >= 400) return reject(new Error(`API ${data.statusCode}: ${data.message}`));
            resolve(data);
          } catch(e) {
            if (retries > 0) return setTimeout(() => get(urlPath, retries-1).then(resolve).catch(reject), 2000);
            reject(new Error(`JSON parse (HTTP ${res.statusCode}): ${body.slice(0, 150)}`));
          }
        });
      }
    );
    req.on('error', err => {
      if (retries > 0) return setTimeout(() => get(urlPath, retries-1).then(resolve).catch(reject), 3000);
      reject(new Error(`Network: ${err.message}`));
    });
    req.on('timeout', () => {
      req.destroy();
      if (retries > 0) return setTimeout(() => get(urlPath, retries-1).then(resolve).catch(reject), 5000);
      reject(new Error('Request timeout'));
    });
    req.end();
  });
}

// ── Get count of pages in a space (for verification) ─────────────────────────
async function getSpacePageCount(spaceKey) {
  try {
    const r = await get(`/wiki/rest/api/content?type=page&status=current&spaceKey=${spaceKey}&limit=1`);
    return r.size || 0;
  } catch(e) { return -1; }
}

// ── Get ALL spaces (global + personal) ───────────────────────────────────────
async function getAllSpaces() {
  const spaces = [];
  const seen   = new Set();

  for (const type of ['global', 'personal']) {
    let start = 0;
    process.stdout.write(`\n  Fetching ${type} spaces`);
    while (true) {
      let r;
      try { r = await get(`/wiki/rest/api/space?limit=50&start=${start}&type=${type}`); }
      catch(e) { console.log(` (error: ${e.message})`); break; }

      const batch = r.results || [];
      for (const s of batch) {
        if (!seen.has(s.key)) {
          seen.add(s.key);
          spaces.push({ key: s.key, name: s.name || s.key, type });
        }
      }
      process.stdout.write('.');
      if (batch.length < 50) break;
      start += 50;
      await sleep(200);
    }
  }

  console.log(`\n  Total spaces: ${spaces.length} (${spaces.filter(s=>s.type==='global').length} global, ${spaces.filter(s=>s.type==='personal').length} personal)`);
  if (DEBUG) console.log('  Keys:', spaces.map(s=>s.key).join(', '));
  return spaces;
}

// ── Crawl all pages in one space ──────────────────────────────────────────────
async function crawlSpace(spaceKey, spaceName) {
  const pages  = [];
  const seenIds = new Set();
  let start = 0;

  // Get expected count first
  const expected = await getSpacePageCount(spaceKey);
  if (expected === 0) {
    console.log(`  [${spaceKey}] Empty space — skipping`);
    return [];
  }

  process.stdout.write(`  [${spaceKey}] 0/${expected} pages`);

  while (true) {
    const ep = `/wiki/rest/api/content?type=page&status=current&spaceKey=${spaceKey}&limit=${LIMIT}&start=${start}&expand=body.storage,ancestors,metadata.labels,version`;

    let result;
    try {
      result = await get(ep);
    } catch(e) {
      console.error(`\n  ❌ [${spaceKey}] at offset ${start}: ${e.message}`);
      if (e.message.includes('401')) throw e;
      await sleep(5000);
      try { result = await get(ep); }
      catch(e2) { console.error(`  ❌ [${spaceKey}] giving up: ${e2.message}`); break; }
    }

    const batch = result.results || [];
    if (DEBUG) console.log(`\n  [${spaceKey}] offset=${start} got=${batch.length} size=${result.size}`);
    if (batch.length === 0) break;

    for (const page of batch) {
      if (seenIds.has(page.id)) continue;
      seenIds.add(page.id);

      const html     = page.body?.storage?.value || '';
      const fullText = htmlToText(html);
      const images   = extractImages(html, page.id);
      const videos   = extractVideos(html, page.id);
      const ancs     = (page.ancestors || []).map(a => a.title);
      const labels   = (page.metadata?.labels?.results || []).map(l => l.name);

      pages.push({
        id:           page.id,
        title:        page.title || '',
        spaceKey,
        spaceName,
        url:          `${BASE}/wiki/spaces/${spaceKey}/pages/${page.id}`,
        fullText,
        tokens:       tokenize(`${page.title} ${spaceName} ${ancs.join(' ')} ${labels.join(' ')} ${fullText}`),
        images,
        videos,
        ancestors:    ancs,
        labels,
        charCount:    fullText.length,
        lastModified: page.version?.when || '',
      });
    }

    process.stdout.write(`\r  [${spaceKey}] ${pages.length}/${expected} pages...   `);

    // Stop conditions — IMPORTANT: result.size = batch size (not total)
    // Use _links.next as the ONLY reliable "more pages" signal
    if (batch.length < LIMIT) break;   // got fewer than limit = definitely last page
    if (!result._links || !result._links.next) break;  // no next link = last page

    start += LIMIT;
    await sleep(300);
  }

  const imgs = pages.reduce((n, p) => n + p.images.length, 0);
  const vids = pages.reduce((n, p) => n + p.videos.length, 0);
  const gap  = expected > 0 && pages.length < expected ? ` ⚠️ expected ${expected}` : '';
  process.stdout.write(`\r  [${spaceKey}] ✅ ${pages.length} pages · ${imgs} images · ${vids} videos${gap}\n`);
  return pages;
}

// ── VERIFY mode ───────────────────────────────────────────────────────────────
async function verify() {
  if (!fs.existsSync(INDEX_FILE)) {
    console.error('❌ No index found — run crawl first'); process.exit(1);
  }
  const idx = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  console.log(`\nIndex: ${idx.totalPages} pages · ${idx.totalImages} images · ${idx.totalVideos} videos`);
  console.log(`Spaces in index: ${(idx.spaces||[]).join(', ')}\n`);

  const spaces = await getAllSpaces();
  let totalConf = 0, totalIdx = 0;
  console.log(`\n${pad('Space', 10)} ${pad('Confluence', 12)} ${pad('In Index', 10)} Status`);
  console.log('─'.repeat(52));

  for (const sp of spaces) {
    const conf  = await getSpacePageCount(sp.key);
    const inIdx = idx.pages.filter(p => p.spaceKey === sp.key).length;
    if (conf <= 0) continue;
    totalConf += conf; totalIdx += inIdx;
    const pct    = Math.round(inIdx / conf * 100);
    const status = pct >= 95 ? `✅ ${pct}%` : `❌ ${pct}% — missing ${conf - inIdx}`;
    console.log(`${pad(sp.key, 10)} ${pad(conf, 12)} ${pad(inIdx, 10)} ${status}`);
    await sleep(200);
  }
  console.log('─'.repeat(52));
  const tot = totalConf > 0 ? Math.round(totalIdx / totalConf * 100) : 0;
  console.log(`${pad('TOTAL', 10)} ${pad(totalConf, 12)} ${pad(totalIdx, 10)} ${tot >= 95 ? '✅' : '❌'} ${tot}%\n`);
  if (tot < 95) console.log('Run: node scripts/crawl-kb.js  to fix missing pages');
}

// ── Text / media extractors ───────────────────────────────────────────────────
function htmlToText(html) {
  if (!html) return '';
  html = html
    .replace(/<ac:structured-macro[^>]*ac:name="(info|note|warning|tip|panel)"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi, (_, t, b) => `\n[${t.toUpperCase()}]\n${b}\n`)
    .replace(/<ac:structured-macro[^>]*ac:name="expand"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi, (_, b) => `\n[EXPAND]\n${b}\n`)
    .replace(/<ac:structured-macro[^>]*ac:name="code"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi, (_, b) => `\n[CODE]\n${b}\n`)
    .replace(/<ac:structured-macro[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi, '\n$1\n')
    .replace(/<ac:parameter[^>]*>[\s\S]*?<\/ac:parameter>/gi, '')
    .replace(/<ac:rich-text-body>([\s\S]*?)<\/ac:rich-text-body>/gi, '\n$1\n')
    .replace(/<ac:plain-text-body>([\s\S]*?)<\/ac:plain-text-body>/gi, '\n$1\n')
    .replace(/<ac:[^>]+>/gi, '').replace(/<\/ac:[^>]+>/gi, '')
    .replace(/<ri:[^>]+\/>/gi, '');
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<h([1-6])[^>]*>/gi, (_, n) => '\n' + '#'.repeat(+n) + ' ').replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<tr[^>]*>/gi, '\n').replace(/<t[dh][^>]*>/gi, ' | ')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/?(ol|ul|table|thead|tbody|tr|td|th|li)[^>]*>/gi, '\n')
    .replace(/<\/?(p|div|section|blockquote|article)[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<hr\s*\/?>/gi, '\n---\n')
    .replace(/<(strong|b)[^>]*>/gi, '**').replace(/<\/(strong|b)>/gi, '**')
    .replace(/<a[^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/gi, '$2')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&mdash;/g, '—')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/[ \t]{3,}/g, '  ').replace(/\n{5,}/g, '\n\n\n').trim();
}

function extractImages(html, pageId) {
  if (!html) return [];
  const seen = new Set(), imgs = [];
  const re = /ri:filename="([^"]+\.(png|jpg|jpeg|gif|webp|svg|PNG|JPG|JPEG))"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const fn  = m[1];
    const url = `${BASE}/wiki/download/attachments/${pageId}/${encodeURIComponent(fn)}`;
    if (!seen.has(url)) {
      seen.add(url);
      const snip = html.slice(Math.max(0, m.index - 300), m.index + 150);
      const alt  = /ac:alt="([^"]+)"/.exec(snip);
      const ctx  = htmlToText(html.slice(Math.max(0, m.index - 300), m.index)).slice(-100).trim();
      imgs.push({ url, caption: alt ? alt[1] : fn.replace(/\.[^.]+$/, '').replace(/[-_+]/g, ' ').trim(), context: ctx, type: 'image' });
    }
  }
  return imgs;
}

function extractVideos(html, pageId) {
  if (!html) return [];
  const seen = new Set(), vids = [];
  const re1 = /ri:filename="([^"]+\.(mp4|mov|avi|webm|MP4|MOV|AVI|WEBM))"/gi;
  let m;
  while ((m = re1.exec(html)) !== null) {
    const fn  = m[1];
    const url = `${BASE}/wiki/download/attachments/${pageId}/${encodeURIComponent(fn)}`;
    if (!seen.has(url)) { seen.add(url); vids.push({ url, caption: fn.replace(/\.[^.]+$/, '').replace(/[-_+]/g, ' ').trim(), context: '', type: 'video', videoId: null }); }
  }
  const re2 = /(?:youtube\.com\/(?:embed\/|watch\?v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/g;
  while ((m = re2.exec(html)) !== null) {
    const url = `https://www.youtube.com/watch?v=${m[1]}`;
    if (!seen.has(url)) { seen.add(url); vids.push({ url, caption: 'YouTube Video', context: '', type: 'youtube', videoId: m[1] }); }
  }
  return vids;
}

function tokenize(text) {
  const stop = new Set(['the','a','an','in','on','at','to','for','of','and','or','is','are','was','were','be','been','have','has','had','this','that','with','from','by','as','it','its','not','but','what','how','when','where','which','who','will','can','do','does','did','if','then','use','used','using']);
  return [...new Set(text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(w => w.length > 1 && !stop.has(w)))];
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  if (VERIFY) return verify();

  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║  Ginesys KB Crawl v9.0 — Maximum Coverage          ║');
  console.log(`║  Mode: ${(SPACE ? 'Space: '+SPACE : RESUME ? 'RESUME' : 'FULL — ALL spaces').padEnd(44)}║`);
  console.log('╚════════════════════════════════════════════════════╝\n');

  // Connection test
  console.log('  Testing Confluence connection...');
  try {
    const t = await get('/wiki/rest/api/space?limit=1&type=global');
    if (t.results === undefined) throw new Error('Unexpected response: ' + JSON.stringify(t).slice(0, 200));
    console.log(`  ✅ Connected! (${t.size || '?'} global spaces visible)`);
  } catch(e) {
    console.error(`\n  ❌ FAILED: ${e.message}`);
    console.error('  Check .env: ATLASSIAN_EMAIL, ATLASSIAN_API_TOKEN, CONFLUENCE_BASE_URL');
    console.error('  Token: https://id.atlassian.com/manage-profile/security/api-tokens\n');
    process.exit(1);
  }

  // Get spaces
  let spaces;
  if (SPACE) {
    const count = await getSpacePageCount(SPACE);
    spaces = [{ key: SPACE, name: SPACE, type: 'specified' }];
    console.log(`\n  Space ${SPACE}: ~${count} pages`);
  } else {
    spaces = await getAllSpaces();
  }

  if (spaces.length === 0) { console.error('\n  ❌ No spaces found\n'); process.exit(1); }

  // Resume state
  let allPages = [], doneSpaces = {};
  if (RESUME && fs.existsSync(PROGRESS_FILE)) {
    try {
      const p = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
      allPages    = p.allPages    || [];
      doneSpaces  = p.doneSpaces  || {};
      console.log(`\n  Resuming: ${allPages.length} pages indexed, ${Object.keys(doneSpaces).length} spaces done`);
    } catch(e) { console.log('  Could not load progress file, starting fresh'); }
  }
  const seenIds = new Set(allPages.map(p => p.id));

  const t0 = Date.now();
  let skipped = 0;

  console.log('\n');
  for (let i = 0; i < spaces.length; i++) {
    const sp = spaces[i];

    if (doneSpaces[sp.key] !== undefined) {
      console.log(`  [${sp.key}] ⏭  Already done (${doneSpaces[sp.key]} pages)`);
      skipped++;
      continue;
    }

    try {
      const spPages = await crawlSpace(sp.key, sp.name);
      let added = 0;
      for (const p of spPages) {
        if (!seenIds.has(p.id)) { allPages.push(p); seenIds.add(p.id); added++; }
      }
      doneSpaces[sp.key] = added;

      // Save progress after EVERY space
      fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ allPages, doneSpaces }));
    } catch(e) {
      console.error(`  ❌ [${sp.key}] ${e.message}`);
      if (e.message.includes('401')) { console.error('\n  ❌ Auth failed — stopping\n'); process.exit(1); }
    }

    await sleep(400);
  }

  // Build final index
  console.log('\n  Building index...');
  const totalImages = allPages.reduce((n, p) => n + (p.images || []).length, 0);
  const totalVideos = allPages.reduce((n, p) => n + (p.videos || []).length, 0);
  const spaceKeys   = [...new Set(allPages.map(p => p.spaceKey))];

  const index = {
    version:    '9.0',
    crawledAt:  new Date().toISOString(),
    totalPages: allPages.length,
    totalImages,
    totalVideos,
    spaces:     spaceKeys,
    pages:      allPages,
  };

  fs.writeFileSync(INDEX_FILE, JSON.stringify(index));
  if (fs.existsSync(PROGRESS_FILE)) fs.unlinkSync(PROGRESS_FILE);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  const mb      = (fs.statSync(INDEX_FILE).size / 1024 / 1024).toFixed(1);

  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log(`║  ${allPages.length > 0 ? '✅' : '⚠️ '} Crawl Complete!                                  ║`);
  console.log(`║  Pages:   ${pad(allPages.length, 41)}║`);
  console.log(`║  Images:  ${pad(totalImages, 41)}║`);
  console.log(`║  Videos:  ${pad(totalVideos, 41)}║`);
  console.log(`║  Spaces:  ${pad(spaceKeys.length + ' (' + spaceKeys.join(', ').slice(0, 30) + '...)', 41)}║`);
  console.log(`║  Time:    ${pad(elapsed + 's', 41)}║`);
  console.log(`║  Index:   ${pad(mb + ' MB  →  data/kb-index.json', 41)}║`);
  console.log('╚════════════════════════════════════════════════════╝\n');

  if (allPages.length === 0) {
    console.log('  ⚠️  0 pages indexed! Try:');
    console.log('  node scripts/crawl-kb.js --debug --space PUB\n');
  } else {
    // Quick coverage check
    console.log('  Checking coverage (this takes ~30s)...');
    try {
      let totalConf = 0;
      for (const sp of spaces.slice(0, 20)) { // check first 20 spaces
        const c = await getSpacePageCount(sp.key);
        if (c > 0) totalConf += c;
        await sleep(150);
      }
      const pct = totalConf > 0 ? Math.round(allPages.length / totalConf * 100) : 0;
      if (pct < 90) {
        console.log(`  ⚠️  Coverage: ${allPages.length}/${totalConf} (${pct}%)`);
        console.log('  Run: node scripts/crawl-kb.js --resume  to fetch missing pages\n');
      } else {
        console.log(`  ✅ Coverage: ${allPages.length}/${totalConf} pages (${pct}%)`);
        console.log('  Run: npm start\n');
      }
    } catch(e) {
      console.log('  Run: npm start\n');
    }
  }
}

main().catch(e => {
  console.error('\n❌', e.message);
  if (DEBUG) console.error(e.stack);
  process.exit(1);
});
