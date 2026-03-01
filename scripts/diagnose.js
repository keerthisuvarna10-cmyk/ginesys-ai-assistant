/**
 * scripts/diagnose.js
 * Run this FIRST to see exactly what Confluence reports.
 * It will tell us exactly how many pages exist vs how many we're getting.
 *
 * Run: node scripts/diagnose.js
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
  console.error('❌ Missing ATLASSIAN_EMAIL or ATLASSIAN_API_TOKEN in .env');
  process.exit(1);
}

const AUTH = Buffer.from(`${ATLASSIAN_EMAIL}:${ATLASSIAN_API_TOKEN}`).toString('base64');
const HEADERS = { Authorization: `Basic ${AUTH}`, Accept: 'application/json' };

function apiGet(urlPath) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath.startsWith('http') ? urlPath : CONFLUENCE_BASE_URL + urlPath);
    https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: HEADERS, timeout: 30000 }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch(e) { reject(new Error(`Parse error: ${raw.slice(0,200)}`)); }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('Timeout')));
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  Ginesys KB Diagnostic Tool                         ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  // 1. Get all spaces
  console.log('Step 1: Getting all spaces...\n');
  const spaces = [];
  let start = 0;
  while (true) {
    const res = await apiGet(`/wiki/rest/api/space?limit=50&start=${start}&type=global`);
    for (const s of (res.results||[])) {
      if (!s.key.startsWith('~')) spaces.push({ key: s.key, name: s.name });
    }
    if (!res.results || res.results.length < 50) break;
    start += 50;
    await sleep(300);
  }
  console.log(`  Found ${spaces.length} spaces\n`);

  // 2. For each space, check count via 3 different methods
  console.log('Step 2: Checking page counts per space via different methods...\n');
  console.log('  Space'.padEnd(20) + 'ContentAPI'.padEnd(14) + 'CQL Search'.padEnd(14) + 'Space Pages'.padEnd(14));
  console.log('  ' + '─'.repeat(60));

  let grandTotalContent = 0;
  let grandTotalCQL = 0;

  const results = [];
  for (const space of spaces) {
    // Method 1: Standard content API (limit=1 just to get total)
    let contentTotal = '?';
    try {
      const r = await apiGet(`/wiki/rest/api/content?spaceKey=${space.key}&type=page&status=current&limit=1`);
      contentTotal = r.size !== undefined ? r.size : (r.results ? '≥'+r.results.length : '?');
      if (typeof contentTotal === 'number') grandTotalContent += contentTotal;
    } catch(e) { contentTotal = 'ERR'; }
    await sleep(100);

    // Method 2: CQL search (most reliable)
    let cqlTotal = '?';
    try {
      const cql = encodeURIComponent(`space="${space.key}" AND type=page AND status=current`);
      const r = await apiGet(`/wiki/rest/api/content/search?cql=${cql}&limit=1`);
      cqlTotal = r.totalSize !== undefined ? r.totalSize : (r.results ? '≥'+r.results.length : '?');
      if (typeof cqlTotal === 'number') grandTotalCQL += cqlTotal;
    } catch(e) { cqlTotal = 'ERR'; }
    await sleep(100);

    // Method 3: Space statistics
    let spaceTotal = '?';
    try {
      const r = await apiGet(`/wiki/rest/api/space/${space.key}?expand=metadata.labels`);
      spaceTotal = r.homepageId ? 'has-home' : '?';
    } catch(e) { spaceTotal = 'ERR'; }

    const row = { space: space.key, name: space.name, contentAPI: contentTotal, cql: cqlTotal };
    results.push(row);

    const cqlStr = String(cqlTotal);
    const contentStr = String(contentTotal);
    console.log(`  ${space.key.padEnd(20)}${contentStr.padEnd(14)}${cqlStr.padEnd(14)}${spaceTotal}`);
    await sleep(200);
  }

  console.log('  ' + '─'.repeat(60));
  console.log(`  ${'TOTAL'.padEnd(20)}${String(grandTotalContent).padEnd(14)}${String(grandTotalCQL).padEnd(14)}`);

  // 3. Check current index
  console.log('\nStep 3: Current kb-index.json status...\n');
  const indexFile = path.join(__dirname, '..', 'data', 'kb-index.json');
  if (fs.existsSync(indexFile)) {
    const stat = fs.statSync(indexFile);
    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    console.log(`  File size:    ${(stat.size/1024/1024).toFixed(1)} MB`);
    console.log(`  Total pages:  ${index.totalPages || index.pages?.length || '?'}`);
    console.log(`  Crawled at:   ${index.crawledAt}`);
    console.log(`  Spaces in index: ${(index.spaces||[]).join(', ')}`);

    // Pages per space in current index
    console.log('\n  Pages per space in current index:');
    const spaceCounts = {};
    for (const p of (index.pages||[])) {
      spaceCounts[p.spaceKey] = (spaceCounts[p.spaceKey]||0) + 1;
    }
    for (const [key, count] of Object.entries(spaceCounts)) {
      const expected = results.find(r=>r.space===key);
      const exp = expected ? String(expected.cql) : '?';
      const gap = typeof expected?.cql === 'number' ? ` ← missing ${expected.cql - count}` : '';
      console.log(`    [${key.padEnd(14)}] indexed: ${String(count).padEnd(6)} / expected: ${exp}${gap}`);
    }
  } else {
    console.log('  No kb-index.json found yet — run crawl first');
  }

  // 4. Test a known missing topic
  console.log('\nStep 4: Quick CQL test for "Settlement at POS"...\n');
  try {
    const cql = encodeURIComponent(`type=page AND status=current AND text~"settlement" AND text~"POS"`);
    const r   = await apiGet(`/wiki/rest/api/content/search?cql=${cql}&limit=5&expand=space`);
    console.log(`  Pages matching "settlement AND POS": ${r.totalSize || (r.results||[]).length}`);
    for (const p of (r.results||[]).slice(0,5)) {
      console.log(`    - [${p.space?.key}] ${p.title}`);
    }
  } catch(e) { console.log(`  Error: ${e.message}`); }

  console.log('\n✅ Diagnosis complete. Share this output to identify the gap.\n');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
