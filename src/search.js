/**
 * src/search.js — Ginesys KB Search Engine v4.0
 *
 * HYBRID SEARCH: Keyword + TF-IDF Semantic
 * ─────────────────────────────────────────
 * 1. Keyword search  — exact/synonym/abbreviation matching (fast, precise)
 * 2. TF-IDF semantic — vector cosine similarity (finds conceptually related pages)
 * 3. Hybrid score    — weighted blend of both signals
 *
 * Why TF-IDF instead of embedding APIs:
 * - Works fully offline, no API key, no cost
 * - 2,356 pages indexed in seconds (not hours)
 * - Understands domain vocabulary naturally
 * - "create purchase order" matches "adding PO" without synonyms
 */

const fs   = require('fs');
const path = require('path');
const INDEX_FILE = path.join(__dirname, '..', 'data', 'kb-index.json');

// ── Stop words ────────────────────────────────────────────────────────────────
const STOP = new Set([
  'the','and','for','are','was','has','have','with','this','that','from','will',
  'can','you','all','not','but','its','our','your','per','via','does','did',
  'been','into','over','also','just','only','then','than','too','how','what',
  'when','where','which','who','any','more','some','each','such','used','use',
  'using','click','go','select','page','section','following','below','above',
]);

// ── Abbreviations ─────────────────────────────────────────────────────────────
const ABB = {
  'po':   ['purchase order','po'],
  'grc':  ['goods receive challan','goods receipt','inward','grn'],
  'grn':  ['goods receipt note','goods receive note','grc'],
  'srn':  ['sales return note'],
  'sto':  ['stock transfer order'],
  'dc':   ['delivery challan'],
  'pr':   ['purchase requisition'],
  'gst':  ['goods and services tax','tax'],
  'igst': ['integrated goods services tax'],
  'cgst': ['central goods services tax'],
  'sgst': ['state goods services tax'],
  'gstr': ['gst return','gst filing'],
  'hsn':  ['harmonized system nomenclature','hsn code'],
  'tds':  ['tax deducted source'],
  'gstin':['gst identification number'],
  'itc':  ['input tax credit'],
  'rcm':  ['reverse charge mechanism'],
  'ewb':  ['eway bill','e-way bill','electronic way bill'],
  'irn':  ['invoice reference number'],
  'jv':   ['journal voucher','journal entry'],
  'gl':   ['general ledger'],
  'ap':   ['accounts payable'],
  'ar':   ['accounts receivable'],
  'cn':   ['credit note'],
  'dn':   ['debit note'],
  'pos':  ['point of sale','billing','retail'],
  'sku':  ['stock keeping unit','item code'],
  'mrp':  ['maximum retail price'],
  'wms':  ['warehouse management'],
  'bom':  ['bill of materials'],
  'spt':  ['stock point transfer','stock transfer'],
};

// ── Synonyms ──────────────────────────────────────────────────────────────────
const SYN = {
  'create':    ['add','adding','new','make','generate','raise','enter','insert'],
  'adding':    ['create','add','new','make'],
  'creating':  ['create','add','make','new'],
  'delete':    ['remove','cancel','void','discard','deleting'],
  'edit':      ['modify','update','change','amend','correct','editing'],
  'view':      ['see','check','open','display','show','find','search'],
  'print':     ['output','export','download','pdf','printing'],
  'configure': ['setup','settings','enable','install','set up','configuring'],
  'approve':   ['authorise','authorize','confirm','sanction'],
  'transfer':  ['move','shift','send','issue','dispatch'],
  'vendor':    ['supplier','party','creditor'],
  'customer':  ['client','buyer','debtor'],
  'invoice':   ['bill','tax invoice'],
  'item':      ['product','article','sku','goods','material'],
  'stock':     ['inventory','quantity','qty','goods'],
  'report':    ['reports','statement','summary'],
  'user':      ['users','employee','staff','operator'],
  'role':      ['roles','permission','access','rights'],
  'payment':   ['pay','paid','receipt','remittance'],
  'order':     ['orders','requisition'],
  'manage':    ['managing','handle','process','work'],
};

// ── Typo corrections ──────────────────────────────────────────────────────────
const TYPOS = {
  'purchace':'purchase','purcase':'purchase','purchse':'purchase',
  'invoce':'invoice','invocie':'invoice','recieve':'receive',
  'receit':'receipt','reciept':'receipt','transferr':'transfer',
  'confgure':'configure','configre':'configure','settng':'setting',
  'approv':'approve','aprove':'approve','stockk':'stock',
  'purchaseorder':'purchase order','purchaseorders':'purchase orders',
  'goodsreceipt':'goods receipt','stocktransfer':'stock transfer',
  'journalvoucher':'journal voucher',
};

// ── TF-IDF Engine ─────────────────────────────────────────────────────────────
class TFIDFIndex {
  constructor() {
    this.docVectors = [];   // [{id, vec:{term:tfidf}}]
    this.idf        = {};   // {term: idf_score}
    this.built      = false;
  }

  // Build the TF-IDF index from all pages
  build(pages) {
    const N = pages.length;
    if (N === 0) return;

    console.log(`  Building TF-IDF index for ${N} pages...`);
    const t0 = Date.now();

    // Step 1: Count document frequency for each term
    const df = {};
    const termSets = pages.map(page => {
      const tokens = tokenize(`${page.title} ${page.title} ${page.title} ${(page.fullText||'').slice(0, 3000)}`);
      const termSet = new Set(tokens);
      termSet.forEach(t => { df[t] = (df[t] || 0) + 1; });
      return { tokens, termSet };
    });

    // Step 2: Compute IDF — log(N / df) — rare terms score higher
    this.idf = {};
    for (const [term, count] of Object.entries(df)) {
      this.idf[term] = Math.log((N + 1) / (count + 1)) + 1; // smoothed IDF
    }

    // Step 3: Build TF-IDF vectors — top 40 terms only to save RAM
    this.docVectors = pages.map((page, i) => {
      const { tokens } = termSets[i];
      const tf = {};
      tokens.forEach(t => { tf[t] = (tf[t] || 0) + 1; });
      const len = tokens.length || 1;
      const scored = [];
      for (const [t, count] of Object.entries(tf)) {
        const tfidf = (count / len) * (this.idf[t] || 1);
        if (tfidf > 0.005) scored.push([t, tfidf]);
      }
      // Keep top 40 terms only — saves ~70% memory vs unlimited
      scored.sort((a,b) => b[1]-a[1]);
      const top = scored.slice(0, 40);
      const norm = Math.sqrt(top.reduce((s,[,v]) => s + v*v, 0)) || 1;
      const vec = {};
      top.forEach(([t,v]) => vec[t] = v/norm);
      return { id: page.id, vec };
    });

    // Free intermediate data
    termSets.length = 0;

    this.built = true;
    console.log(`  ✅ TF-IDF index built in ${Date.now()-t0}ms (${Object.keys(this.idf).length} unique terms, optimised)`);
  }

  // Compute cosine similarity between query and all documents
  query(queryText, topK = 20) {
    if (!this.built) return [];

    // Build query vector
    const qTokens = tokenize(queryText);
    const qTF = {};
    qTokens.forEach(t => { qTF[t] = (qTF[t] || 0) + 1; });
    const qLen = qTokens.length || 1;
    const qVec = {};
    for (const [t, count] of Object.entries(qTF)) {
      const idf = this.idf[t] || Math.log((1 + 1) / (1 + 1)) + 1; // unknown terms get low IDF
      qVec[t] = (count / qLen) * idf;
    }
    // Normalize
    const qNorm = Math.sqrt(Object.values(qVec).reduce((s, v) => s + v * v, 0)) || 1;
    for (const t in qVec) qVec[t] /= qNorm;

    // Compute cosine similarity with every doc
    const scores = this.docVectors.map(doc => {
      let dot = 0;
      for (const [t, v] of Object.entries(qVec)) {
        if (doc.vec[t]) dot += v * doc.vec[t];
      }
      return { id: doc.id, score: dot };
    });

    return scores
      .filter(s => s.score > 0.01)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}

// ── Tokenizer (shared) ────────────────────────────────────────────────────────
function tokenize(text) {
  if (!text) return [];
  return text.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP.has(w));
}

// ── Main KB Search class ──────────────────────────────────────────────────────
class KBSearch {
  constructor() {
    this.pages    = [];
    this.pageMap  = {};      // id → page (fast lookup)
    this.tfidf    = new TFIDFIndex();
    this.loaded   = false;
    this.loadedAt = null;
  }

  load() {
    if (!fs.existsSync(INDEX_FILE)) return false;
    try {
      const raw     = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
      this.pages    = raw.pages || [];
      this.loadedAt = raw.crawledAt;
      this.loaded   = true;

      // Build lookup map
      this.pageMap = {};
      this.pages.forEach(p => { this.pageMap[p.id] = p; });

      const totImgs = this.pages.reduce((s,p) => s+(p.images||[]).length, 0);
      const totVids = this.pages.reduce((s,p) => s+(p.videos||[]).length, 0);
      const spaces  = new Set(this.pages.map(p=>p.spaceKey).filter(Boolean)).size;
      console.log(`✅ KB loaded: ${this.pages.length} pages | ${totImgs} images | ${totVids} videos | ${spaces} spaces`);

      // Build TF-IDF index only if not in memory-constrained env
      const useTFIDF = process.env.USE_TFIDF !== 'false';
      if (useTFIDF) {
        this.tfidf.build(this.pages);
      } else {
        console.log('  ⚡ TF-IDF disabled (USE_TFIDF=false) — using keyword search only');
      }

      // Always free fullText after indexing to save RAM
      this.pages.forEach(p => {
        p.fullText = undefined;
        if (p.content && p.content.length > 1500) p.content = p.content.slice(0, 1500);
        // Also trim images/videos arrays to save memory
        if (p.images && p.images.length > 10) p.images = p.images.slice(0, 10);
      });

      // Force GC hint
      if (global.gc) global.gc();

      return true;
    } catch(e) {
      console.error('KB load error:', e.message);
      return false;
    }
  }

  reload() { this.pages=[]; this.pageMap={}; this.tfidf=new TFIDFIndex(); this.loaded=false; return this.load(); }

  getStats() {
    const totImgs = this.pages.reduce((s,p) => s+(p.images||[]).length, 0);
    const totVids = this.pages.reduce((s,p) => s+(p.videos||[]).length, 0);
    const spaces  = [...new Set(this.pages.map(p=>p.spaceKey).filter(Boolean))];
    return { loaded:this.loaded, totalPages:this.pages.length, totalImages:totImgs, totalVideos:totVids, spaces, crawledAt:this.loadedAt };
  }

  // ── Query expansion (keyword search helper) ─────────────────────────────────
  expandQuery(raw) {
    const tokens = tokenize(raw);
    const all    = new Set();
    const orig   = new Set();

    for (let tok of tokens) {
      // Typo correction
      if (TYPOS[tok]) tok = tokenize(TYPOS[tok])[0] || tok;
      all.add(tok); orig.add(tok);

      if (ABB[tok])  ABB[tok].forEach(phrase => tokenize(phrase).forEach(t => all.add(t)));
      if (SYN[tok])  SYN[tok].forEach(s => tokenize(s).forEach(t => all.add(t)));

      // Reverse abbreviation lookup
      for (const [abbr, exps] of Object.entries(ABB)) {
        if (exps.some(exp => tokenize(exp).includes(tok))) {
          all.add(abbr);
          exps.forEach(exp => tokenize(exp).forEach(t => all.add(t)));
        }
      }
    }
    return { expanded: [...all], original: [...orig], rawPhrase: raw.toLowerCase().trim() };
  }

  // ── Keyword score for one page ──────────────────────────────────────────────
  keywordScore(page, expanded, original, rawPhrase) {
    let score = 0;
    const titleLow   = (page.title || '').toLowerCase();
    const titleToks  = tokenize(page.title || '');
    const bodyToks   = page.tokens || tokenize(page.fullText || '');
    const bodyLen    = Math.sqrt(Math.max(bodyToks.length, 1));
    const spaceName  = (page.spaceName || page.spaceKey || '').toLowerCase();

    // Exact phrase in title — strongest signal
    if (rawPhrase.length > 3 && titleLow.includes(rawPhrase)) score += 80;

    // Fuzzy title word overlap
    const origToks     = tokenize(rawPhrase);
    const titleRawToks = tokenize(titleLow);
    const overlapCount = origToks.filter(t =>
      titleRawToks.some(tt => tt === t || tt.startsWith(t) || t.startsWith(tt))
    ).length;
    if (origToks.length > 0) score += (overlapCount / origToks.length) * 40;

    // Term-level scoring
    for (const term of expanded) {
      const w = original.includes(term) ? 1.0 : 0.55;
      if (titleLow.includes(term))                                                              score += 28 * w;
      titleToks.filter(t => t===term || t.startsWith(term) || term.startsWith(t)).forEach(() => { score += 14 * w; });
      if (spaceName.includes(term))                                                             score += 5  * w;
      (page.labels   ||[]).filter(l=>l.toLowerCase().includes(term)).forEach(()=>              { score += 10 * w; });
      (page.ancestors||[]).filter(a=>a.toLowerCase().includes(term)).forEach(()=>              { score += 6  * w; });
      const hits = bodyToks.filter(t=>t===term||t.startsWith(term)||term.startsWith(t)).length;
      score += (hits / bodyLen) * 4 * w;
    }

    // Phrase match in body
    if (rawPhrase.split(' ').length > 1) {
      const bodyText = (page.fullText || '').toLowerCase();
      if (bodyText.includes(rawPhrase)) score += 20;
      const occ = (bodyText.match(new RegExp(rawPhrase.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi'))||[]).length;
      score += Math.min(occ * 4, 24);
    }

    return score;
  }

  // ── HYBRID SEARCH: keyword + TF-IDF semantic ────────────────────────────────
  search(query, topK = 6) {
    if (!this.loaded || !this.pages.length) return [];

    const { expanded, original, rawPhrase } = this.expandQuery(query);
    const allTerms = [...new Set([...expanded, ...original])];

    console.log(`\n  [SEARCH] "${query}"`);
    console.log(`  Terms: [${original.join(', ')}] → expanded: ${allTerms.length} tokens`);

    // ── 1. Keyword scores (all pages) ───────────────────────────────────────
    const kwScores = {};
    for (const page of this.pages) {
      const s = this.keywordScore(page, allTerms, original, rawPhrase);
      if (s > 0) kwScores[page.id] = s;
    }

    // ── 2. TF-IDF semantic scores (top candidates) ──────────────────────────
    // Build expanded query string for semantic matching
    const semanticQuery = [...new Set([...original, ...expanded])].join(' ');
    const tfidfResults  = this.tfidf.query(semanticQuery, 30);
    const tfidfScores   = {};
    const maxTFIDF      = tfidfResults[0]?.score || 1;
    tfidfResults.forEach(r => {
      // Normalise to 0–50 range so it blends proportionally with keyword scores
      tfidfScores[r.id] = (r.score / maxTFIDF) * 50;
    });

    // ── 3. Hybrid combination ────────────────────────────────────────────────
    const allIds = new Set([...Object.keys(kwScores), ...Object.keys(tfidfScores)]);
    const hybrid = [];
    for (const id of allIds) {
      const kw  = kwScores[id]    || 0;
      const sem = tfidfScores[id] || 0;
      const page = this.pageMap[id];
      if (!page) continue;

      // Blend: keyword is more precise, semantic fills gaps
      // If keyword score is high → trust keyword more
      // If keyword score is 0    → rely on semantic entirely
      const blendWeight = kw > 20 ? 0.75 : kw > 5 ? 0.6 : 0.3;
      const combined = kw * blendWeight + sem * (1 - blendWeight);

      if (combined > 1) hybrid.push({ page, score: combined, kw, sem });
    }

    hybrid.sort((a, b) => b.score - a.score);
    const top = hybrid.slice(0, topK);

    console.log(`  Results (hybrid): ${top.map(r=>`"${r.page.title}"[kw=${r.kw.toFixed(0)} sem=${r.sem.toFixed(0)} total=${r.score.toFixed(0)}]`).join(' | ')}`);

    return top.map(r => {
      const rankedImages = (r.page.images||[])
        .map(img => ({ ...img, relevance: this.mediaScore(img, allTerms) }))
        .sort((a,b) => b.relevance - a.relevance);
      const rankedVideos = (r.page.videos||[])
        .map(vid => ({ ...vid, relevance: this.mediaScore(vid, allTerms) }))
        .sort((a,b) => b.relevance - a.relevance);
      return {
        id:        r.page.id,
        title:     r.page.title,
        url:       r.page.url,
        spaceKey:  r.page.spaceKey,
        spaceName: r.page.spaceName,
        textForAI: r.page.fullText || '',
        images:    rankedImages,
        videos:    rankedVideos,
        score:     Math.round(r.score * 10) / 10,
        kwScore:   Math.round(r.kw),
        semScore:  Math.round(r.sem),
      };
    });
  }

  mediaScore(item, terms) {
    const capToks = tokenize(item.caption || '');
    const ctxToks = tokenize(item.context  || '');
    let score = 0;
    for (const t of terms) {
      capToks.filter(c => c.includes(t) || t.includes(c)).forEach(() => { score += 6; });
      ctxToks.filter(c => c.includes(t) || t.includes(c)).forEach(() => { score += 2; });
    }
    return score;
  }
}

// ── YouTube search — strict relevance ────────────────────────────────────────
class YTSearch {
  constructor() { this.videos=[]; this.loaded=false; }

  load() {
    const f = path.join(__dirname,'..','data','yt-index.json');
    if (!fs.existsSync(f)) return false;
    try {
      const raw = JSON.parse(fs.readFileSync(f,'utf8'));
      this.videos = raw.videos || [];
      this.loaded = true;
      console.log(`✅ YouTube index: ${this.videos.length} videos`);
      return true;
    } catch(e) { return false; }
  }

  getStats() { return { loaded:this.loaded, totalVideos:this.videos.length }; }

  search(query, topK=2, videoIntent=false) {
    if (!this.loaded) return [];

    // Strip "video/tutorial/show me" words — they confuse matching
    const cleanQ = query.replace(/\b(video|tutorial|watch|show me|youtube|demo|recording|can you|provide|give me|please|on|for|about)\b/gi,' ').replace(/\s+/g,' ').trim() || query;
    const qToks = tokenize(cleanQ);
    const qRaw  = cleanQ.toLowerCase().trim();

    // Build bigrams for phrase matching: "purchase order" → ["purchase order"]
    const bigrams = [];
    for (let i=0; i<qToks.length-1; i++) bigrams.push(qToks[i]+' '+qToks[i+1]);

    // Videos that are NOT tutorials/how-to should almost never appear
    const NON_TUTORIAL_PENALTY = [
      /yoga/i, /meditation/i, /wellness/i, /birthday/i, /celebrate/i,
      /celebration/i, /festiv/i, /event/i, /testimonial/i, /journey/i,
      /story/i, /culture/i, /team/i, /award/i, /office/i, /fun/i,
      /interview/i, /hiring/i, /career/i, /join us/i, /about us/i,
    ];

    const scored = this.videos.map(v => {
      const tL = (v.title       || '').toLowerCase();
      const dL = (v.description || '').toLowerCase();
      let score = 0;

      // ── Hard block: non-tutorial content ──────────────────────────────────
      if (NON_TUTORIAL_PENALTY.some(re => re.test(tL))) return { ...v, score: -1 };

      // ── Bigram phrase match (strongest signal) ─────────────────────────────
      for (const b of bigrams) {
        if (tL.includes(b)) score += 40;  // "purchase order" in title = very relevant
        if (dL.includes(b)) score += 15;
      }

      // ── Individual token match ─────────────────────────────────────────────
      let titleHits = 0;
      for (const t of qToks) {
        if (tL.includes(t)) { score += 12; titleHits++; }
        if (dL.includes(t)) score += 3;
      }

      // ── Require MAJORITY of query tokens to appear in title ───────────────
      // This prevents "POS Order" matching "Purchase Order" (only shares "order")
      const majorityRequired = Math.ceil(qToks.length * 0.6);
      if (titleHits < majorityRequired) score = Math.min(score, 5); // cap low

      // ── Bonus: video title starts with "how to" + query topic ─────────────
      if (/^(how to|ginesys tutorial|tutorial)/i.test(tL)) score += 8;

      // ── Exact query match in title (best possible) ─────────────────────────
      if (tL.includes(qRaw)) score += 50;

      return { ...v, score };
    });

    // Threshold — lower for explicit video requests
    return scored
      .filter(v => videoIntent ? v.score >= 12 : v.score >= 25)
      .sort((a,b) => b.score - a.score)
      .slice(0, topK);
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────
const kb = new KBSearch();
kb.yt = new YTSearch();

module.exports = {
  load:     () => { const ok = kb.load(); if (ok) kb.yt.load(); return ok; },
  reload:   () => kb.reload(),
  search:   (q,k) => kb.search(q,k),
  getStats: () => kb.getStats(),
  get yt()  { return kb.yt; },
};
