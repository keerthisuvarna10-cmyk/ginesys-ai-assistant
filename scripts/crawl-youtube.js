/**
 * scripts/crawl-youtube.js — Ginesys YouTube Channel Crawler
 *
 * Fetches ALL videos from https://www.youtube.com/@Ginesysone
 * Stores titles, descriptions, and tags in data/yt-index.json
 * This file is then used by search.js alongside the KB index.
 *
 * Prerequisites:
 *   1. Get a FREE YouTube Data API v3 key from:
 *      https://console.cloud.google.com/apis/library/youtube.googleapis.com
 *      (Free tier: 10,000 units/day — more than enough)
 *   2. Add to your .env:  YOUTUBE_API_KEY=YOUR_KEY_HERE
 *
 * Run: node scripts/crawl-youtube.js
 */

require('dotenv').config();
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const {
  YOUTUBE_API_KEY,
  YOUTUBE_CHANNEL_HANDLE = '@Ginesysone',
} = process.env;

const DATA_DIR  = path.join(__dirname, '..', 'data');
const YT_FILE   = path.join(DATA_DIR, 'yt-index.json');

if (!YOUTUBE_API_KEY) {
  console.error('\n❌  YOUTUBE_API_KEY not set in .env');
  console.error('\n   How to get a FREE key (5 minutes):');
  console.error('   1. Go to: https://console.cloud.google.com/');
  console.error('   2. Create a project → Enable "YouTube Data API v3"');
  console.error('   3. Go to Credentials → Create API Key');
  console.error('   4. Add to .env:  YOUTUBE_API_KEY=YOUR_KEY_HERE');
  console.error('   5. Run:  node scripts/crawl-youtube.js\n');
  process.exit(1);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function apiGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 15000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(new Error(`Parse error: ${d.slice(0,200)}`)); }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('Timeout')));
  });
}

// ── Step 1: Get channel ID from handle ───────────────────────────────────────
async function getChannelId() {
  console.log(`  Looking up channel: ${YOUTUBE_CHANNEL_HANDLE}...`);
  // Search by handle
  const r = await apiGet(
    `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(YOUTUBE_CHANNEL_HANDLE)}&type=channel&key=${YOUTUBE_API_KEY}`
  );
  if (r.error) throw new Error(`YouTube API: ${r.error.message}`);
  const channel = (r.items||[])[0];
  if (!channel) throw new Error('Channel not found — check YOUTUBE_CHANNEL_HANDLE in .env');
  console.log(`  Found: "${channel.snippet.title}" (${channel.id.channelId})`);
  return channel.id.channelId;
}

// ── Step 2: Get uploads playlist ID ──────────────────────────────────────────
async function getUploadsPlaylistId(channelId) {
  const r = await apiGet(
    `https://www.googleapis.com/youtube/v3/channels?part=contentDetails,statistics&id=${channelId}&key=${YOUTUBE_API_KEY}`
  );
  if (r.error) throw new Error(`YouTube API: ${r.error.message}`);
  const ch = (r.items||[])[0];
  if (!ch) throw new Error('Could not get channel details');
  const playlistId = ch.contentDetails?.relatedPlaylists?.uploads;
  const videoCount = ch.statistics?.videoCount;
  console.log(`  Total videos on channel: ${videoCount}`);
  return playlistId;
}

// ── Step 3: Get ALL video IDs from playlist ───────────────────────────────────
async function getAllVideoIds(playlistId) {
  const ids = [];
  let pageToken = '';
  let page = 1;
  do {
    const tokenParam = pageToken ? `&pageToken=${pageToken}` : '';
    const r = await apiGet(
      `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&playlistId=${playlistId}&maxResults=50${tokenParam}&key=${YOUTUBE_API_KEY}`
    );
    if (r.error) throw new Error(`YouTube API: ${r.error.message}`);
    for (const item of (r.items||[])) {
      const vidId = item.contentDetails?.videoId;
      if (vidId) ids.push(vidId);
    }
    pageToken = r.nextPageToken || '';
    process.stdout.write(`\r  Fetching video IDs: ${ids.length} found (page ${page++})`);
    if (pageToken) await sleep(200);
  } while (pageToken);
  console.log('');
  return ids;
}

// ── Step 4: Get full details for each video (in batches of 50) ───────────────
async function getVideoDetails(videoIds) {
  const videos = [];
  const BATCH  = 50;
  for (let i = 0; i < videoIds.length; i += BATCH) {
    const batch = videoIds.slice(i, i + BATCH);
    const r = await apiGet(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${batch.join(',')}&key=${YOUTUBE_API_KEY}`
    );
    if (r.error) throw new Error(`YouTube API: ${r.error.message}`);
    for (const v of (r.items||[])) {
      const s = v.snippet || {};
      // Clean and tokenize description + title for search
      const searchText = `${s.title||''} ${s.description||''} ${(s.tags||[]).join(' ')}`.toLowerCase();
      videos.push({
        id:          v.id,
        title:       s.title || '',
        description: (s.description||'').slice(0, 2000), // cap at 2000 chars
        thumbnail:   s.thumbnails?.high?.url || s.thumbnails?.medium?.url || s.thumbnails?.default?.url || '',
        publishedAt: s.publishedAt || '',
        tags:        s.tags || [],
        duration:    v.contentDetails?.duration || '',
        viewCount:   parseInt(v.statistics?.viewCount||0),
        url:         `https://www.youtube.com/watch?v=${v.id}`,
        embedUrl:    `https://www.youtube.com/embed/${v.id}`,
        searchText,
        // Tokenized for fast search
        tokens:      [...new Set(
          searchText.replace(/[^\w\s]/g,' ').split(/\s+/).filter(w=>w.length>2)
        )],
      });
    }
    process.stdout.write(`\r  Fetching video details: ${videos.length}/${videoIds.length}`);
    await sleep(100);
  }
  console.log('');
  return videos;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  Ginesys YouTube Channel Crawler                    ║');
  console.log(`║  Channel: ${YOUTUBE_CHANNEL_HANDLE.padEnd(42)}║`);
  console.log('╚══════════════════════════════════════════════════════╝\n');

  const t0 = Date.now();

  const channelId    = await getChannelId();
  const playlistId   = await getUploadsPlaylistId(channelId);
  const videoIds     = await getAllVideoIds(playlistId);
  const videos       = await getVideoDetails(videoIds);

  const secs = ((Date.now()-t0)/1000).toFixed(0);

  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log(`║  Videos fetched: ${String(videos.length).padEnd(34)}║`);
  console.log(`║  Time:           ${(secs+'s').padEnd(34)}║`);
  console.log('╚══════════════════════════════════════════════════════╝');

  // Save
  const index = {
    crawledAt:  new Date().toISOString(),
    channelId,
    channelHandle: YOUTUBE_CHANNEL_HANDLE,
    totalVideos: videos.length,
    videos,
  };
  fs.writeFileSync(YT_FILE, JSON.stringify(index));
  const mb = (fs.statSync(YT_FILE).size/1024/1024).toFixed(1);
  console.log(`\n  ✅ Saved: data/yt-index.json  (${mb} MB)`);
  console.log('  ▶ Restart server: npm start\n');
}

main().catch(e => {
  console.error('\n❌ Error:', e.message);
  if (e.message.includes('quotaExceeded')) {
    console.error('  YouTube API quota exceeded — wait 24hrs or use a different API key');
  }
  process.exit(1);
});
