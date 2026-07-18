const express = require('express');
const fs = require('fs');
const path = require('path');
const natsClient = require('./natsClient');

const PORT = process.env.PORT || 4000;
const DEFAULT_REGION = process.env.REGION || 'west'; // west = Americas, europe = Europe, east = Asia
const USE_NATS = process.env.USE_NATS !== 'false'; // set USE_NATS=false to disable the live feed entirely
const DATA_DIR = process.env.DATA_DIR || '/data';
const CATALOG_FILE = path.join(DATA_DIR, 'catalog_v2.json');
const ITEMS_URL = 'https://raw.githubusercontent.com/ao-data/ao-bin-dumps/master/formatted/items.json';

const REGIONS = ['west', 'europe', 'east'];
const CITIES = ['Caerleon', 'Bridgewatch', 'Fort Sterling', 'Lymhurst', 'Martlock', 'Thetford', 'Brecilien'];

const EXCLUDE_RE = [
  /^DEBUG_/, /^GVGSEASONREWARD/, /^HELLGATE_/, /^QUESTITEM/, /^UNIQUE_/, /^LABOURER/, /^HIDEOUT/, /^ROAD_/,
  /_TOKEN(_|$)/, /PROTOTYPE/, /ARENA_BANNER/, /_BP$/
];

const CATEGORY_KEYS = ['resources', 'food', 'weapons', 'armor', 'artifacts', 'bagcape', 'journals', 'furniture', 'other'];

const CAT_RULES = [
  [/^ARTEFACT_/, 'artifacts'],
  [/^(MAIN_|2H_|OFF_)/, 'weapons'],
  [/^(HEAD_|ARMOR_|SHOES_)/, 'armor'],
  [/^(BAG|CAPE)/, 'bagcape'],
  [/^(WOOD|ORE|FIBER|HIDE|ROCK|PLANKS|METALBAR|CLOTH|LEATHER|STONEBLOCK)$/, 'resources'],
  [/^POTION_/, 'food'],
  [/^MEAL_/, 'food'],
  [/^FISH_/, 'food'],
  [/^JOURNAL_/, 'journals'],
  [/^FURNITUREITEM_/, 'furniture']
  // anything else (farm mounts, seeds, fish byproducts like sauce/chops/bait,
  // and any other leftover category) falls through to 'other'
];

function categorize(base) {
  for (const [re, cat] of CAT_RULES) if (re.test(base)) return cat;
  return 'other';
}

let CATALOG = [];
let catalogReady = false;
let catalogLoadedAt = null;

async function fetchAndBuildCatalog() {
  const res = await fetch(ITEMS_URL);
  if (!res.ok) throw new Error('Failed to fetch items.json: ' + res.status);
  const raw = await res.json();
  const catalog = [];
  raw.forEach((entry) => {
    const un = entry.UniqueName || '';
    const m = un.match(/^T([1-8])_(.+?)(@([1-4]))?$/);
    if (!m) return;
    const base = m[2];
    for (const re of EXCLUDE_RE) if (re.test(base)) return;
    const names = entry.LocalizedNames || {};
    catalog.push({
      id: un,
      tier: parseInt(m[1], 10),
      ench: m[4] ? parseInt(m[4], 10) : 0,
      cat: categorize(base),
      en: names['EN-US'] || un,
      pt: names['PT-BR'] || names['EN-US'] || un
    });
  });
  return catalog;
}

async function loadCatalog() {
  try {
    const fresh = await fetchAndBuildCatalog();
    CATALOG = fresh;
    catalogReady = true;
    catalogLoadedAt = new Date();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CATALOG_FILE, JSON.stringify(fresh));
    console.log('Fetched fresh catalog on startup (' + fresh.length + ' items)');
    return;
  } catch (e) {
    console.warn('Could not fetch fresh catalog on startup (' + e.message + '), falling back to disk cache if any');
  }

  try {
    if (fs.existsSync(CATALOG_FILE)) {
      const cached = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
      CATALOG = cached;
      catalogReady = true;
      catalogLoadedAt = fs.statSync(CATALOG_FILE).mtime;
      console.log('Using cached catalog as fallback (' + cached.length + ' items)');
    } else {
      console.error('No catalog available: fresh fetch failed and there is no disk cache yet.');
    }
  } catch (e) {
    console.error('Could not read catalog cache fallback:', e.message);
  }
}

async function fetchPricesInBatches(ids, qualities, region) {
  const batchSize = 80;
  const batches = [];
  for (let i = 0; i < ids.length; i += batchSize) batches.push(ids.slice(i, i + batchSize));

  const results = [];
  const concurrency = 8;
  let index = 0;

  async function worker() {
    while (index < batches.length) {
      const my = index++;
      const batch = batches[my];
      const url = 'https://' + region + '.albion-online-data.com/api/v2/stats/prices/' +
        batch.join(',') + '.json?locations=' + encodeURIComponent(CITIES.join(',')) + '&qualities=' + qualities.join(',');
      try {
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          results.push(...data);
        }
      } catch (e) {
        console.warn('Batch fetch failed:', e.message);
      }
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, batches.length); i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

function buildItemList(categories, includeEnchanted) {
  const allCats = categories.length === 0;
  return CATALOG.filter((it) => {
    if (!allCats && !categories.includes(it.cat)) return false;
    if (!includeEnchanted && it.ench > 0) return false;
    return true;
  });
}

// categories query param: "ALL" or a comma-separated list of category keys.
function parseCategories(req) {
  const raw = String(req.query.categories || 'ALL');
  if (raw === 'ALL') return [];
  const requested = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const invalid = requested.filter((c) => !CATEGORY_KEYS.includes(c));
  if (invalid.length) return { error: invalid };
  return requested;
}

function parseRegion(req) {
  const r = String(req.query.region || DEFAULT_REGION);
  return REGIONS.includes(r) ? r : DEFAULT_REGION;
}

// sellCities query param: "ALL" or a comma-separated list of city names.
// Returns the resolved list of destination cities (buyCity excluded).
function parseSellCities(req, buyCity) {
  const raw = String(req.query.sellCities || 'ALL');
  if (raw === 'ALL') return CITIES.filter((c) => c !== buyCity);
  const requested = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const invalid = requested.filter((c) => !CITIES.includes(c));
  if (invalid.length) return { error: invalid };
  return requested.filter((c) => c !== buyCity);
}

function fmtDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

async function fetchHistoryInBatches(ids, region, days) {
  const batchSize = 60;
  const batches = [];
  for (let i = 0; i < ids.length; i += batchSize) batches.push(ids.slice(i, i + batchSize));

  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);

  const results = [];
  const concurrency = 8;
  let index = 0;

  async function worker() {
    while (index < batches.length) {
      const my = index++;
      const batch = batches[my];
      const url = 'https://' + region + '.albion-online-data.com/api/v2/stats/history/' +
        batch.join(',') + '.json?locations=' + encodeURIComponent(CITIES.join(',')) +
        '&qualities=1&time-scale=24&date=' + fmtDate(start) + '&end_date=' + fmtDate(end);
      try {
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          results.push(...data);
        }
      } catch (e) {
        console.warn('History batch fetch failed:', e.message);
      }
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, batches.length); i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

// Attaches a `volume24h: { qty, avgPrice } | null` field to each opportunity,
// based on sales in its destination city over the last 24h. Only called for
// the (already sorted + capped) list that will actually be returned, to
// avoid an unbounded number of extra API calls.
async function attachVolume24h(opportunities, region) {
  const uniqueIds = [...new Set(opportunities.map((o) => o.id))];
  if (uniqueIds.length === 0) return opportunities;

  const history = await fetchHistoryInBatches(uniqueIds, region, 1);
  const byItemCity = {}; // itemId -> city -> { qty, weightedSum }
  history.forEach((row) => {
    if (!row.data || row.data.length === 0) return;
    let qty = 0;
    let weightedSum = 0;
    row.data.forEach((d) => {
      qty += d.item_count;
      weightedSum += d.avg_price * d.item_count;
    });
    if (qty === 0) return;
    if (!byItemCity[row.item_id]) byItemCity[row.item_id] = {};
    byItemCity[row.item_id][row.location] = { qty, avgPrice: Math.round(weightedSum / qty) };
  });

  opportunities.forEach((o) => {
    const v = byItemCity[o.id] && byItemCity[o.id][o.destCity];
    o.volume24h = v || null;
  });
  return opportunities;
}

const opportunityCache = new Map(); // key -> { at, payload }
const OPP_CACHE_TTL_MS = 30 * 1000;

const app = express();
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, catalogReady, catalogItems: CATALOG.length, catalogLoadedAt, regions: REGIONS });
});

app.get('/api/categories', (req, res) => {
  if (!catalogReady) return res.status(503).json({ ready: false });
  const counts = { all: CATALOG.length };
  CATALOG.forEach((it) => { counts[it.cat] = (counts[it.cat] || 0) + 1; });
  res.json({ ready: true, counts });
});

app.get('/api/search-items', (req, res) => {
  if (!catalogReady) return res.status(503).json({ ready: false, results: [] });
  const q = String(req.query.q || '').trim().toLowerCase();
  if (q.length < 2) return res.json({ results: [] });

  const scored = [];
  for (const it of CATALOG) {
    const en = it.en.toLowerCase();
    const pt = it.pt.toLowerCase();
    let score;
    if (en.startsWith(q) || pt.startsWith(q)) score = 0;
    else if (en.includes(q) || pt.includes(q)) score = 1;
    else if (it.id.toLowerCase().includes(q)) score = 2;
    else continue;
    scored.push({ it, score });
  }
  scored.sort((a, b) => a.score - b.score || a.it.tier - b.it.tier || a.it.en.localeCompare(b.it.en));
  res.json({ results: scored.slice(0, 25).map((s) => s.it) });
});

app.get('/api/item-prices', async (req, res) => {
  if (!catalogReady) return res.status(503).json({ status: 'catalog_not_ready' });
  const id = String(req.query.id || '');
  const item = CATALOG.find((it) => it.id === id);
  if (!item) return res.status(404).json({ status: 'unknown_item' });

  const region = parseRegion(req);
  const includeQualities = req.query.qualities === 'true';
  const qualities = includeQualities ? [1, 2, 3, 4, 5] : [1];

  const data = await fetchPricesInBatches([id], qualities, region);
  res.json({ status: data.length ? 'ok' : 'no_data', item, prices: data });
});

app.get('/api/opportunities', async (req, res) => {
  if (!catalogReady) return res.status(503).json({ status: 'catalog_not_ready' });

  const includeEnchanted = req.query.enchanted === 'true';
  const includeQualities = req.query.qualities === 'true';
  const buyCity = String(req.query.buyCity || '');
  const region = parseRegion(req);
  const qualities = includeQualities ? [1, 2, 3, 4, 5] : [1];

  if (!CITIES.includes(buyCity)) return res.status(400).json({ status: 'invalid_buy_city' });
  const sellCities = parseSellCities(req, buyCity);
  if (sellCities.error) return res.status(400).json({ status: 'invalid_sell_city', invalid: sellCities.error });
  if (sellCities.length === 0) return res.status(400).json({ status: 'no_sell_cities' });
  const categories = parseCategories(req);
  if (categories.error) return res.status(400).json({ status: 'invalid_category', invalid: categories.error });

  const cacheKey = JSON.stringify({ categories, includeEnchanted, includeQualities, buyCity, sellCities, region });
  const cached = opportunityCache.get(cacheKey);
  if (cached && Date.now() - cached.at < OPP_CACHE_TTL_MS) {
    return res.json(cached.payload);
  }

  const items = buildItemList(categories, includeEnchanted);
  if (items.length === 0) return res.json({ status: 'no_items', opportunities: [] });

  const ids = items.map((it) => it.id);
  const data = await fetchPricesInBatches(ids, qualities, region);

  if (data.length === 0) {
    const payload = { status: 'no_data', opportunities: [] };
    opportunityCache.set(cacheKey, { at: Date.now(), payload });
    return res.json(payload);
  }

  const byItem = {};
  data.forEach((row) => {
    if (!byItem[row.item_id]) byItem[row.item_id] = {};
    if (!byItem[row.item_id][row.city]) byItem[row.item_id][row.city] = {};
    byItem[row.item_id][row.city][row.quality] = row;
  });

  function sellPriceAt(destino) {
    if (!destino) return null;
    if (destino.buy_price_max > 0) return destino.buy_price_max;
    return null;
  }

  const opportunities = [];
  items.forEach((it) => {
    const byCity = byItem[it.id];
    if (!byCity) return;
    qualities.forEach((q) => {
      const origin = byCity[buyCity] && byCity[buyCity][q];
      if (!origin) return;
      const buyCost = origin.sell_price_min;
      if (!buyCost || buyCost <= 0) return;

      sellCities.forEach((sellCity) => {
        const destino = byCity[sellCity] && byCity[sellCity][q];
        const price = sellPriceAt(destino);
        if (price && price > buyCost) {
          const profit = price - buyCost;
          opportunities.push({
            id: it.id, quality: q, en: it.en, pt: it.pt,
            buyCost, destCity: sellCity, sellPrice: price,
            profit, pct: profit / buyCost * 100,
            buyCostDate: origin.sell_price_min_date || null,
            sellPriceDate: destino.buy_price_max_date || null
          });
        }
      });
    });
  });

  opportunities.sort((a, b) => b.profit - a.profit);
  const top = opportunities.slice(0, 60);
  if (top.length > 0) await attachVolume24h(top, region);

  const payload = { status: top.length ? 'ok' : 'no_opportunities', dataCount: data.length, opportunities: top };
  opportunityCache.set(cacheKey, { at: Date.now(), payload });
  res.json(payload);
});

app.get('/api/item-history', async (req, res) => {
  if (!catalogReady) return res.status(503).json({ status: 'catalog_not_ready' });
  const id = String(req.query.id || '');
  const item = CATALOG.find((it) => it.id === id);
  if (!item) return res.status(404).json({ status: 'unknown_item' });

  const region = parseRegion(req);
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));

  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);
  const fmt = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

  const url = 'https://' + region + '.albion-online-data.com/api/v2/stats/history/' + encodeURIComponent(id) + '.json?locations=' +
    encodeURIComponent(CITIES.join(',')) + '&qualities=1&time-scale=24&date=' + fmt(start) + '&end_date=' + fmt(end);

  try {
    const r = await fetch(url);
    if (!r.ok) return res.json({ status: 'no_data', history: [] });
    const data = await r.json();
    res.json({ status: data.length ? 'ok' : 'no_data', history: data });
  } catch (e) {
    console.warn('History fetch failed:', e.message);
    res.json({ status: 'error', history: [] });
  }
});

app.get('/api/nats-status', (req, res) => {
  res.json({ enabled: USE_NATS, regions: natsClient.status() });
});

app.get('/api/opportunities-live', async (req, res) => {
  if (!USE_NATS) return res.status(503).json({ status: 'nats_disabled' });
  if (!catalogReady) return res.status(503).json({ status: 'catalog_not_ready' });

  const includeEnchanted = req.query.enchanted === 'true';
  const includeQualities = req.query.qualities === 'true';
  const buyCity = String(req.query.buyCity || '');
  const region = parseRegion(req);
  const qualities = includeQualities ? [1, 2, 3, 4, 5] : [1];

  if (!CITIES.includes(buyCity)) return res.status(400).json({ status: 'invalid_buy_city' });
  const sellCities = parseSellCities(req, buyCity);
  if (sellCities.error) return res.status(400).json({ status: 'invalid_sell_city', invalid: sellCities.error });
  if (sellCities.length === 0) return res.status(400).json({ status: 'no_sell_cities' });
  const categories = parseCategories(req);
  if (categories.error) return res.status(400).json({ status: 'invalid_category', invalid: categories.error });

  const items = buildItemList(categories, includeEnchanted);
  if (items.length === 0) return res.json({ status: 'no_items', opportunities: [] });

  const opportunities = [];
  items.forEach((it) => {
    qualities.forEach((q) => {
      const origin = natsClient.bestPrices(it.id, buyCity, q, region);
      const buyCost = origin.sellMin;
      if (!buyCost || buyCost <= 0) return;

      sellCities.forEach((sellCity) => {
        const dest = natsClient.bestPrices(it.id, sellCity, q, region);
        if (dest.buyMax && dest.buyMax > buyCost) {
          const profit = dest.buyMax - buyCost;
          opportunities.push({
            id: it.id, quality: q, en: it.en, pt: it.pt,
            buyCost, destCity: sellCity, sellPrice: dest.buyMax,
            profit, pct: profit / buyCost * 100
          });
        }
      });
    });
  });

  opportunities.sort((a, b) => b.profit - a.profit);
  const top = opportunities.slice(0, 60);
  if (top.length > 0) await attachVolume24h(top, region);

  res.json({
    status: top.length ? 'ok' : 'no_opportunities',
    natsStatus: natsClient.status()[region],
    opportunities: top
  });
});

app.listen(PORT, () => {
  console.log('Albion market backend listening on port ' + PORT);
  loadCatalog();
  if (USE_NATS) natsClient.start(REGIONS);
});