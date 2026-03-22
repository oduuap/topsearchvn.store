const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const Database = require('better-sqlite3');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;
const SERPAPI_KEY = process.env.SERPAPI_KEY;

// ─── DB SETUP ────────────────────────────────────────────────────────────────
const dbPath = path.join(__dirname, 'history.db');
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS searches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT NOT NULL,
    location TEXT NOT NULL,
    source TEXT NOT NULL,
    num INTEGER DEFAULT 20,
    results_json TEXT,
    crawl_json TEXT,
    total_results INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_keyword ON searches(keyword);
  CREATE INDEX IF NOT EXISTS idx_created ON searches(created_at);
`);

const insertSearch = db.prepare(`
  INSERT INTO searches (keyword, location, source, num, results_json, crawl_json, total_results)
  VALUES (@keyword, @location, @source, @num, @results_json, @crawl_json, @total_results)
`);
const getHistory = db.prepare(`
  SELECT id, keyword, location, source, num, total_results, created_at
  FROM searches ORDER BY created_at DESC LIMIT ?
`);
const getSearchById = db.prepare(`SELECT * FROM searches WHERE id = ?`);
const deleteSearch = db.prepare(`DELETE FROM searches WHERE id = ?`);
const clearHistory = db.prepare(`DELETE FROM searches`);

// ─── LOCATIONS ────────────────────────────────────────────────────────────────
const LOCATIONS = {
  'vietnam':    { label: 'Cả nước 🇻🇳',      serpapi: 'Vietnam',                          gl: 'vn' },
  'hcm':        { label: 'TP. Hồ Chí Minh',   serpapi: 'Ho Chi Minh City, Vietnam',        gl: 'vn' },
  'hanoi':      { label: 'Hà Nội',             serpapi: 'Hanoi, Vietnam',                   gl: 'vn' },
  'danang':     { label: 'Đà Nẵng',            serpapi: 'Da Nang, Vietnam',                 gl: 'vn' },
  'cantho':     { label: 'Cần Thơ',            serpapi: 'Can Tho, Vietnam',                 gl: 'vn' },
  'haiphong':   { label: 'Hải Phòng',          serpapi: 'Hai Phong, Vietnam',               gl: 'vn' },
};

// ─── CACHE ───────────────────────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

// ─── PUPPETEER CHROME PATH ───────────────────────────────────────────────────
function findChrome() {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ─── CHROME DEBUG PORT ────────────────────────────────────────────────────────
// Giữ kết nối tới Chrome thật (launched với --remote-debugging-port=9222)
let _debugBrowser = null;

async function getDebugBrowser() {
  const puppeteer = require('puppeteer-core');
  // Kiểm tra có thể kết nối không
  try {
    const res = await axios.get('http://localhost:9222/json/version', { timeout: 1000 });
    if (!_debugBrowser) {
      _debugBrowser = await puppeteer.connect({ browserURL: 'http://localhost:9222', defaultViewport: null });
    }
    return { browser: _debugBrowser, isDebug: true };
  } catch {
    return { browser: null, isDebug: false };
  }
}

// POST /api/launch-chrome — mở Chrome debug mode, giữ sống bằng about:blank
app.post('/api/launch-chrome', (req, res) => {
  const chromePath = findChrome();
  if (!chromePath) return res.status(500).json({ error: 'Không tìm thấy Chrome' });

  const { spawn } = require('child_process');

  // Kill Chrome cũ trên port 9222 nếu có
  require('child_process').exec('pkill -f "remote-debugging-port=9222"');

  setTimeout(() => {
    const args = [
      '--remote-debugging-port=9222',
      '--user-data-dir=/tmp/chrome-searchtop-v2',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--disable-infobars',
      '--disable-extensions',
      '--lang=vi-VN',
      '--window-size=500,800',
      '--window-position=0,0',
      'about:blank',   // <-- giữ Chrome sống với cửa sổ thật
    ];
    const proc = spawn(chromePath, args, { detached: true, stdio: 'ignore' });
    proc.unref();
    _debugBrowser = null; // reset connection cache
  }, 500);

  res.json({ ok: true, message: 'Chrome đang khởi động...' });
});

// GET /api/chrome-status
app.get('/api/chrome-status', async (req, res) => {
  try {
    await axios.get('http://localhost:9222/json/version', { timeout: 1000 });
    res.json({ connected: true });
  } catch {
    res.json({ connected: false });
  }
});

// ─── UULE ENCODER — mã hoá location như Google Search dùng nội bộ ────────────
function encodeUule(locationName) {
  const buf = Buffer.from(locationName, 'utf8');
  const lenBuf = Buffer.alloc(1);
  lenBuf[0] = buf.length;
  return 'w+CAIQICI' + Buffer.concat([lenBuf, buf]).toString('base64');
}

// ─── CRAWL GOOGLE DIRECTLY ────────────────────────────────────────────────────
async function crawlGoogle(keyword, locationKey = 'hcm', num = 20, coords = null) {
  const SCRAPER_KEY = process.env.SCRAPER_API_KEY;

  // ── ScraperAPI raw mobile mode (VPS) ────────────────────────────────────
  if (SCRAPER_KEY) {
    const wantNum = parseInt(num);

    // Dùng ScraperAPI structured endpoint — ổn định, hỗ trợ mobile
    const baseParams = {
      api_key: SCRAPER_KEY,
      query: keyword,
      country_code: 'vn',
      hl: 'vi',
      num: 10,
    };

    const mapOrg = (r, offset = 0) => ({
      position: offset + (r.position || 0),
      type: 'organic',
      title: r.title || '',
      link: r.link || '',
      displayed_link: r.displayed_link || r.link || '',
      snippet: r.snippet || r.description || '',
      source: 'crawl',
    });

    // Page 1
    const res1 = await axios.get('https://api.scraperapi.com/structured/google/search', {
      params: baseParams, timeout: 60000,
    });
    const d1 = res1.data;
    let organic_results = (d1.organic_results || []).map(r => mapOrg(r));
    const rawAds = d1.ads || d1.top_ads || d1.paid_results || [];
    const ads = rawAds.map((a, i) => ({
      position: i + 1, type: 'ad',
      title: a.title || '', link: a.link || a.url || '',
      displayed_link: a.displayed_link || a.link || '',
      snippet: a.snippet || a.description || '',
      source: 'crawl',
    }));

    // Page 2 nếu cần top 20
    if (wantNum >= 20 && organic_results.length > 0) {
      try {
        const res2 = await axios.get('https://api.scraperapi.com/structured/google/search', {
          params: { ...baseParams, page: 2 }, timeout: 45000,
        });
        const existingLinks = new Set(organic_results.map(r => r.link));
        const page2 = (res2.data.organic_results || [])
          .filter(r => !existingLinks.has(r.link))
          .map(r => mapOrg(r, organic_results.length));
        organic_results = [...organic_results, ...page2];
      } catch (e2) {
        console.log('Page 2 skip:', e2.message);
      }
    }

    organic_results = organic_results.map((r, i) => ({ ...r, position: i + 1 }));
    return { ads, organic_results, source: 'crawl', mode: 'scraperapi-mobile' };
  }

  // ── Puppeteer mode (local, có Chrome) ────────────────────────────────────
  const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.144 Mobile Safari/537.36';
  const puppeteer = require('puppeteer-core');

  // Ưu tiên 1: kết nối Chrome thật qua debug port (không bị CAPTCHA)
  const { browser: debugBrowser, isDebug } = await getDebugBrowser();

  let browser, page, ownBrowser = false;

  if (isDebug && debugBrowser) {
    browser = debugBrowser;
    page = await browser.newPage();
  } else {
    // Fallback: launch Chrome ẩn với stealth
    const chromePath = findChrome();
    if (!chromePath) throw new Error('VPS chưa cài Chromium. Chạy: sudo apt install -y chromium-browser');

    const puppeteerExtra = require('puppeteer-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteerExtra.use(StealthPlugin());

    browser = await puppeteerExtra.launch({
      executablePath: chromePath,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--lang=vi-VN,vi',
        '--proxy-server=socks5://127.0.0.1:9050', // Tor proxy
      ],
    });
    ownBrowser = true;
    page = await browser.newPage();

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      window.chrome = { runtime: {} };
    });
  }

  try {
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    await page.setUserAgent(MOBILE_UA);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8' });
    await page.setCookie({ name: 'PREF', value: 'hl=vi&gl=vn', domain: '.google.com.vn' });

    // Hàm extract kết quả từ trang hiện tại
    const extractPage = () => page.evaluate(() => {
      const results = [], adList = [], seen = new Set();
      for (const a of document.querySelectorAll('#rso a[ping], #rso a[data-ved]')) {
        const href = a.href || '';
        if (!href.startsWith('http') || seen.has(href)) continue;
        if (href.includes('google.com') || href.includes('googleusercontent') || href.includes('googleapis')) continue;
        seen.add(href);

        const heading = a.querySelector('div[role="heading"], h1, h2, h3');
        let title = heading ? heading.innerText.trim() : '';
        if (!title) {
          const lines = a.innerText.split('\n').map(l => l.trim()).filter(l => l.length > 8);
          title = lines.sort((a, b) => b.length - a.length)[0] || '';
        }
        if (!title) continue;

        let snippet = '';
        let node = a.parentElement;
        for (let i = 0; i < 6 && node; i++, node = node.parentElement) {
          const spans = Array.from(node.querySelectorAll('span, div[data-snf]'))
            .map(el => el.innerText?.trim() || '')
            .filter(t => t.length > 40 && !title.includes(t.substring(0, 20)));
          if (spans.length) { snippet = spans[0]; break; }
        }

        let displayedLink = '';
        let pNode = a.parentElement;
        for (let i = 0; i < 6 && pNode; i++, pNode = pNode.parentElement) {
          const cite = pNode.querySelector('cite');
          if (cite) { displayedLink = cite.innerText.trim(); break; }
        }
        if (!displayedLink) { try { displayedLink = new URL(href).hostname; } catch {} }

        const isAd = !!a.closest('[data-text-ad]') || a.href.includes('googleadservices') || a.href.includes('/aclk');
        if (isAd) {
          adList.push({ position: adList.length + 1, type: 'ad', title, link: href, displayed_link: displayedLink, snippet, source: 'crawl' });
        } else {
          results.push({ position: results.length + 1, type: 'organic', title, link: href, displayed_link: displayedLink, snippet, source: 'crawl' });
        }
      }
      return { organic_results: results, ads: adList };
    });

    // Trang 1
    const page1Url = `https://www.google.com.vn/search?q=${encodeURIComponent(keyword)}&gl=vn&hl=vi&pws=0&nfpr=1`;
    await page.goto(page1Url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForFunction(
      () => document.querySelector('#rso a[ping], #rso a[data-ved], #captcha-form') !== null,
      { timeout: 12000 }
    ).catch(() => {});

    const isCaptcha = await page.evaluate(() => !!document.querySelector('#captcha-form, #recaptcha'));
    if (isCaptcha) {
      throw new Error(isDebug
        ? 'CAPTCHA ngay cả với Chrome thật — Google đang chặn IP, thử lại sau'
        : 'CAPTCHA: Google chặn headless Chrome. Nhấn "Khởi động Chrome" để dùng Chrome thật.'
      );
    }

    const page1 = await extractPage();
    let organic_results = page1.organic_results;
    let ads = page1.ads;

    // Trang 2 nếu cần 20 kết quả
    if (num >= 20 && organic_results.length >= 8) {
      const page2Url = `https://www.google.com.vn/search?q=${encodeURIComponent(keyword)}&gl=vn&hl=vi&pws=0&nfpr=1&start=10`;
      await page.goto(page2Url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForFunction(
        () => document.querySelector('#rso a[ping], #rso a[data-ved]') !== null,
        { timeout: 10000 }
      ).catch(() => {});

      const page2 = await extractPage();
      // Gộp, bỏ trùng URL
      const existingLinks = new Set(organic_results.map(r => r.link));
      const newOrg = page2.organic_results
        .filter(r => !existingLinks.has(r.link))
        .map((r, i) => ({ ...r, position: organic_results.length + i + 1 }));
      organic_results = [...organic_results, ...newOrg];
    }

    return { ads, organic_results, source: 'crawl', mode: isDebug ? 'chrome-debug' : 'headless' };
  } finally {
    await page.close();
    if (ownBrowser) await browser.close();
  }
}

// ─── GEOCODE từ tọa độ GPS ────────────────────────────────────────────────────
async function geocodeCoords(lat, lon) {
  try {
    const res = await axios.get(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=10&accept-language=vi`,
      { headers: { 'User-Agent': 'SearchTop/2.0' }, timeout: 5000 }
    );
    const addr = res.data.address || {};
    const city    = addr.city || addr.town || addr.county || addr.state || '';
    const state   = addr.state || '';
    const country = addr.country || '';
    const cc      = (addr.country_code || '').toLowerCase();

    if (cc === 'vn') {
      const cityMap = {
        'ho chi minh': 'hcm', 'hồ chí minh': 'hcm',
        'ha noi': 'hanoi', 'hà nội': 'hanoi',
        'da nang': 'danang', 'đà nẵng': 'danang',
        'can tho': 'cantho', 'cần thơ': 'cantho',
        'hai phong': 'haiphong', 'hải phòng': 'haiphong',
      };
      const norm = (city || state).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      for (const [k, v] of Object.entries(cityMap)) {
        const nk = k.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        if (norm.includes(nk)) return { key: v, label: city || state, raw: LOCATIONS[v].serpapi };
      }
      return { key: null, label: city || state, raw: city ? `${city}, Vietnam` : 'Vietnam' };
    }

    return { key: null, label: city || country, raw: city ? `${city}, ${country}` : country };
  } catch {
    return { key: 'vietnam', label: 'Việt Nam', raw: 'Vietnam' };
  }
}

// ─── SERPAPI ─────────────────────────────────────────────────────────────────
async function fetchSerpAPI(keyword, locationKey = 'hcm', num = 20) {
  // SerpAPI chỉ chấp nhận location string chuẩn trong DB của họ
  // → luôn dùng predefined key, fallback về 'Vietnam' nếu không tìm thấy
  const loc = LOCATIONS[locationKey];
  const serpLocation = loc ? loc.serpapi : 'Vietnam';
  const glCode = loc ? loc.gl : 'vn';
  const wantNum = parseInt(num);

  const baseParams = {
    q: keyword,
    gl: glCode,
    hl: 'vi',
    google_domain: 'google.com',
    device: 'mobile',
    location: serpLocation,
    num: 10,
    api_key: SERPAPI_KEY,
    no_cache: true,
  };

  const mapOrg = (r) => ({
    position: r.position,
    type: 'organic',
    title: r.title,
    link: r.link,
    displayed_link: r.displayed_link,
    snippet: r.snippet,
    date: r.date,
    source: 'serpapi',
  });

  // Trang 1
  const res1 = await axios.get('https://serpapi.com/search.json', { params: { ...baseParams, start: 0 }, timeout: 15000 });
  const d1 = res1.data;

  let organic_results = (d1.organic_results || []).map(mapOrg);
  const ads = (d1.ads || []).map((ad, i) => ({
    position: i + 1, type: 'ad',
    title: ad.title, link: ad.link,
    displayed_link: ad.displayed_link,
    snippet: ad.description, source: 'serpapi',
  }));

  // Trang 2 nếu cần 20
  if (wantNum >= 20 && organic_results.length >= 8) {
    try {
      const res2 = await axios.get('https://serpapi.com/search.json', {
        params: { ...baseParams, start: 10 },
        timeout: 15000,
      });
      const d2 = res2.data;
      const existingLinks = new Set(organic_results.map(r => r.link));
      const offset = organic_results.length;
      const page2 = (d2.organic_results || []).map(mapOrg)
        .filter(r => !existingLinks.has(r.link))
        .map((r, i) => ({ ...r, position: offset + i + 1 }));
      organic_results = [...organic_results, ...page2];
    } catch {}
  }

  return {
    ads,
    organic_results,
    knowledge_graph: d1.knowledge_graph || null,
    related_searches: (d1.related_searches || []).map(r => r.query),
    search_metadata: {
      total_results: d1.search_information?.total_results,
      time_taken: d1.search_metadata?.total_time_taken,
    },
    source: 'serpapi',
  };
}

// ─── MERGE & COMPARE ─────────────────────────────────────────────────────────
function mergeResults(serpData, crawlData) {
  // Kết hợp: dùng SerpAPI làm chính, bổ sung thông tin diff từ crawl
  const serpOrg = serpData.organic_results || [];
  const crawlOrg = crawlData?.organic_results || [];

  const crawlMap = new Map();
  crawlOrg.forEach(r => {
    try { crawlMap.set(new URL(r.link).hostname, r); } catch {}
  });

  const merged = serpOrg.map(r => {
    let crawlHost;
    try { crawlHost = new URL(r.link).hostname; } catch { crawlHost = ''; }

    const crawlMatch = crawlMap.get(crawlHost);
    return {
      ...r,
      crawl_position: crawlMatch?.position || null,
      position_diff: crawlMatch ? (r.position - crawlMatch.position) : null,
      in_crawl: !!crawlMatch,
    };
  });

  // Kết quả có trong crawl nhưng không có trong SerpAPI
  const serpLinks = new Set(serpOrg.map(r => { try { return new URL(r.link).hostname; } catch { return ''; } }));
  const crawlOnly = crawlOrg.filter(r => {
    try { return !serpLinks.has(new URL(r.link).hostname); } catch { return false; }
  }).map(r => ({ ...r, serpapi_position: null, in_serpapi: false }));

  return {
    organic_results: merged,
    crawl_only: crawlOnly,
    ads: serpData.ads || [],
    crawl_ads: crawlData?.ads || [],
    knowledge_graph: serpData.knowledge_graph,
    related_searches: serpData.related_searches || [],
    search_metadata: serpData.search_metadata,
  };
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── ROUTES ──────────────────────────────────────────────────────────────────

// GET /api/locations
app.get('/api/locations', (req, res) => {
  res.json(Object.entries(LOCATIONS).map(([key, val]) => ({ key, label: val.label })));
});

// GET /api/geocode?lat=16.05&lon=108.2 — tọa độ GPS → location cho SerpAPI
app.get('/api/geocode', async (req, res) => {
  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: 'Thiếu lat/lon' });
  const result = await geocodeCoords(parseFloat(lat), parseFloat(lon));
  res.json(result);
});

// GET /api/detect-location — detect VN city từ IP
app.get('/api/detect-location', async (req, res) => {
  try {
    // Lấy IP thật (qua proxy/nginx thì dùng x-forwarded-for)
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
      || req.socket.remoteAddress
      || '';

    // Bỏ qua localhost / private IP
    const isLocal = !ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168') || ip.startsWith('10.') || ip.startsWith('::ffff:127');

    let city = null, detected_ip = ip;

    if (!isLocal) {
      const geoRes = await axios.get(`http://ip-api.com/json/${ip}?fields=status,city,regionName,country&lang=vi`, { timeout: 4000 });
      if (geoRes.data.status === 'success') city = geoRes.data.city;
    }

    // Map tên thành phố → key
    const cityMap = {
      'hồ chí minh': 'hcm', 'ho chi minh': 'hcm', 'hcm': 'hcm', 'saigon': 'hcm',
      'hà nội': 'hanoi', 'ha noi': 'hanoi', 'hanoi': 'hanoi',
      'đà nẵng': 'danang', 'da nang': 'danang', 'danang': 'danang',
      'cần thơ': 'cantho', 'can tho': 'cantho',
      'hải phòng': 'haiphong', 'hai phong': 'haiphong',
    };

    const normalized = (city || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    let locationKey = 'hcm'; // default
    for (const [k, v] of Object.entries(cityMap)) {
      const normKey = k.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (normalized.includes(normKey) || normKey.includes(normalized)) {
        locationKey = v; break;
      }
    }

    res.json({
      location_key: locationKey,
      city: city || (isLocal ? 'localhost' : 'Không xác định'),
      ip: isLocal ? 'local' : ip,
      is_local: isLocal,
      label: LOCATIONS[locationKey]?.label,
    });
  } catch (e) {
    res.json({ location_key: 'hcm', city: 'Mặc định (HCM)', is_local: true, label: LOCATIONS['hcm']?.label });
  }
});

// GET /api/search?q=...&location=hcm&source=both&num=20
app.get('/api/search', async (req, res) => {
  const { q, location = 'hcm', source = 'both', num = 20 } = req.query;
  if (!q) return res.status(400).json({ error: 'Thiếu từ khóa' });

  const cacheKey = `${q}:${location}:${source}:${num}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return res.json({ ...cached.data, cached: true });
  }

  try {
    let serpData = null, crawlData = null;
    const errors = {};

    if (source === 'serpapi' || source === 'both') {
      try { serpData = await fetchSerpAPI(q, location, num); }
      catch (e) { errors.serpapi = e.message; console.error('SerpAPI err:', e.message); }
    }

    if (source === 'crawl' || source === 'both') {
      try { crawlData = await crawlGoogle(q, location, num); }
      catch (e) { errors.crawl = e.message; console.error('Crawl err:', e.message); }
    }

    if (!serpData && !crawlData) {
      return res.status(500).json({ error: 'Cả hai nguồn đều thất bại', details: errors });
    }

    let result;
    if (source === 'both' && serpData && crawlData) {
      result = {
        query: q, location, source: 'both',
        timestamp: new Date().toISOString(),
        ...mergeResults(serpData, crawlData),
        crawl_raw: { ads: crawlData.ads, organic_results: crawlData.organic_results },
        errors: Object.keys(errors).length > 0 ? errors : undefined,
      };
    } else if (serpData) {
      result = { query: q, location, source: 'serpapi', timestamp: new Date().toISOString(), ...serpData, errors: Object.keys(errors).length > 0 ? errors : undefined };
    } else {
      result = { query: q, location, source: 'crawl', timestamp: new Date().toISOString(), ...crawlData, errors: Object.keys(errors).length > 0 ? errors : undefined };
    }

    // Lưu lịch sử
    try {
      insertSearch.run({
        keyword: q,
        location,
        source,
        num: parseInt(num),
        results_json: JSON.stringify(result.organic_results || []),
        crawl_json: JSON.stringify(crawlData?.organic_results || []),
        total_results: (result.organic_results?.length || 0) + (result.ads?.length || 0),
      });
    } catch (e) { console.error('DB insert err:', e.message); }

    cache.set(cacheKey, { data: result, time: Date.now() });
    res.json(result);

  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/history?limit=50
app.get('/api/history', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || 50), 200);
  try {
    const rows = getHistory.all(limit);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/history/:id — lấy full kết quả
app.get('/api/history/:id', (req, res) => {
  const row = getSearchById.get(parseInt(req.params.id));
  if (!row) return res.status(404).json({ error: 'Không tìm thấy' });
  try {
    row.results_json = JSON.parse(row.results_json || '[]');
    row.crawl_json = JSON.parse(row.crawl_json || '[]');
  } catch {}
  res.json(row);
});

// DELETE /api/history/:id
app.delete('/api/history/:id', (req, res) => {
  deleteSearch.run(parseInt(req.params.id));
  res.json({ ok: true });
});

// DELETE /api/history
app.delete('/api/history', (req, res) => {
  clearHistory.run();
  cache.clear();
  res.json({ ok: true });
});

// POST /api/batch
app.post('/api/batch', async (req, res) => {
  const { keywords, location = 'hcm', source = 'serpapi', num = 20 } = req.body;
  if (!keywords || !Array.isArray(keywords) || keywords.length === 0)
    return res.status(400).json({ error: 'Cần cung cấp mảng keywords' });

  const results = [];
  for (const kw of keywords.slice(0, 10)) {
    try {
      let serpData = null, crawlData = null;
      if (source === 'serpapi' || source === 'both') {
        serpData = await fetchSerpAPI(kw, location, num).catch(e => null);
      }
      if (source === 'crawl' || source === 'both') {
        crawlData = await crawlGoogle(kw, location, num).catch(e => null);
      }

      const data = source === 'both' && serpData && crawlData
        ? { query: kw, source: 'both', timestamp: new Date().toISOString(), ...mergeResults(serpData, crawlData) }
        : serpData
          ? { query: kw, source: 'serpapi', timestamp: new Date().toISOString(), ...serpData }
          : { query: kw, source: 'crawl', timestamp: new Date().toISOString(), ...crawlData };

      try {
        insertSearch.run({
          keyword: kw, location, source, num: parseInt(num),
          results_json: JSON.stringify(data.organic_results || []),
          crawl_json: JSON.stringify(crawlData?.organic_results || []),
          total_results: (data.organic_results?.length || 0) + (data.ads?.length || 0),
        });
      } catch {}

      results.push(data);
      await new Promise(r => setTimeout(r, 600));
    } catch (e) {
      results.push({ query: kw, error: e.message });
    }
  }
  res.json({ results });
});

app.listen(PORT, () => {
  console.log(`✅ SearchTop v2 running at http://localhost:${PORT}`);
  console.log(`   Chrome path: ${findChrome() || '❌ Không tìm thấy Chrome'}`);
  console.log(`   DB: ${dbPath}`);
});
