/**
 * Ginesys AI Assistant — server.js v6.0
 * Features: Streaming, Caching, Feedback, Related Qs, Admin Dashboard,
 *           Suggested Questions, PDF export hint, Multi-lang, Voice Input support
 */
require('dotenv').config();
const http  = require('http');

// ── Prevent silent crashes — log all uncaught errors ─────────────────────────
process.on('uncaughtException', err => {
  console.error('\n❌ UNCAUGHT EXCEPTION (server keeps running):', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('\n❌ UNHANDLED REJECTION (server keeps running):', reason?.message || reason);
  // Do NOT exit — keep server alive on Render
});
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');
const search = require('./search');

const {
  PORT = 3000,
  ANTHROPIC_API_KEY: _RAW_KEY,
  ATLASSIAN_EMAIL,
  ATLASSIAN_API_TOKEN,
  CONFLUENCE_BASE_URL = 'https://ginesysone.atlassian.net',
  MAX_CHARS = 12000,
} = process.env;

// Sanitize API key — strip quotes/spaces/newlines that cause header errors
const ANTHROPIC_API_KEY = _RAW_KEY ? _RAW_KEY.trim().replace(/^["']+|["']+$/g,'').replace(/[\r\n\t]/g,'') : undefined;

const PUBLIC_DIR  = path.join(__dirname,'..','public');
const DATA_DIR    = path.join(__dirname,'..','data');
const CACHE_FILE  = path.join(DATA_DIR,'cache.json');
const FEEDBACK_FILE = path.join(DATA_DIR,'feedback.json');
const ANALYTICS_FILE = path.join(DATA_DIR,'analytics.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR,{recursive:true});
search.load();

// ── In-memory cache ───────────────────────────────────────────────────────────
const cache = new Map();
try {
  if (fs.existsSync(CACHE_FILE)) {
    const stat = fs.statSync(CACHE_FILE);
    if (stat.size > 50 * 1024 * 1024) {
      console.log('⚠️  Cache file too large (>50MB) — skipping load, will rebuild');
      fs.unlinkSync(CACHE_FILE);
    } else {
      const saved = JSON.parse(fs.readFileSync(CACHE_FILE,'utf8'));
      const now = Date.now();
      Object.entries(saved).forEach(([k,v]) => {
        if (now - v.ts < 86400000) cache.set(k,v); // 24hr TTL
      });
      console.log(`✅ Cache loaded: ${cache.size} entries`);
    }
  }
} catch(e) {
  console.log('⚠️  Cache load failed (will start fresh):', e.message);
  try { fs.unlinkSync(CACHE_FILE); } catch(_) {}
}

function saveCache() {
  const obj = {};
  cache.forEach((v,k) => { obj[k]=v; });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(obj));
}

function getCacheKey(q) {
  return q.toLowerCase().trim().replace(/\s+/g,' ').replace(/[^a-z0-9 ]/g,'');
}

// ── Analytics ─────────────────────────────────────────────────────────────────
let analytics = { totalQueries:0, topQueries:{}, dailyStats:{}, startedAt: new Date().toISOString() };
try {
  if (fs.existsSync(ANALYTICS_FILE)) analytics = JSON.parse(fs.readFileSync(ANALYTICS_FILE,'utf8'));
} catch(e) {}

function trackQuery(q, fromCache) {
  analytics.totalQueries = (analytics.totalQueries||0) + 1;
  const key = getCacheKey(q).slice(0,80);
  analytics.topQueries[key] = (analytics.topQueries[key]||0) + 1;
  const day = new Date().toISOString().slice(0,10);
  if (!analytics.dailyStats[day]) analytics.dailyStats[day] = {queries:0, cached:0};
  analytics.dailyStats[day].queries++;
  if (fromCache) analytics.dailyStats[day].cached = (analytics.dailyStats[day].cached||0)+1;
  // Save after every query (async so it doesn't block response)
  setImmediate(() => {
    try { fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(analytics)); } catch(e) {}
  });
}

// ── Feedback store ─────────────────────────────────────────────────────────────
let feedbackStore = [];
try {
  if (fs.existsSync(FEEDBACK_FILE)) feedbackStore = JSON.parse(fs.readFileSync(FEEDBACK_FILE,'utf8'));
} catch(e) {}

// ── Casual chat detection ─────────────────────────────────────────────────────
function isCasualChat(q) {
  const t = q.trim().toLowerCase().replace(/[^a-z0-9\s]/g,'').trim();
  if (t.length < 3) return true;
  const p = [
    /^(hi|hello|hey|hii|helo|hai|hiya|howdy|greetings)(\s|$)/,
    /^how are you/,/^how r u/,/^what('s| is) up/,/^good (morning|afternoon|evening|day)/,
    /^(good|great|nice|okay|ok|fine|thanks|thank you|thx|ty|welcome|noted|sure|perfect)(\s|$)/,
    /^(bye|goodbye|see you|cya|end|exit|quit|done|finished|stop)(\s|$)/,
    /^(yes|no|yeah|nope|yep|nah|correct|right|exactly|agreed)(\s|$)/,
    /^(who are you|what are you|introduce yourself|tell me about yourself)/,
    /^test(\s|$)/,
  ];
  if (t.split(' ').length <= 5 && p.some(r=>r.test(t))) return true;
  return false;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseBody(req) {
  return new Promise((resolve,reject)=>{
    let b='';
    req.on('data',c=>{b+=c; if(b.length>4e6)req.destroy();});
    req.on('end',()=>{try{resolve(JSON.parse(b));}catch{resolve({});}});
    req.on('error',reject);
  });
}
function jsonRes(res,status,data) {
  res.writeHead(status,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
  res.end(JSON.stringify(data));
}
function fetchUrl(targetUrl,extraHeaders={}) {
  return new Promise((resolve,reject)=>{
    const follow=(u,depth)=>{
      if(depth>5)return reject(new Error('Too many redirects'));
      const p=new URL(u);
      https.get({hostname:p.hostname,path:p.pathname+p.search,headers:{'User-Agent':'GinesysAI/6.0',...extraHeaders},timeout:20000},res=>{
        if([301,302,303,307,308].includes(res.statusCode)&&res.headers.location){
          const next=res.headers.location.startsWith('http')?res.headers.location:`https://${p.hostname}${res.headers.location}`;
          return follow(next,depth+1);
        }
        const chunks=[];
        res.on('data',c=>chunks.push(c));
        res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));
      }).on('error',reject).on('timeout',()=>reject(new Error('Timeout')));
    };
    follow(targetUrl,0);
  });
}

// ── Claude — non-streaming (casual/fast) ─────────────────────────────────────
async function callClaude(system,messages,maxTokens=512) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');
  const body=JSON.stringify({model:'claude-haiku-4-5-20251001',max_tokens:maxTokens,system,messages});
  return new Promise((resolve,reject)=>{
    const req=https.request({
      hostname:'api.anthropic.com',path:'/v1/messages',method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01','Content-Length':Buffer.byteLength(body)},
    },res=>{
      let d='';
      res.on('data',c=>d+=c);
      res.on('end',()=>{
        try{const p=JSON.parse(d); if(p.error)return reject(new Error(p.error.message)); resolve((p.content||[]).filter(b=>b.type==='text').map(b=>b.text).join(''));}
        catch(e){reject(new Error('Parse error'));}
      });
    });
    req.on('error',reject); req.write(body); req.end();
  });
}

// ── Claude — streaming (main answers) ────────────────────────────────────────
function streamClaude(system,messages,onChunk,onDone,onError,maxTokens=4096) {
  if (!ANTHROPIC_API_KEY) return onError(new Error('ANTHROPIC_API_KEY not configured'));
  const body=JSON.stringify({model:'claude-opus-4-6',max_tokens:maxTokens,stream:true,system,messages});
  const req=https.request({
    hostname:'api.anthropic.com',path:'/v1/messages',method:'POST',
    headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01','Content-Length':Buffer.byteLength(body)},
  },res=>{
    let buf='',done=false;
    // Log non-200 responses for debugging
    if(res.statusCode!==200){
      let errBody='';
      res.on('data',c=>errBody+=c.toString());
      res.on('end',()=>{
        console.error('❌ Claude API error status:',res.statusCode, errBody.slice(0,200));
        onError(new Error('Claude API error: '+res.statusCode+' '+errBody.slice(0,100)));
      });
      return;
    }
    res.on('data',chunk=>{
      buf+=chunk.toString();
      const lines=buf.split('\n'); buf=lines.pop();
      for(const line of lines){
        if(!line.startsWith('data: '))continue;
        const data=line.slice(6).trim();
        if(data==='[DONE]')continue;
        try{
          const evt=JSON.parse(data);
          if(evt.type==='content_block_delta'&&evt.delta?.type==='text_delta') onChunk(evt.delta.text);
          else if(evt.type==='message_stop'&&!done){done=true;onDone();}
          else if(evt.type==='error') onError(new Error(evt.error?.message||'Stream error'));
        }catch(e){}
      }
    });
    res.on('end',()=>{if(!done)onDone();});
    res.on('error',onError);
  });
  req.setTimeout(25000, () => {
    console.error('❌ Claude request timeout after 25s');
    req.destroy();
    onError(new Error('Claude API timeout'));
  });
  req.on('error',(e)=>{console.error('❌ Claude req error:',e.message);onError(e);}); req.write(body); req.end();
}

// ── System prompts ────────────────────────────────────────────────────────────
const AI_PERSONA = `You are the Ginesys AI Assistant — a highly accurate, helpful, and human-like assistant for Ginesys ERP.

ROLES: Support Expert + Sales Consultant + Product Trainer
MODULES YOU KNOW: POS, Purchase Orders, GRC, Stock Transfers, GST, E-Way Bills, Journal Vouchers, Inventory, Warehouse, Users & Roles, Reports, Installation, and all Ginesys modules.

INTENT TYPES:
1. SUPPORT → Step-by-step, exact menu/button names, numbered steps
2. SALES/BRAND → Positive, confident, highlight strengths
3. PRICING → Depends on stores/modules/scale, offer demo
4. GENERAL → Answer like a friendly expert

RULES:
❌ Never say "not found in KB", "based on articles", "I am an AI", "Ginni"
❌ Never show unrelated content
✅ Always give complete confident answers
✅ Auto-correct spelling silently
✅ STRICT RELEVANCE — PO question = only PO content`;

function buildCasualPrompt(langInstruction='') {
  const lang = langInstruction ? `\n\n${langInstruction}` : '';
  return `${AI_PERSONA}\n\nRespond warmly in 2-3 sentences. Introduce yourself as the Ginesys AI Assistant. Be friendly and human.${lang}`;
}

function buildKBPrompt(results, q, ytResults=[], langInstruction='') {
  if (!results||!results.length) {
    const langPrefix2 = langInstruction ? `***${langInstruction}***\n\n` : '';
  return `${langPrefix2}${AI_PERSONA}\n\nNo KB articles found. Answer from Ginesys ERP expertise. Be complete and confident.\n\nQuestion: "${q}"\n\nFormat: ## heading, numbered steps, **bold** UI elements`;
  }
  const kb = results.map((r,i)=>{
    const crumb=[...(r.ancestors||[]),r.title].join(' › ');
    return `--- Article ${i+1}: ${r.title} ---\nPath: ${crumb}\nURL: ${r.url}\n\n${(r.textForAI||'').slice(0,parseInt(MAX_CHARS))}\n---`;
  }).join('\n\n');
  const yt = (ytResults&&ytResults.length)
    ? '\n\nYOUTUBE:\n'+ytResults.map((v,i)=>`${i+1}. "${v.title}" — ${v.url}`).join('\n') : '';
  const langPrefix = langInstruction ? `***${langInstruction}***\n\nYOU MUST FOLLOW THE ABOVE LANGUAGE INSTRUCTION FOR YOUR ENTIRE RESPONSE.\n\n` : '';
  return `${langPrefix}${AI_PERSONA}\n\nKB ARTICLES (${results.length}):\n${'─'.repeat(40)}\n${kb}\n${'─'.repeat(40)}${yt}\n\nQUESTION: "${q}"\n\nINSTRUCTIONS:\n- Detect intent first\n- Use ONLY relevant content (ignore unrelated modules)\n- Combine articles for complete answer\n- Never say "not found"\n- ## sections, numbered steps, **bold** UI labels\n- End with: ## Sources (links)\n${langInstruction ? '- '+langInstruction : ''}`;
}

function buildRelatedPrompt(q, answer) {
  return `Based on this Ginesys ERP question and answer, suggest exactly 3 short follow-up questions a user might ask next.
Question: "${q}"
Answer summary: "${answer.slice(0,300)}"
Return ONLY a JSON array of 3 strings, no explanation. Example: ["How to approve a PO?", "How to view PO status?", "How to cancel a PO?"]`;
}

// ── Image/video helpers ───────────────────────────────────────────────────────
function cleanCaption(caption,pageTitle) {
  if(!caption) return pageTitle||'Screenshot';
  const c=caption.replace(/^(image|screenshot|screen shot|img|capture)[\d\s_.\-]*/i,'').replace(/\.(png|jpg|jpeg|gif|webp|svg|mp4|mov)$/i,'').replace(/[-_]+/g,' ').trim();
  return c.length>3?c:(pageTitle||'Screenshot');
}

function filterRelevantImages(results, query, max=3) {
  const qToks = query.toLowerCase().replace(/[^\w\s]/g,' ').split(/\s+/).filter(w=>w.length>2);
  // Also get bigram pairs for phrase matching e.g. "purchase order"
  const bigrams = [];
  for (let i=0; i<qToks.length-1; i++) bigrams.push(qToks[i]+' '+qToks[i+1]);

  return results.flatMap(r => (r.images||[]).map(img => {
    const capL = (img.caption||'').toLowerCase();
    const ctxL = (img.context||'').toLowerCase();
    const ttlL = (r.title||'').toLowerCase();
    let score = 0; // start from 0, not from stored relevance

    // Strong signal: image caption/context directly mentions query terms
    for (const t of qToks) {
      if (capL.includes(t)) score += 10;
      if (ctxL.includes(t)) score += 6;
      if (ttlL.includes(t)) score += 3;
    }
    // Bigram bonus — phrase match
    for (const b of bigrams) {
      if (capL.includes(b)) score += 15;
      if (ctxL.includes(b)) score += 10;
    }
    // Heavy penalty: raw auto-generated filename
    if (/^image[\d\s_.\-]+$/i.test(img.caption||'')) score -= 20;
    if (/^screenshot[\d\s_.\-]+$/i.test(img.caption||'')) score -= 15;
    // Penalty: caption is just the page title (low specificity)
    if ((img.caption||'').trim() === (r.title||'').trim()) score -= 8;

    return {
      proxyUrl: `/api/proxy-media?url=${encodeURIComponent(img.url)}`,
      caption:  cleanCaption(img.caption, r.title),
      context:  img.context||'',
      pageTitle: r.title,
      relevance: score,
    };
  }))
  .filter(i => i.relevance >= 8)   // only genuinely relevant images
  .sort((a,b) => b.relevance - a.relevance)
  .slice(0, max);
}

function buildVideos(results, ytResults, q, videoIntent=false) {
  const qToks  = q.toLowerCase().replace(/[^\w\s]/g,' ').split(/\s+/).filter(w=>w.length>2);
  const qRaw   = q.toLowerCase().trim();
  const bigrams = [];
  for (let i=0; i<qToks.length-1; i++) bigrams.push(qToks[i]+' '+qToks[i+1]);

  // Non-tutorial video types that should NEVER appear in answers
  const NON_TUTORIAL = [
    /yoga/i,/meditation/i,/wellness/i,/birthday/i,/celebrat/i,
    /testimonial/i,/journey/i,/story/i,/culture/i,/team/i,
    /award/i,/office/i,/hiring/i,/career/i,/about us/i,/event/i,
  ];

  function scoreVideo(title, context, pageTitle) {
    const tL = (title||'').toLowerCase();
    const cL = (context||'').toLowerCase();
    const pL = (pageTitle||'').toLowerCase();

    // Hard block non-tutorial content
    if (NON_TUTORIAL.some(re => re.test(tL))) return -1;

    let score = 0;

    // Bigram phrase match (e.g. "purchase order" must appear together)
    for (const b of bigrams) {
      if (tL.includes(b)) score += 35;
      if (cL.includes(b)) score += 12;
      if (pL.includes(b)) score += 10;
    }

    // Token match — count how many query tokens appear in title
    let titleHits = 0;
    for (const t of qToks) {
      if (tL.includes(t)) { score += 10; titleHits++; }
      if (cL.includes(t)) score += 3;
      if (pL.includes(t)) score += 5;
    }

    // Penalise if majority of query tokens are NOT in title
    // e.g. query="purchase order" → "POS order" only matches "order" → 1/2 = 50% < 60% → capped
    const majorityThreshold = Math.ceil(qToks.length * 0.6);
    if (qToks.length > 1 && titleHits < majorityThreshold) score = Math.min(score, 8);

    // Exact query in title
    if (tL.includes(qRaw)) score += 40;

    return score;
  }

  // KB-embedded videos — score against page title (most reliable context)
  const kbVids = (results||[]).flatMap(r => (r.videos||[]).map(v => {
    const s = scoreVideo(v.caption, v.context, r.title);
    return {
      url:       v.url,
      proxyUrl:  (v.type==='youtube'||v.type==='vimeo') ? v.url : `/api/proxy-media?url=${encodeURIComponent(v.url)}`,
      caption:   cleanCaption(v.caption, r.title),
      context:   v.context||'',
      pageTitle: r.title,
      relevance: s,
      type:      v.type||'video',
      videoId:   v.videoId||null,
    };
  }));

  // YouTube results already filtered by YTSearch — just map them
  const ytVids = (ytResults||[]).map(v => ({
    url:       v.url,
    proxyUrl:  v.url,
    caption:   v.title,
    context:   (v.description||'').slice(0,120),
    pageTitle: 'Ginesys YouTube',
    relevance: scoreVideo(v.title, v.description, ''),
    type:      'youtube',
    videoId:   v.videoId||v.id,
  }));

  return [...kbVids, ...ytVids]
    .filter(v => videoIntent ? v.relevance >= 10 : v.relevance >= 20)  // lower bar for explicit video requests
    .sort((a,b) => b.relevance - a.relevance)
    .slice(0, 2);
}

// ── Static files ──────────────────────────────────────────────────────────────
const MIME={'.html':'text/html;charset=utf-8','.js':'application/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon','.json':'application/json'};
function serveStatic(res,fp) {
  fs.readFile(fp,(err,data)=>{
    if(err){res.writeHead(404);return res.end('Not found');}
    res.writeHead(200,{'Content-Type':MIME[path.extname(fp)]||'text/plain'});
    res.end(data);
  });
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req,res)=>{
  // Disable Nagle's algorithm — critical for SSE on Windows
  if (req.socket) req.socket.setNoDelay(true);
  const parsed=new URL(req.url,'http://localhost');parsed.query=Object.fromEntries(parsed.searchParams);
  const pn=parsed.pathname||'/';
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS'){res.writeHead(204);return res.end();}

  // ── GET /api/status ─────────────────────────────────────────────────────────
  if(pn==='/api/status'&&req.method==='GET'){
    const s=search.getStats(), yt=search.yt?search.yt.getStats():{loaded:false,totalVideos:0};
    return jsonRes(res,200,{status:'ok',version:'6.0.0',anthropic:!!ANTHROPIC_API_KEY,kb:s,youtube:yt,cache:cache.size,totalQueries:analytics.totalQueries});
  }

  // ── GET /api/admin ──────────────────────────────────────────────────────────
  if(pn==='/api/admin'&&req.method==='GET'){
    const topQ = Object.entries(analytics.topQueries||{})
      .sort((a,b)=>b[1]-a[1]).slice(0,20).map(([q,c])=>({query:q,count:c}));
    const fb   = feedbackStore.slice(-50);
    // Sort days descending and return as array of [date, stats] pairs
    const days = Object.entries(analytics.dailyStats||{})
      .sort((a,b)=>b[0].localeCompare(a[0])).slice(0,14);
    const kbStats = search.getStats();
    const ytStats = search.yt ? search.yt.getStats() : {loaded:false,totalVideos:0};
    // Calculate total cached from daily stats
    const totalCached = Object.values(analytics.dailyStats||{}).reduce((s,d)=>s+(d.cached||0),0);
    return jsonRes(res,200,{
      totalQueries: analytics.totalQueries||0,
      totalCached,
      cacheSize:    cache.size,
      topQueries:   topQ,
      recentFeedback: fb,
      feedbackCount: feedbackStore.length,
      upCount:      feedbackStore.filter(f=>f.rating==='up').length,
      downCount:    feedbackStore.filter(f=>f.rating==='down').length,
      dailyStats:   days,
      kb:           kbStats,
      youtube:      ytStats,
      startedAt:    analytics.startedAt,
    });
  }

  // ── POST /api/feedback ──────────────────────────────────────────────────────
  if(pn==='/api/feedback'&&req.method==='POST'){
    const body=await parseBody(req);
    const entry={ts:new Date().toISOString(),question:body.question,rating:body.rating,comment:body.comment||''};
    feedbackStore.push(entry);
    if(feedbackStore.length>500)feedbackStore=feedbackStore.slice(-500);
    fs.writeFileSync(FEEDBACK_FILE,JSON.stringify(feedbackStore));
    return jsonRes(res,200,{ok:true});
  }

  // ── POST /api/ask-stream — streaming via fetch (works on Windows) ──────────
  if(pn==='/api/ask-stream'&&req.method==='POST'){
    let body={};
    try{ body=await parseBody(req); }catch{}
    const q=(body.question||'').trim();
    const langInstruction=(body.lang||'').trim();
    let history=[];
    try{ history=body.history||[]; }catch{}
    if(!q){ res.writeHead(400); return res.end('Missing question'); }

    // SSE headers — flush immediately
    res.writeHead(200,{
      'Content-Type':'text/event-stream',
      'Cache-Control':'no-cache, no-transform',
      'Connection':'keep-alive',
      'Access-Control-Allow-Origin':'*',
      'X-Accel-Buffering':'no',
      'X-Content-Type-Options':'nosniff',
      'Transfer-Encoding':'identity',
    });
    if(req.socket) { req.socket.setNoDelay(true); req.socket.setTimeout(0); }
    // Force flush on Render's proxy
    res.flushHeaders();

    const send=(event,data)=>{
      try{ res.write('event: '+event+'\ndata: '+JSON.stringify(data)+'\n\n'); }catch{}
    };

    const histMsgs=(history||[]).slice(-10).map(m=>({role:m.role,content:m.content}));
    trackQuery(q,false);

    // Casual chat
    if(isCasualChat(q)){
      try{
        const answer=await callClaude(buildCasualPrompt(langInstruction),[...histMsgs,{role:'user',content:q}],400);
        send('answer',{text:answer,casual:true,sources:[],images:[],videos:[],related:[]});
      }catch(e){ send('error',{message:e.message}); }
      return res.end();
    }

    // Cache check
    const cacheKey=getCacheKey(q);
    if(cache.has(cacheKey)){
      const cached=cache.get(cacheKey);
      trackQuery(q,true);
      send('meta',{fromKB:cached.fromKB,sources:cached.sources,images:cached.images,videos:cached.videos,fromCache:true});
      const words=cached.answer.split(' ');
      for(let i=0;i<words.length;i+=2){
        send('chunk',{text:words.slice(i,i+2).join(' ')+(i+2<words.length?' ':'')});
        await new Promise(r=>setTimeout(r,40));
      }
      send('done',{related:cached.related||[]});
      return res.end();
    }

    // Detect if user is explicitly asking for a video
    const isVideoRequest = /\b(video|tutorial|watch|show me|youtube|demo|recording|how.*video|video.*how)\b/i.test(q);

    // Resolve follow-up references like "that", "it", "this", "the same"
    // e.g. "give me youtube video on that" → extract topic from last assistant message
    const isFollowUp = /\b(that|it|this|same|above|previous|last|the one)\b/i.test(q) || q.trim().split(' ').length <= 6;
    let searchQuery = q;
    if (isFollowUp && histMsgs.length >= 2) {
      // Find the last user question that wasn't a video/follow-up request
      const prevUserMsgs = histMsgs.filter(m => m.role === 'user' &&
        !/\b(video|tutorial|that|it|this|same|show me|give me|provide|youtube)\b/i.test(m.content));
      if (prevUserMsgs.length > 0) {
        const prevTopic = prevUserMsgs[prevUserMsgs.length - 1].content;
        // Merge: keep video intent words from current + topic from previous
        searchQuery = isVideoRequest
          ? prevTopic  // just search the topic, video intent handled separately
          : q + ' ' + prevTopic.slice(0, 80);
        console.log('  [CONTEXT] Follow-up: "' + q + '" → topic: "' + prevTopic.slice(0,60) + '"');
      }
    }

    // KB search — fetch more YT results for video requests
    const [results,ytResults]=await Promise.all([
      Promise.resolve(search.search(searchQuery, 6)),
      Promise.resolve(search.yt?search.yt.search(searchQuery, isVideoRequest?8:3, isVideoRequest):[]),
    ]);
    const fromKB=results.length>0;
    const images=fromKB?filterRelevantImages(results,searchQuery,3):[];
    const videos=buildVideos(fromKB?results:[],ytResults,searchQuery, isVideoRequest);
    const sources=results.map(r=>({title:r.title,url:r.url,score:r.score,space:r.spaceKey}));
    // For follow-up video requests, tell Claude the actual topic
    const effectiveQ = (isVideoRequest && searchQuery !== q) ? (q + ' (about: ' + searchQuery + ')') : q;
    const system=buildKBPrompt(results,effectiveQ,ytResults,langInstruction);

    // Send metadata first so UI shows sources/images while text streams
    send('meta',{fromKB,sources,images,videos,fromCache:false});

    console.log('  [STREAM] Starting Claude stream for:', q.slice(0,50));

    // Heartbeat every 5s to prevent Render proxy timeout
    const heartbeat = setInterval(()=>{
      if(!res.writableEnded) res.write(': heartbeat\n\n');
    }, 5000);

    let fullText='', streamDone=false;
    streamClaude(
      system,
      [...histMsgs,{role:'user',content:q}],
      (chunk)=>{ fullText+=chunk; send('chunk',{text:chunk}); },
      async()=>{
        if(streamDone)return; streamDone=true;
        clearInterval(heartbeat);
        console.log('  [STREAM] Done, text length:', fullText.length);
        send('done',{related:[]});
        res.end();
        // Cache + related questions in background
        cache.set(cacheKey,{answer:fullText,fromKB,sources,images,videos,related:[],ts:Date.now()});
        callClaude('You are a helpful Ginesys ERP assistant.',[{role:'user',content:buildRelatedPrompt(q,fullText)}],200)
          .then(raw=>{
            try{
              const rel=JSON.parse(raw.replace(/```json|```/g,'').trim());
              if(Array.isArray(rel)){
                const c=cache.get(cacheKey); if(c) c.related=rel;
              }
            }catch{}
            try{saveCache();}catch{}
          }).catch(()=>{});
      },
      (err)=>{ clearInterval(heartbeat); console.log('  [STREAM] Error:',err.message); send('error',{message:err.message}); res.end(); }
    );
    return;
  }

  // ── POST /api/ask — main question endpoint ───────────────────────────────────
  if(pn==='/api/ask'&&req.method==='POST'){
    try{
      const body        = await parseBody(req);
      const q           = (body.question||'').trim();
      const langInstruction = (body.lang||'').trim();
      if(!q) return jsonRes(res,400,{error:'Missing question'});

      const histMsgs = (body.history||[]).slice(-10).map(m=>({role:m.role,content:m.content}));
      trackQuery(q, false);

      // Casual chat — fast Haiku response
      if(isCasualChat(q)){
        const answer = await callClaude(buildCasualPrompt(langInstruction),[...histMsgs,{role:'user',content:q}],400);
        return jsonRes(res,200,{answer,fromKB:false,casual:true,sources:[],images:[],videos:[],related:[]});
      }

      // Cache check
      const cacheKey = getCacheKey(q);
      if(cache.has(cacheKey)){
        const c = cache.get(cacheKey);
        trackQuery(q, true);
        console.log(`  [CACHE HIT] "${q}"`);
        return jsonRes(res,200,{
          answer:c.answer, fromKB:c.fromKB, sources:c.sources,
          images:c.images, videos:c.videos, related:c.related||[], fromCache:true
        });
      }

      // KB search
      const [results, ytResults] = await Promise.all([
        Promise.resolve(search.search(q, 6)),
        Promise.resolve(search.yt ? search.yt.search(q,3) : []),
      ]);
      const fromKB  = results.length > 0;
      const images  = fromKB ? filterRelevantImages(results, q, 3) : [];
      const videos  = buildVideos(fromKB ? results : [], ytResults, q);
      const sources = results.map(r=>({title:r.title,url:r.url,score:r.score,space:r.spaceKey}));
      const system  = buildKBPrompt(results, q, ytResults, langInstruction);

      // Get answer from Claude
      const answer = await callClaude(system,[...histMsgs,{role:'user',content:q}],4096);

      // Return answer IMMEDIATELY — don't wait for related questions
      cache.set(cacheKey,{answer,fromKB,sources,images,videos,related:[],ts:Date.now()});
      jsonRes(res,200,{answer,fromKB,sources,images,videos,related:[],fromCache:false});

      // Generate related questions in background AFTER response is sent
      callClaude(
        'You are a helpful Ginesys ERP assistant.',
        [{role:'user',content:buildRelatedPrompt(q,answer)}], 200
      ).then(relRaw => {
        try {
          const related = JSON.parse(relRaw.replace(/```json|```/g,'').trim());
          if(Array.isArray(related) && related.length > 0) {
            // Update cache with related questions for next time
            const cached = cache.get(cacheKey);
            if(cached) { cached.related = related; }
          }
        } catch{}
        setImmediate(()=>{ try{saveCache();}catch{} });
      }).catch(()=>{});

      return;
    }catch(e){
      console.error('Ask error:', e.message);
      return jsonRes(res,500,{error:e.message});
    }
  }

  // ── GET /api/proxy-media ─────────────────────────────────────────────────────
  if(pn==='/api/proxy-media'&&req.method==='GET'){
    const mediaUrl=parsed.query.url;
    if(!mediaUrl){res.writeHead(400);return res.end('Missing url');}
    let hostname;
    try{hostname=new URL(mediaUrl).hostname;}catch{res.writeHead(400);return res.end('Bad URL');}
    if(!['ginesysone.atlassian.net','www.ginesys.in','ginesys.in'].includes(hostname)){res.writeHead(403);return res.end('Not allowed');}
    try{
      const authH=(ATLASSIAN_EMAIL&&ATLASSIAN_API_TOKEN)?{'Authorization':`Basic ${Buffer.from(`${ATLASSIAN_EMAIL}:${ATLASSIAN_API_TOKEN}`).toString('base64')}`}:{};
      const result=await fetchUrl(mediaUrl,authH);
      const ext=mediaUrl.split('.').pop().split('?')[0].toLowerCase();
      const mimes={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',svg:'image/svg+xml',webp:'image/webp',mp4:'video/mp4',mov:'video/quicktime',webm:'video/webm',pdf:'application/pdf'};
      res.writeHead(200,{'Content-Type':result.headers['content-type']||mimes[ext]||'application/octet-stream','Cache-Control':'public,max-age=86400'});
      res.end(result.body);
    }catch(e){res.writeHead(502);res.end('Proxy error');}
    return;
  }

  // ── Static files ─────────────────────────────────────────────────────────────
  if(req.method==='GET'){
    const rel=pn==='/'?'index.html':pn.replace(/^\//,'').replace(/\.\./g,'');
    const fp=path.join(PUBLIC_DIR,rel);
    if(fs.existsSync(fp)&&fs.statSync(fp).isFile())return serveStatic(res,fp);
    // Admin dashboard
    if(pn==='/admin')return serveStatic(res,path.join(PUBLIC_DIR,'admin.html'));
    return serveStatic(res,path.join(PUBLIC_DIR,'index.html'));
  }

  res.writeHead(404); res.end('Not found');
});

let currentPort = Number(PORT);
server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    currentPort++;
    console.error(`\n⚠️  Port ${currentPort-1} busy — trying port ${currentPort}...`);
    setTimeout(() => server.listen(currentPort), 300);
  } else {
    console.error('Server error:', err.message);
    process.exit(1);
  }
});

server.listen(currentPort,()=>{
  const s=search.getStats(), yt=search.yt?search.yt.getStats():{loaded:false,totalVideos:0};
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  Ginesys AI Assistant  v10.0                     ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  http://localhost:${currentPort}                            ║`);
  console.log(`║  Admin: http://localhost:${currentPort}/admin               ║`);
  console.log(`║  KB:    ${String((s.totalPages||0)+' pages').padEnd(41)}║`);
  console.log(`║  Cache: ${String(cache.size+' entries loaded').padEnd(41)}║`);
  console.log(`║  YT:    ${(yt.loaded?yt.totalVideos+' videos':'not indexed — run crawl-youtube.js').padEnd(41)}║`);
  console.log(`║  AI:    ${(ANTHROPIC_API_KEY?'✅ Claude ready':'❌ missing API key').padEnd(41)}║`);
  console.log('╚══════════════════════════════════════════════════╝\n');
});
module.exports=server;
