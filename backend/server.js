const express = require('express');
const fs = require('fs');
const path = require('path');
const natsClient = require('./natsClient');

const PORT = process.env.PORT || 4000;
const DEFAULT_REGION = process.env.REGION || 'west'; // west = Americas, europe = Europe, east = Asia
const USE_NATS = process.env.USE_NATS !== 'false'; // set USE_NATS=false to disable the live feed entirely
const DATA_DIR = process.env.DATA_DIR || '/data';
const CATALOG_FILE = path.join(DATA_DIR, 'catalog_v2.json');
const CATALOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // re-fetch from GitHub at most once a week
const ITEMS_URL = 'https://raw.githubusercontent.com/ao-data/ao-bin-dumps/master/formatted/items.json';

const REGIONS = ['west', 'europe', 'east'];
const CITIES = ['Caerleon', 'Bridgewatch', 'Fort Sterling', 'Lymhurst', 'Martlock', 'Thetford', 'Brecilien'];

const EXCLUDE_RE = [
  /^DEBUG_/, /^GVGSEASONREWARD/, /^HELLGATE_/, /^QUESTITEM/, /^UNIQUE_/, /^LABOURER/, /^HIDEOUT/, /^ROAD_/,
  /_TOKEN(_|$)/, /PROTOTYPE/, /ARENA_BANNER/, /_BP$/
];

const CAT_RULES = [
  [/^ARTEFACT_/, 'artifacts'],
  [/^(MAIN_|2H_|OFF_)/, 'weapons'],
  [/^(HEAD_|ARMOR_|SHOES_)/, 'armor'],
  [/^(BAG|CAPE)/, 'bagcape'],
  [/^(WOOD|ORE|FIBER|HIDE|ROCK|PLANKS|METALBAR|CLOTH|LEATHER|STONEBLOCK)$/, 'resources'],
  [/^POTION_/, 'potions'],
  [/^MEAL_/, 'food'],
  [/^FARM_(OX|HORSE|DIREWOLF|DIREBOAR|DIREBEAR|SWAMPDRAGON|MAMMOTH|COUGAR|GIANTSTAG|RABBIT|MOABIRD|RAM|GREYWOLF|CHICKEN|GOAT|GOOSE|SHEEP|PIG|COW)/, 'mounts'],
  [/_SEED$/, 'seeds'],
  [/^JOURNAL_/, 'journals'],
  [/^FURNITUREITEM_/, 'furniture'],
  [/^(FISH_|FISHSAUCE|FISHCHOPS|FISHINGBAIT)/, 'fish']
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
    if (fs.existsSync(CATALOG_FILE)) {
      const stat = fs.statSync(CATALOG_FILE);
      const age = Date.now() - stat.mtimeMs;
      const cached = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
      CATALOG = cached;
      catalogReady = true;
      catalogLoadedAt = stat.mtime;
      console.log('Loaded catalog from disk cache (' + cached.length + ' items, age ' + Math.round(age / 3600000) + 'h)');
      if (age < CATALOG_MAX_AGE_MS) return;
      console.log('Cache is old, refreshing in background...');
    }
  } catch (e) {
    console.warn('Could not read catalog cache:', e.message);
  }

  try {
    const fresh = await fetchAndBuildCatalog();
    CATALOG = fresh;
    catalogReady = true;
    catalogLoadedAt = new Date();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CATALOG_FILE, JSON.stringify(fresh));
    console.log('Fetched and cached fresh catalog (' + fresh.length + ' items)');
  } catch (e) {
    console.error('Failed to fetch catalog:', e.message);
    if (CATALOG.length === 0) catalogReady = false;
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

function buildItemList(category, tierMin, tierMax, includeEnchanted) {
  return CATALOG.filter((it) => {
    if (category !== 'all' && it.cat !== category) return false;
    if (it.tier < tierMin || it.tier > tierMax) return false;
    if (!includeEnchanted && it.ench > 0) return false;
    return true;
  });
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
  const results = [];
  for (const it of CATALOG) {
    if (it.en.toLowerCase().includes(q) || it.pt.toLowerCase().includes(q) || it.id.toLowerCase().includes(q)) {
      results.push(it);
      if (results.length >= 25) break;
    }
  }
  res.json({ results });
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

  const category = String(req.query.category || 'all');
  const tierMin = Math.max(1, parseInt(req.query.tierMin, 10) || 1);
  const tierMax = Math.min(8, parseInt(req.query.tierMax, 10) || 8);
  const includeEnchanted = req.query.enchanted === 'true';
  const includeQualities = req.query.qualities === 'true';
  const buyCity = String(req.query.buyCity || '');
  const region = parseRegion(req);
  const qualities = includeQualities ? [1, 2, 3, 4, 5] : [1];

  if (!CITIES.includes(buyCity)) return res.status(400).json({ status: 'invalid_buy_city' });
  const sellCities = parseSellCities(req, buyCity);
  if (sellCities.error) return res.status(400).json({ status: 'invalid_sell_city', invalid: sellCities.error });
  if (sellCities.length === 0) return res.status(400).json({ status: 'no_sell_cities' });

  const cacheKey = JSON.stringify({ category, tierMin, tierMax, includeEnchanted, includeQualities, buyCity, sellCities, region });
  const cached = opportunityCache.get(cacheKey);
  if (cached && Date.now() - cached.at < OPP_CACHE_TTL_MS) {
    return res.json(cached.payload);
  }

  const items = buildItemList(category, tierMin, tierMax, includeEnchanted);
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
        const price = sellPriceAt(byCity[sellCity] && byCity[sellCity][q]);
        if (price && price > buyCost) {
          const profit = price - buyCost;
          opportunities.push({
            id: it.id, quality: q, en: it.en, pt: it.pt,
            buyCost, destCity: sellCity, sellPrice: price,
            profit, pct: profit / buyCost * 100
          });
        }
      });
    });
  });

  const payload = { status: opportunities.length ? 'ok' : 'no_opportunities', dataCount: data.length, opportunities };
  opportunityCache.set(cacheKey, { at: Date.now(), payload });
  res.json(payload);
});

app.get('/api/nats-status', (req, res) => {
  res.json({ enabled: USE_NATS, regions: natsClient.status() });
});

app.get('/api/opportunities-live', (req, res) => {
  if (!USE_NATS) return res.status(503).json({ status: 'nats_disabled' });
  if (!catalogReady) return res.status(503).json({ status: 'catalog_not_ready' });

  const category = String(req.query.category || 'all');
  const tierMin = Math.max(1, parseInt(req.query.tierMin, 10) || 1);
  const tierMax = Math.min(8, parseInt(req.query.tierMax, 10) || 8);
  const includeEnchanted = req.query.enchanted === 'true';
  const includeQualities = req.query.qualities === 'true';
  const buyCity = String(req.query.buyCity || '');
  const region = parseRegion(req);
  const qualities = includeQualities ? [1, 2, 3, 4, 5] : [1];

  if (!CITIES.includes(buyCity)) return res.status(400).json({ status: 'invalid_buy_city' });
  const sellCities = parseSellCities(req, buyCity);
  if (sellCities.error) return res.status(400).json({ status: 'invalid_sell_city', invalid: sellCities.error });
  if (sellCities.length === 0) return res.status(400).json({ status: 'no_sell_cities' });

  const items = buildItemList(category, tierMin, tierMax, includeEnchanted);
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

  res.json({
    status: opportunities.length ? 'ok' : 'no_opportunities',
    natsStatus: natsClient.status()[region],
    opportunities
  });
});

app.listen(PORT, () => {
  console.log('Albion market backend listening on port ' + PORT);
  loadCatalog();
  if (USE_NATS) natsClient.start(REGIONS);
});