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
// Black Market is tracked by AODP as its own location, separate from the regular
// Caerleon market. It only ever has BUY orders (NPCs buying PvE loot from players),
// never sell orders, so it can only be a sell destination, never a buy source.
const SELL_ONLY_LOCATIONS = ['Black Market'];
const ALL_LOCATIONS = CITIES.concat(SELL_ONLY_LOCATIONS);

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
        batch.join(',') + '.json?locations=' + encodeURIComponent(ALL_LOCATIONS.join(',')) + '&qualities=' + qualities.join(',');
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
  if (raw === 'ALL') return ALL_LOCATIONS.filter((c) => c !== buyCity);
  const requested = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const invalid = requested.filter((c) => !ALL_LOCATIONS.includes(c));
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
        batch.join(',') + '.json?locations=' + encodeURIComponent(ALL_LOCATIONS.join(',')) +
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

// Real crafting requirements, valid tier ranges, and real item/resource
// names, extracted directly from the game's own items.xml + items.json
// (ao-data/ao-bin-dumps). Quantities are identical at every valid tier —
// only the resource's own tier changes to match. Grouped by the game's own
// craftingcategory, so e.g. the "bow" group contains the base Bow plus its
// named faction variants (Mistpiercer, Wailing Bow, Bow of Badon, ...).
const CRAFT_GROUPS = [{"group":"arcanestaff","label":{"en":"Arcane Staff","pt":"Cajado Arcano"},"city":"Lymhurst","variants":[{"family":"2H_ARCANESTAFF","en":"Great Arcane Staff","pt":"Cajado Arcano Elevado","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":20},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12}]},{"family":"2H_ARCANESTAFF_HELL","en":"Occult Staff","pt":"Cajado Oculto","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":20},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12},{"code":"ARTEFACT_2H_ARCANESTAFF_HELL","en":"Occult Orb","pt":"Orbe Oculto","qty":1}]},{"family":"2H_ARCANE_RINGPAIR_AVALON","en":"Evensong","pt":"Som Equilibrado","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":20},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12},{"code":"ARTEFACT_2H_ARCANE_RINGPAIR_AVALON","en":"Hypnotic Harmonic Ring","pt":"Anel Harmônico Hipnótico","qty":1}]},{"family":"2H_ENIGMATICORB_MORGANA","en":"Malevolent Locus","pt":"Local Malévolo","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":20},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12},{"code":"ARTEFACT_2H_ENIGMATICORB_MORGANA","en":"Possessed Catalyst","pt":"Catalisador Possuído","qty":1}]},{"family":"2H_ENIGMATICSTAFF","en":"Enigmatic Staff","pt":"Cajado Enigmático","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":20},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12}]},{"family":"MAIN_ARCANESTAFF","en":"Arcane Staff","pt":"Cajado Arcano","tierMin":3,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":16},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":8}]},{"family":"MAIN_ARCANESTAFF_UNDEAD","en":"Witchwork Staff","pt":"Cajado Feiticeiro","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":16},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":8},{"code":"ARTEFACT_MAIN_ARCANESTAFF_UNDEAD","en":"Lost Arcane Crystal","pt":"Cristal Arcano Perdido","qty":1}]}]},{"group":"axe","label":{"en":"Axe","pt":"Machado"},"city":"Martlock","variants":[{"family":"2H_AXE","en":"Greataxe","pt":"Machadão","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":12},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":20}]},{"family":"2H_AXE_AVALON","en":"Realmbreaker","pt":"Quebra-reino","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":12},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":20},{"code":"ARTEFACT_2H_AXE_AVALON","en":"Avalonian Battle Memoir","pt":"Memórias de Batalha Avaloniana","qty":1}]},{"family":"2H_DUALAXE_KEEPER","en":"Bear Paws","pt":"Patas de Urso","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":12},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":20},{"code":"ARTEFACT_2H_DUALAXE_KEEPER","en":"Keeper Axeheads","pt":"Cabeças de Machado Protetoras","qty":1}]},{"family":"2H_HALBERD","en":"Halberd","pt":"Alabarda","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":20},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12}]},{"family":"2H_HALBERD_MORGANA","en":"Carrioncaller","pt":"Chama-corpos","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":20},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12},{"code":"ARTEFACT_2H_HALBERD_MORGANA","en":"Morgana Halberd Head","pt":"Cabeça de Alabarda de Morgana","qty":1}]},{"family":"2H_SCYTHE_HELL","en":"Infernal Scythe","pt":"Segadeira Infernal","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":12},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":20},{"code":"ARTEFACT_2H_SCYTHE_HELL","en":"Hellish Sicklehead","pt":"Cabeça de Foice Diabólica","qty":1}]},{"family":"MAIN_AXE","en":"Battleaxe","pt":"Machado de Guerra","tierMin":3,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":8},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":16}]}]},{"group":"bow","label":{"en":"Bow","pt":"Arco"},"city":"Lymhurst","variants":[{"family":"2H_BOW","en":"Bow","pt":"Arco","tierMin":2,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":32}]},{"family":"2H_BOW_AVALON","en":"Mistpiercer","pt":"Fura-bruma","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":32},{"code":"ARTEFACT_2H_BOW_AVALON","en":"Immaculately Crafted Riser","pt":"Tubo Bem Fabricado","qty":1}]},{"family":"2H_BOW_HELL","en":"Wailing Bow","pt":"Arco Plangente","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":32},{"code":"ARTEFACT_2H_BOW_HELL","en":"Demonic Arrowheads","pt":"Pontas de Flecha Demoníacas","qty":1}]},{"family":"2H_BOW_KEEPER","en":"Bow of Badon","pt":"Arco Badônico","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":32},{"code":"ARTEFACT_2H_BOW_KEEPER","en":"Carved Bone","pt":"Osso Entalhado","qty":1}]},{"family":"2H_LONGBOW","en":"Longbow","pt":"Arco Longo","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":32}]},{"family":"2H_LONGBOW_UNDEAD","en":"Whispering Bow","pt":"Arco Sussurrante","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":32},{"code":"ARTEFACT_2H_LONGBOW_UNDEAD","en":"Ghastly Arrows","pt":"Flechas Sinistras","qty":1}]}]},{"group":"dagger","label":{"en":"Dagger","pt":"Adaga"},"city":"Bridgewatch","variants":[{"family":"2H_CLAWPAIR","en":"Claws","pt":"Garras","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12},{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":20}]},{"family":"2H_DAGGERPAIR","en":"Dagger Pair","pt":"Par de Adagas","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":16},{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":16}]},{"family":"2H_DAGGER_KATAR_AVALON","en":"Bridled Fury","pt":"Fúria Contida","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12},{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":20},{"code":"ARTEFACT_2H_DAGGER_KATAR_AVALON","en":"Bloodstained Antiquities","pt":"Antiquidades Ensanguentadas","qty":1}]},{"family":"2H_DUALSICKLE_UNDEAD","en":"Deathgivers","pt":"Mortíficos","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":16},{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":16},{"code":"ARTEFACT_2H_DUALSICKLE_UNDEAD","en":"Ghastly Blades","pt":"Lâminas Sinistras","qty":1}]},{"family":"2H_IRONGAUNTLETS_HELL","en":"Black Hands","pt":"Mãos Pretas","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12},{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":20},{"code":"ARTEFACT_2H_IRONGAUNTLETS_HELL","en":"Black Leather","pt":"Couro Preto","qty":1}]},{"family":"MAIN_DAGGER","en":"Dagger","pt":"Adaga","tierMin":3,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12},{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":12}]},{"family":"MAIN_DAGGER_HELL","en":"Demonfang","pt":"Presa Demoníaca","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12},{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":12},{"code":"ARTEFACT_MAIN_DAGGER_HELL","en":"Broken Demonic Fang","pt":"Presa Demoníaca Quebrada","qty":1}]},{"family":"MAIN_RAPIER_MORGANA","en":"Bloodletter","pt":"Dessangrador","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":16},{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":8},{"code":"ARTEFACT_MAIN_RAPIER_MORGANA","en":"Hardened Debole","pt":"Débil Endurecido","qty":1}]}]},{"group":"sword","label":{"en":"Sword","pt":"Espada"},"city":"Lymhurst","variants":[{"family":"2H_CLAYMORE","en":"Claymore","pt":"Montante","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":20},{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":12}]},{"family":"2H_CLAYMORE_AVALON","en":"Kingmaker","pt":"Cria-reis","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":20},{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":12},{"code":"ARTEFACT_2H_CLAYMORE_AVALON","en":"Remnants of the Old King","pt":"Restos do Velho Rei","qty":1}]},{"family":"2H_CLEAVER_HELL","en":"Carving Sword","pt":"Espada Entalhada","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":20},{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":12},{"code":"ARTEFACT_2H_CLEAVER_HELL","en":"Demonic Blade","pt":"Lâmina Demoníaca","qty":1}]},{"family":"2H_DUALSCIMITAR_UNDEAD","en":"Galatine Pair","pt":"Par de Galatinas","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":20},{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":12},{"code":"ARTEFACT_2H_DUALSCIMITAR_UNDEAD","en":"Cursed Blades","pt":"Lâminas Amaldiçoadas","qty":1}]},{"family":"2H_DUALSWORD","en":"Dual Swords","pt":"Espadas Duplas","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":20},{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":12}]},{"family":"MAIN_SCIMITAR_MORGANA","en":"Clarent Blade","pt":"Lâmina Aclarada","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":16},{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":8},{"code":"ARTEFACT_MAIN_SCIMITAR_MORGANA","en":"Bloodforged Blade","pt":"Lâmina Forjada em Sangue","qty":1}]},{"family":"MAIN_SWORD","en":"Broadsword","pt":"Espada Larga","tierMin":1,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":16},{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":8}]}]},{"group":"quarterstaff","label":{"en":"Quarterstaff","pt":"Bo"},"city":"Martlock","variants":[{"family":"2H_COMBATSTAFF_MORGANA","en":"Black Monk Staff","pt":"Cajado de Monge Negro","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12},{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":20},{"code":"ARTEFACT_2H_COMBATSTAFF_MORGANA","en":"Reinforced Morgana Pole","pt":"Estaca de Morgana Reforçada","qty":1}]},{"family":"2H_DOUBLEBLADEDSTAFF","en":"Double Bladed Staff","pt":"Cajado Bilaminado","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12},{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":20}]},{"family":"2H_IRONCLADEDSTAFF","en":"Iron-clad Staff","pt":"Cajado Férreo","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12},{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":20}]},{"family":"2H_QUARTERSTAFF","en":"Quarterstaff","pt":"Bordão","tierMin":3,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12},{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":20}]},{"family":"2H_QUARTERSTAFF_AVALON","en":"Grailseeker","pt":"Buscador do Graal","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12},{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":20},{"code":"ARTEFACT_2H_QUARTERSTAFF_AVALON","en":"Timeworn Walking Staff","pt":"Bengala Desgastada","qty":1}]},{"family":"2H_ROCKSTAFF_KEEPER","en":"Staff of Balance","pt":"Cajado do Equilíbrio","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12},{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":20},{"code":"ARTEFACT_2H_ROCKSTAFF_KEEPER","en":"Preserved Rocks","pt":"Rochas Preservadas","qty":1}]}]},{"group":"crossbow","label":{"en":"Crossbow","pt":"Besta"},"city":"Bridgewatch","variants":[{"family":"2H_CROSSBOW","en":"Crossbow","pt":"Besta","tierMin":3,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":20},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12}]},{"family":"2H_CROSSBOWLARGE","en":"Heavy Crossbow","pt":"Besta Pesada","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":20},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12}]},{"family":"2H_CROSSBOWLARGE_MORGANA","en":"Siegebow","pt":"Arco de Cerco","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":20},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12},{"code":"ARTEFACT_2H_CROSSBOWLARGE_MORGANA","en":"Alluring Bolts","pt":"Virotes Fascinantes","qty":1}]},{"family":"2H_CROSSBOW_CANNON_AVALON","en":"Energy Shaper","pt":"Modelador de Energia","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":20},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12},{"code":"ARTEFACT_2H_CROSSBOW_CANNON_AVALON","en":"Humming Avalonian Whirligig","pt":"Turbilhão Sussurrante Avaloniano","qty":1}]},{"family":"2H_DUALCROSSBOW_HELL","en":"Boltcasters","pt":"Lança-virotes","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":20},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12},{"code":"ARTEFACT_2H_DUALCROSSBOW_HELL","en":"Hellish Bolts","pt":"Virotes Diabólicos","qty":1}]},{"family":"2H_REPEATINGCROSSBOW_UNDEAD","en":"Weeping Repeater","pt":"Repetidor Lamentoso","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":20},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12},{"code":"ARTEFACT_2H_REPEATINGCROSSBOW_UNDEAD","en":"Lost Crossbow Mechanism","pt":"Mecanismo de Besta Perdido","qty":1}]},{"family":"MAIN_1HCROSSBOW","en":"Light Crossbow","pt":"Besta Leve","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":16},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":8}]}]},{"group":"cursestaff","label":{"en":"Cursed Staff","pt":"Cajado Amaldiçoado"},"city":"Bridgewatch","variants":[{"family":"2H_CURSEDSTAFF","en":"Great Cursed Staff","pt":"Cajado Amaldiçoado Elevado","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":20},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12}]},{"family":"2H_CURSEDSTAFF_MORGANA","en":"Damnation Staff","pt":"Cajado da Danação","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":20},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12},{"code":"ARTEFACT_2H_CURSEDSTAFF_MORGANA","en":"Bloodforged Catalyst","pt":"Catalisador Forjado em Sangue","qty":1}]},{"family":"2H_DEMONICSTAFF","en":"Demonic Staff","pt":"Cajado Demoníaco","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":20},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12}]},{"family":"2H_SKULLORB_HELL","en":"Cursed Skull","pt":"Caveira Amaldiçoada","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":20},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12},{"code":"ARTEFACT_2H_SKULLORB_HELL","en":"Cursed Jawbone","pt":"Mandíbula Amaldiçoada","qty":1}]},{"family":"MAIN_CURSEDSTAFF","en":"Cursed Staff","pt":"Cajado Amaldiçoado","tierMin":3,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":16},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":8}]},{"family":"MAIN_CURSEDSTAFF_AVALON","en":"Shadowcaller","pt":"Chama-sombra","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":16},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":8},{"code":"ARTEFACT_MAIN_CURSEDSTAFF_AVALON","en":"Fractured Opaque Orb","pt":"Orbe Opaca Fraturada","qty":1}]},{"family":"MAIN_CURSEDSTAFF_UNDEAD","en":"Lifecurse Staff","pt":"Cajado Execrado","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":16},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":8},{"code":"ARTEFACT_MAIN_CURSEDSTAFF_UNDEAD","en":"Lost Cursed Crystal","pt":"Cristal Amaldiçoado Perdido","qty":1}]}]},{"group":"holystaff","label":{"en":"Holy Staff","pt":"Cajado Sagrado"},"city":"Fort Sterling","variants":[{"family":"2H_DIVINESTAFF","en":"Divine Staff","pt":"Cajado Divino","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":20},{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":12}]},{"family":"2H_HOLYSTAFF","en":"Great Holy Staff","pt":"Cajado Sagrado Elevado","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":20},{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":12}]},{"family":"2H_HOLYSTAFF_HELL","en":"Fallen Staff","pt":"Cajado Corrompido","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":20},{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":12},{"code":"ARTEFACT_2H_HOLYSTAFF_HELL","en":"Infernal Scroll","pt":"Pergaminho Infernal","qty":1}]},{"family":"2H_HOLYSTAFF_UNDEAD","en":"Redemption Staff","pt":"Cajado da Redenção","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":20},{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":12},{"code":"ARTEFACT_2H_HOLYSTAFF_UNDEAD","en":"Ghastly Scroll","pt":"Pergaminho Sinistro","qty":1}]},{"family":"MAIN_HOLYSTAFF","en":"Holy Staff","pt":"Cajado Sagrado","tierMin":3,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":16},{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":8}]},{"family":"MAIN_HOLYSTAFF_AVALON","en":"Hallowfall","pt":"Queda Santa","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":16},{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":8},{"code":"ARTEFACT_MAIN_HOLYSTAFF_AVALON","en":"Messianic Curio","pt":"Raridade Messiânica","qty":1}]},{"family":"MAIN_HOLYSTAFF_MORGANA","en":"Lifetouch Staff","pt":"Cajado Avivador","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":16},{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":8},{"code":"ARTEFACT_MAIN_HOLYSTAFF_MORGANA","en":"Possessed Scroll","pt":"Pergaminho Possuído","qty":1}]}]},{"group":"hammer","label":{"en":"Hammer","pt":"Martelo"},"city":"Fort Sterling","variants":[{"family":"2H_DUALHAMMER_HELL","en":"Forge Hammers","pt":"Martelos de Forja","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":20},{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":12},{"code":"ARTEFACT_2H_DUALHAMMER_HELL","en":"Hellish Hammer Heads","pt":"Cabeças de Martelo Diabólicas","qty":1}]},{"family":"2H_HAMMER","en":"Great Hammer","pt":"Martelo Elevado","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":20},{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":12}]},{"family":"2H_HAMMER_AVALON","en":"Hand of Justice","pt":"Mão da Justiça","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":20},{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":12},{"code":"ARTEFACT_2H_HAMMER_AVALON","en":"Massive Metallic Hand","pt":"Mão Metálica","qty":1}]},{"family":"2H_HAMMER_UNDEAD","en":"Tombhammer","pt":"Martelo Fúnebre","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":20},{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":12},{"code":"ARTEFACT_2H_HAMMER_UNDEAD","en":"Ancient Hammer Head","pt":"Cabeça de Martelo Ancestral","qty":1}]},{"family":"2H_POLEHAMMER","en":"Polehammer","pt":"Martelo de Batalha","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":20},{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":12}]},{"family":"2H_RAM_KEEPER","en":"Grovekeeper","pt":"Guarda-bosques","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":20},{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":12},{"code":"ARTEFACT_2H_RAM_KEEPER","en":"Engraved Log","pt":"Cepo Entalhado","qty":1}]},{"family":"MAIN_HAMMER","en":"Hammer","pt":"Martelo","tierMin":3,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":24}]}]},{"group":"mace","label":{"en":"Mace","pt":"Maça"},"city":"Thetford","variants":[{"family":"2H_DUALMACE_AVALON","en":"Oathkeepers","pt":"Jurador","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":20},{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":12},{"code":"ARTEFACT_2H_DUALMACE_AVALON","en":"Broken Oaths","pt":"Juramentos Quebrados","qty":1}]},{"family":"2H_FLAIL","en":"Morning Star","pt":"Mangual","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":20},{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":12}]},{"family":"2H_MACE","en":"Heavy Mace","pt":"Maça Pesada","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":20},{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":12}]},{"family":"2H_MACE_MORGANA","en":"Camlann Mace","pt":"Maça Cambriana","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":20},{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":12},{"code":"ARTEFACT_2H_MACE_MORGANA","en":"Imbued Mace Head","pt":"Cabeça de Maça Imbuída","qty":1}]},{"family":"MAIN_MACE","en":"Mace","pt":"Maça","tierMin":3,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":16},{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":8}]},{"family":"MAIN_MACE_HELL","en":"Incubus Mace","pt":"Maça de Íncubo","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":16},{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":8},{"code":"ARTEFACT_MAIN_MACE_HELL","en":"Infernal Mace Head","pt":"Cabeça de Maça Infernal","qty":1}]},{"family":"MAIN_ROCKMACE_KEEPER","en":"Bedrock Mace","pt":"Maça Pétrea","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":16},{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":8},{"code":"ARTEFACT_MAIN_ROCKMACE_KEEPER","en":"Runed Rock","pt":"Rocha com Runa","qty":1}]}]},{"group":"firestaff","label":{"en":"Fire Staff","pt":"Cajado de Fogo"},"city":"Thetford","variants":[{"family":"2H_FIRESTAFF","en":"Great Fire Staff","pt":"Cajado de Fogo Elevado","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":20},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12}]},{"family":"2H_FIRESTAFF_HELL","en":"Brimstone Staff","pt":"Cajado Sulfuroso","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":20},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12},{"code":"ARTEFACT_2H_FIRESTAFF_HELL","en":"Burning Orb","pt":"Orbe Inflamado","qty":1}]},{"family":"2H_FIRE_RINGPAIR_AVALON","en":"Dawnsong","pt":"Canção da Alvorada","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":20},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12},{"code":"ARTEFACT_2H_FIRE_RINGPAIR_AVALON","en":"Glowing Harmonic Ring","pt":"Anel Harmônico Brilhante","qty":1}]},{"family":"2H_INFERNOSTAFF","en":"Infernal Staff","pt":"Cajado Infernal","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":20},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12}]},{"family":"2H_INFERNOSTAFF_MORGANA","en":"Blazing Staff","pt":"Cajado Fulgurante","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":20},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12},{"code":"ARTEFACT_2H_INFERNOSTAFF_MORGANA","en":"Unholy Scroll","pt":"Pergaminho Profano","qty":1}]},{"family":"MAIN_FIRESTAFF","en":"Fire Staff","pt":"Cajado de Fogo","tierMin":2,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":16},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":8}]},{"family":"MAIN_FIRESTAFF_KEEPER","en":"Wildfire Staff","pt":"Cajado Incendiário","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":16},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":8},{"code":"ARTEFACT_MAIN_FIRESTAFF_KEEPER","en":"Wildfire Orb","pt":"Orbe Incendiário","qty":1}]}]},{"group":"froststaff","label":{"en":"Frost Staff","pt":"Cajado de Gelo"},"city":"Martlock","variants":[{"family":"2H_FROSTSTAFF","en":"Great Frost Staff","pt":"Cajado de Gelo Elevado","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":20},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12}]},{"family":"2H_GLACIALSTAFF","en":"Glacial Staff","pt":"Cajado Glacial","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":20},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12}]},{"family":"2H_ICECRYSTAL_UNDEAD","en":"Permafrost Prism","pt":"Prisma Geleterno","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":20},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12},{"code":"ARTEFACT_2H_ICECRYSTAL_UNDEAD","en":"Cursed Frozen Crystal","pt":"Cristal Congelado Amaldiçoado","qty":1}]},{"family":"2H_ICEGAUNTLETS_HELL","en":"Icicle Staff","pt":"Cajado de Sincelo","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":20},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12},{"code":"ARTEFACT_2H_ICEGAUNTLETS_HELL","en":"Icicle Orb","pt":"Orbe de Sincelo","qty":1}]},{"family":"MAIN_FROSTSTAFF","en":"Frost Staff","pt":"Cajado de Gelo","tierMin":3,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":16},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":8}]},{"family":"MAIN_FROSTSTAFF_AVALON","en":"Chillhowl","pt":"Uivo Frio","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":16},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":8},{"code":"ARTEFACT_MAIN_FROSTSTAFF_AVALON","en":"Chilled Crystalline Shard","pt":"Fragmento Cristalino Gelado","qty":1}]},{"family":"MAIN_FROSTSTAFF_KEEPER","en":"Hoarfrost Staff","pt":"Cajado Enregelante","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":16},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":8},{"code":"ARTEFACT_MAIN_FROSTSTAFF_KEEPER","en":"Hoarfrost Orb","pt":"Orbe Enregelante","qty":1}]}]},{"group":"spear","label":{"en":"Spear","pt":"Lança"},"city":"Fort Sterling","variants":[{"family":"2H_GLAIVE","en":"Glaive","pt":"Archa","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":12},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":20}]},{"family":"2H_HARPOON_HELL","en":"Spirithunter","pt":"Caça-espíritos","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":20},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12},{"code":"ARTEFACT_2H_HARPOON_HELL","en":"Infernal Harpoon Tip","pt":"Ponta de Arpão Infernal","qty":1}]},{"family":"2H_SPEAR","en":"Pike","pt":"Pique","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":20},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12}]},{"family":"MAIN_SPEAR","en":"Spear","pt":"Lança","tierMin":3,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":16},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":8}]},{"family":"MAIN_SPEAR_KEEPER","en":"Heron Spear","pt":"Lança Garceira","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":16},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":8},{"code":"ARTEFACT_MAIN_SPEAR_KEEPER","en":"Keeper Spearhead","pt":"Cabeça de Lança Protetora","qty":1}]},{"family":"MAIN_SPEAR_LANCE_AVALON","en":"Daybreaker","pt":"Alvorada","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":16},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":8},{"code":"ARTEFACT_MAIN_SPEAR_LANCE_AVALON","en":"Ruined Ancestral Vamplate","pt":"Vamplate Ancestral Arruinado","qty":1}]}]},{"group":"knuckles","label":{"en":"Fist Weapon","pt":"Arma de Punho"},"city":null,"variants":[{"family":"2H_KNUCKLES_AVALON","en":"Fists of Avalon","pt":"Punhos de Avalon","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12},{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":20},{"code":"ARTEFACT_2H_KNUCKLES_AVALON","en":"Damaged Avalonian Gauntlet","pt":"Manopla Avaloniana Danificada","qty":1}]},{"family":"2H_KNUCKLES_HELL","en":"Hellfire Hands","pt":"Mãos Infernais","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12},{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":20},{"code":"ARTEFACT_2H_KNUCKLES_HELL","en":"Severed Demonic Horns","pt":"Chifres Demoníacos Cortados","qty":1}]},{"family":"2H_KNUCKLES_KEEPER","en":"Ursine Maulers","pt":"Luvas Ursinas","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12},{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":20},{"code":"ARTEFACT_2H_KNUCKLES_KEEPER","en":"Ursine Guardian Remains","pt":"Restos de Guardião Ursino","qty":1}]},{"family":"2H_KNUCKLES_MORGANA","en":"Ravenstrike Cestus","pt":"Cestus Golpeadores","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12},{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":20},{"code":"ARTEFACT_2H_KNUCKLES_MORGANA","en":"Warped Raven Plate","pt":"Placa de Corvo Deformado","qty":1}]},{"family":"2H_KNUCKLES_SET1","en":"Brawler Gloves","pt":"Luvas de Lutador","tierMin":3,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":12},{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":20}]}]},{"group":"naturestaff","label":{"en":"Nature Staff","pt":"Cajado da Natureza"},"city":"Thetford","variants":[{"family":"2H_NATURESTAFF","en":"Great Nature Staff","pt":"Cajado da Natureza Elevado","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":20},{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":12}]},{"family":"2H_NATURESTAFF_HELL","en":"Blight Staff","pt":"Cajado Pustulento","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":20},{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":12},{"code":"ARTEFACT_2H_NATURESTAFF_HELL","en":"Symbol of Blight","pt":"Símbolo de Malignidade","qty":1}]},{"family":"2H_NATURESTAFF_KEEPER","en":"Rampant Staff","pt":"Cajado Rampante","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":20},{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":12},{"code":"ARTEFACT_2H_NATURESTAFF_KEEPER","en":"Preserved Log","pt":"Cepo Preservado","qty":1}]},{"family":"MAIN_NATURESTAFF","en":"Nature Staff","pt":"Cajado da Natureza","tierMin":3,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":16},{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":8}]},{"family":"MAIN_NATURESTAFF_AVALON","en":"Ironroot Staff","pt":"Raiz Férrea","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":16},{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":8},{"code":"ARTEFACT_MAIN_NATURESTAFF_AVALON","en":"Uprooted Perennial Sapling","pt":"Muda Desenraizada Perene","qty":1}]},{"family":"MAIN_NATURESTAFF_KEEPER","en":"Druidic Staff","pt":"Cajado Druídico","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":16},{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":8},{"code":"ARTEFACT_MAIN_NATURESTAFF_KEEPER","en":"Druidic Inscriptions","pt":"Inscrições Druídicas","qty":1}]}]},{"group":"offhand","label":{"en":"Off-Hand","pt":"Off-Hand"},"city":"Martlock","variants":[{"family":"OFF_BOOK","en":"Tome of Spells","pt":"Tomo de Feitiços","tierMin":2,"tierMax":8,"res":[{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":4},{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":4}]},{"family":"OFF_CENSER_AVALON","en":"Celestial Censer","pt":"Incensário Celeste","tierMin":4,"tierMax":8,"res":[{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":4},{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":4},{"code":"ARTEFACT_OFF_CENSER_AVALON","en":"Severed Celestial Keepsake","pt":"Lembrança Celestial Rompida","qty":1}]},{"family":"OFF_DEMONSKULL_HELL","en":"Muisak","pt":"Muisec","tierMin":4,"tierMax":8,"res":[{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":4},{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":4},{"code":"ARTEFACT_OFF_DEMONSKULL_HELL","en":"Demonic Jawbone","pt":"Mandíbula Demoníaca","qty":1}]},{"family":"OFF_HORN_KEEPER","en":"Mistcaller","pt":"Brumário","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":4},{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":4},{"code":"ARTEFACT_OFF_HORN_KEEPER","en":"Runed Horn","pt":"Chifre com Runa","qty":1}]},{"family":"OFF_JESTERCANE_HELL","en":"Leering Cane","pt":"Bengala Maligna","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":4},{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":4},{"code":"ARTEFACT_OFF_JESTERCANE_HELL","en":"Hellish Handle","pt":"Manípulo Diabólico","qty":1}]},{"family":"OFF_LAMP_UNDEAD","en":"Cryptcandle","pt":"Lume Críptico","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":4},{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":4},{"code":"ARTEFACT_OFF_LAMP_UNDEAD","en":"Ghastly Candle","pt":"Vela Sinistra","qty":1}]},{"family":"OFF_ORB_MORGANA","en":"Eye of Secrets","pt":"Olho dos Segredos","tierMin":4,"tierMax":8,"res":[{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":4},{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":4},{"code":"ARTEFACT_OFF_ORB_MORGANA","en":"Alluring Crystal","pt":"Cristal Fascinante","qty":1}]},{"family":"OFF_SHIELD","en":"Shield","pt":"Escudo","tierMin":1,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":4},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":4}]},{"family":"OFF_SHIELD_AVALON","en":"Astral Aegis","pt":"Égide Astral","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":4},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":4},{"code":"ARTEFACT_OFF_SHIELD_AVALON","en":"Crushed Avalonian Heirloom","pt":"Relíquia Avaloniana Destruída","qty":1}]},{"family":"OFF_SHIELD_HELL","en":"Caitiff Shield","pt":"Escudo Vampírico","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":4},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":4},{"code":"ARTEFACT_OFF_SHIELD_HELL","en":"Infernal Shield Core","pt":"Núcleo de Escudo Infernal","qty":1}]},{"family":"OFF_SPIKEDSHIELD_MORGANA","en":"Facebreaker","pt":"Quebra-rostos","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":4},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":4},{"code":"ARTEFACT_OFF_SPIKEDSHIELD_MORGANA","en":"Bloodforged Spikes","pt":"Cavilhas Forjadas em Sangue","qty":1}]},{"family":"OFF_TALISMAN_AVALON","en":"Sacred Scepter","pt":"Cetro Sagrado","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":4},{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":4},{"code":"ARTEFACT_OFF_TALISMAN_AVALON","en":"Shattered Avalonian Memento","pt":"Lembrança Avaloniana Despedaçada","qty":1}]},{"family":"OFF_TORCH","en":"Torch","pt":"Tocha","tierMin":3,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":4},{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":4}]},{"family":"OFF_TOTEM_KEEPER","en":"Taproot","pt":"Raiz Mestra","tierMin":4,"tierMax":8,"res":[{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":4},{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":4},{"code":"ARTEFACT_OFF_TOTEM_KEEPER","en":"Inscribed Stone","pt":"Pedra Inscrita","qty":1}]},{"family":"OFF_TOWERSHIELD_UNDEAD","en":"Sarcophagus","pt":"Sarcófago","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":4},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":4},{"code":"ARTEFACT_OFF_TOWERSHIELD_UNDEAD","en":"Ancient Shield Core","pt":"Núcleo de Escudo Ancestral","qty":1}]}]},{"group":"tools","label":{"en":"Gathering Tools","pt":"Ferramentas de Coleta"},"city":null,"variants":[{"family":"2H_TOOL_AXE","en":"Axe","pt":"Machado","tierMin":1,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":6},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":2}]},{"family":"2H_TOOL_AXE_AVALON","en":"Avalonian Axe","pt":"Machado Avaloniano","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":6},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":2},{"code":"QUESTITEM_TOKEN_AVALON","en":"Avalonian Energy","pt":"Energia Avaloniana","qty":20}]},{"family":"2H_TOOL_FISHINGROD","en":"Fishing Rod","pt":"Vara de Pescar","tierMin":3,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":6},{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":2}]},{"family":"2H_TOOL_FISHINGROD_AVALON","en":"Avalonian Fishing Rod","pt":"Vara de Pescar Avaloniano","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":6},{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":2},{"code":"QUESTITEM_TOKEN_AVALON","en":"Avalonian Energy","pt":"Energia Avaloniana","qty":20}]},{"family":"2H_TOOL_HAMMER","en":"Stone Hammer","pt":"Martelo de Pedra","tierMin":1,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":6},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":2}]},{"family":"2H_TOOL_HAMMER_AVALON","en":"Avalonian Stone Hammer","pt":"Martelo de Pedra Avaloniano","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":6},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":2},{"code":"QUESTITEM_TOKEN_AVALON","en":"Avalonian Energy","pt":"Energia Avaloniana","qty":20}]},{"family":"2H_TOOL_KNIFE","en":"Skinning Knife","pt":"Faca de Esfolar","tierMin":1,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":6},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":2}]},{"family":"2H_TOOL_KNIFE_AVALON","en":"Avalonian Skinning Knife","pt":"Faca de Esfolar Avaloniano","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":6},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":2},{"code":"QUESTITEM_TOKEN_AVALON","en":"Avalonian Energy","pt":"Energia Avaloniana","qty":20}]},{"family":"2H_TOOL_PICK","en":"Pickaxe","pt":"Picareta","tierMin":1,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":6},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":2}]},{"family":"2H_TOOL_PICK_AVALON","en":"Avalonian Pickaxe","pt":"Picareta Avaloniano","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":6},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":2},{"code":"QUESTITEM_TOKEN_AVALON","en":"Avalonian Energy","pt":"Energia Avaloniana","qty":20}]},{"family":"2H_TOOL_SICKLE","en":"Sickle","pt":"Foice","tierMin":1,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":6},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":2}]},{"family":"2H_TOOL_SICKLE_AVALON","en":"Avalonian Sickle","pt":"Foice Avaloniano","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":6},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":2},{"code":"QUESTITEM_TOKEN_AVALON","en":"Avalonian Energy","pt":"Energia Avaloniana","qty":20}]},{"family":"2H_TOOL_SIEGEHAMMER","en":"Siege Hammer","pt":"Martelo de Cerco","tierMin":2,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":8},{"code":"STONEBLOCK","en":"Travertine Block","pt":"Bloco de Travertino","qty":8}]},{"family":"2H_TOOL_SIEGEHAMMER_AVALON","en":"Avalonian Siege Hammer","pt":"Martelo de Cerco Avaloniano","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":8},{"code":"STONEBLOCK","en":"Travertine Block","pt":"Bloco de Travertino","qty":8},{"code":"QUESTITEM_TOKEN_AVALON","en":"Avalonian Energy","pt":"Energia Avaloniana","qty":20}]}]},{"group":"cloth_armor","label":{"en":"Cloth Armor","pt":"Armadura de Tecido"},"city":"Fort Sterling","variants":[{"family":"ARMOR_CLOTH_AVALON","en":"Robe of Purity","pt":"Robe da Pureza","tierMin":4,"tierMax":8,"res":[{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":16},{"code":"ARTEFACT_ARMOR_CLOTH_AVALON","en":"Sanctified Belt","pt":"Cinto Santificado","qty":1}]},{"family":"ARMOR_CLOTH_FEY","en":"Feyscale Robe","pt":"Robe Feérico","tierMin":4,"tierMax":8,"res":[{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":16},{"code":"ARTEFACT_ARMOR_CLOTH_FEY","en":"Fey Dorsal Wing","pt":"Asa de Fada","qty":1}]},{"family":"ARMOR_CLOTH_HELL","en":"Fiend Robe","pt":"Robe Malévolo","tierMin":4,"tierMax":8,"res":[{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":16},{"code":"ARTEFACT_ARMOR_CLOTH_HELL","en":"Infernal Cloth Folds","pt":"Peças de Tecido Infernal","qty":1}]},{"family":"ARMOR_CLOTH_KEEPER","en":"Druid Robe","pt":"Robe de Druida","tierMin":4,"tierMax":8,"res":[{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":16},{"code":"ARTEFACT_ARMOR_CLOTH_KEEPER","en":"Druidic Feathers","pt":"Penas Druídicas","qty":1}]},{"family":"ARMOR_CLOTH_MORGANA","en":"Cultist Robe","pt":"Robe Sectário","tierMin":4,"tierMax":8,"res":[{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":16},{"code":"ARTEFACT_ARMOR_CLOTH_MORGANA","en":"Alluring Amulet","pt":"Amuleto Fascinante","qty":1}]},{"family":"ARMOR_CLOTH_SET1","en":"Scholar Robe","pt":"Robe de Erudito","tierMin":2,"tierMax":8,"res":[{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":16}]}]},{"group":"gatherergear","label":{"en":"Gathering Armor","pt":"Armadura de Coleta"},"city":null,"variants":[{"family":"ARMOR_GATHERER_FIBER","en":"Harvester Garb","pt":"Traje do Ceifeiro Adepto","tierMin":4,"tierMax":8,"res":[{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":16}]},{"family":"ARMOR_GATHERER_FISH","en":"Fisherman Garb","pt":"Traje do Pescador Adepto","tierMin":4,"tierMax":8,"res":[{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":16}]},{"family":"ARMOR_GATHERER_HIDE","en":"Skinner Garb","pt":"Traje do Esfolador Adepto","tierMin":4,"tierMax":8,"res":[{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":16}]},{"family":"ARMOR_GATHERER_ORE","en":"Miner Garb","pt":"Traje do Minerador Adepto","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":16}]},{"family":"ARMOR_GATHERER_ROCK","en":"Quarrier Garb","pt":"Traje do Cavouqueiro Adepto","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":16}]},{"family":"ARMOR_GATHERER_WOOD","en":"Lumberjack Garb","pt":"Traje do Lenhador Adepto","tierMin":4,"tierMax":8,"res":[{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":16}]},{"family":"HEAD_GATHERER_FIBER","en":"Harvester Cap","pt":"Chapéu do Ceifeiro Adepto","tierMin":4,"tierMax":8,"res":[{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":8}]},{"family":"HEAD_GATHERER_FISH","en":"Fisherman Cap","pt":"Chapéu do Pescador Adepto","tierMin":4,"tierMax":8,"res":[{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":8}]},{"family":"HEAD_GATHERER_HIDE","en":"Skinner Cap","pt":"Chapéu do Esfolador Adepto","tierMin":4,"tierMax":8,"res":[{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":8}]},{"family":"HEAD_GATHERER_ORE","en":"Miner Cap","pt":"Chapéu do Minerador Adepto","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":8}]},{"family":"HEAD_GATHERER_ROCK","en":"Quarrier Cap","pt":"Chapéu do Cavouqueiro Adepto","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":8}]},{"family":"HEAD_GATHERER_WOOD","en":"Lumberjack Cap","pt":"Chapéu do Lenhador Adepto","tierMin":4,"tierMax":8,"res":[{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":8}]},{"family":"SHOES_GATHERER_FIBER","en":"Harvester Workboots","pt":"Botas de Trabalho do Ceifeiro Adepto","tierMin":4,"tierMax":8,"res":[{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":8}]},{"family":"SHOES_GATHERER_FISH","en":"Fisherman Workboots","pt":"Botas do Pescador Adepto","tierMin":4,"tierMax":8,"res":[{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":8}]},{"family":"SHOES_GATHERER_HIDE","en":"Skinner Workboots","pt":"Botas de Trabalho do Esfolador Adepto","tierMin":4,"tierMax":8,"res":[{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":8}]},{"family":"SHOES_GATHERER_ORE","en":"Miner Workboots","pt":"Botas de Trabalho do Minerador Adepto","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":8}]},{"family":"SHOES_GATHERER_ROCK","en":"Quarrier Workboots","pt":"Botas de Trabalho do Cavouqueiro Adepto","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":8}]},{"family":"SHOES_GATHERER_WOOD","en":"Lumberjack Workboots","pt":"Botas de Trabalho do Lenhador Adepto","tierMin":4,"tierMax":8,"res":[{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":8}]}]},{"group":"leather_armor","label":{"en":"Leather Armor","pt":"Armadura de Couro"},"city":"Thetford","variants":[{"family":"ARMOR_LEATHER_AVALON","en":"Jacket of Tenacity","pt":"Casaco da Tenacidade","tierMin":4,"tierMax":8,"res":[{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":16},{"code":"ARTEFACT_ARMOR_LEATHER_AVALON","en":"Augured Sash","pt":"Cinturão Augurado","qty":1}]},{"family":"ARMOR_LEATHER_FEY","en":"Mistwalker Jacket","pt":"Casaco de Andarilho da Névoa","tierMin":4,"tierMax":8,"res":[{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":16},{"code":"ARTEFACT_ARMOR_LEATHER_FEY","en":"Untarnished Griffin Feathers","pt":"Penas de Grifo Imaculadas","qty":1}]},{"family":"ARMOR_LEATHER_HELL","en":"Hellion Jacket","pt":"Casaco Inferial","tierMin":4,"tierMax":8,"res":[{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":16},{"code":"ARTEFACT_ARMOR_LEATHER_HELL","en":"Demonhide Leather","pt":"Couro de Pele Demoníaca","qty":1}]},{"family":"ARMOR_LEATHER_MORGANA","en":"Stalker Jacket","pt":"Casaco de Espreitador","tierMin":4,"tierMax":8,"res":[{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":16},{"code":"ARTEFACT_ARMOR_LEATHER_MORGANA","en":"Imbued Leather Folds","pt":"Peças de Couro Imbuído","qty":1}]},{"family":"ARMOR_LEATHER_SET1","en":"Mercenary Jacket","pt":"Casaco de Mercenário","tierMin":1,"tierMax":8,"res":[{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":16}]},{"family":"ARMOR_LEATHER_UNDEAD","en":"Specter Jacket","pt":"Casaco Espectral","tierMin":4,"tierMax":8,"res":[{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":16},{"code":"ARTEFACT_ARMOR_LEATHER_UNDEAD","en":"Ghastly Leather","pt":"Couro Sinistro","qty":1}]}]},{"group":"plate_armor","label":{"en":"Plate Armor","pt":"Armadura de Placas"},"city":"Bridgewatch","variants":[{"family":"ARMOR_PLATE_AVALON","en":"Armor of Valor","pt":"Armadura da Bravura","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":16},{"code":"ARTEFACT_ARMOR_PLATE_AVALON","en":"Exalted Plating","pt":"Couraça Elevada","qty":1}]},{"family":"ARMOR_PLATE_FEY","en":"Duskweaver Armor","pt":"Armadura de Tecelão do Crepúsculo","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":16},{"code":"ARTEFACT_ARMOR_PLATE_FEY","en":"Veilweaver Carapace","pt":"Carapaça da Tecelã","qty":1}]},{"family":"ARMOR_PLATE_HELL","en":"Demon Armor","pt":"Armadura Demônia","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":16},{"code":"ARTEFACT_ARMOR_PLATE_HELL","en":"Demonic Plates","pt":"Placas Demoníacas","qty":1}]},{"family":"ARMOR_PLATE_KEEPER","en":"Judicator Armor","pt":"Armadura Judicante","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":16},{"code":"ARTEFACT_ARMOR_PLATE_KEEPER","en":"Preserved Animal Fur","pt":"Pele Preservada","qty":1}]},{"family":"ARMOR_PLATE_SET1","en":"Soldier Armor","pt":"Armadura de Soldado","tierMin":2,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":16}]},{"family":"ARMOR_PLATE_UNDEAD","en":"Graveguard Armor","pt":"Armadura de Guarda-tumbas","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":16},{"code":"ARTEFACT_ARMOR_PLATE_UNDEAD","en":"Ancient Chain Rings","pt":"Anilhas Ancestrais","qty":1}]}]},{"group":"cloth_helmet","label":{"en":"Cloth Helmet","pt":"Capuz de Tecido"},"city":"Thetford","variants":[{"family":"HEAD_CLOTH_AVALON","en":"Cowl of Purity","pt":"Capote da Pureza","tierMin":4,"tierMax":8,"res":[{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":8},{"code":"ARTEFACT_HEAD_CLOTH_AVALON","en":"Sanctified Mask","pt":"Máscara Santificada","qty":1}]},{"family":"HEAD_CLOTH_FEY","en":"Feyscale Hat","pt":"Capote Feérico","tierMin":4,"tierMax":8,"res":[{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":8},{"code":"ARTEFACT_HEAD_CLOTH_FEY","en":"Intact Fey Fibula","pt":"Fíbula Intacta de Fada","qty":1}]},{"family":"HEAD_CLOTH_HELL","en":"Fiend Cowl","pt":"Capote Malévolo","tierMin":4,"tierMax":8,"res":[{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":8},{"code":"ARTEFACT_HEAD_CLOTH_HELL","en":"Infernal Cloth Visor","pt":"Visor de Tecido Infernal","qty":1}]},{"family":"HEAD_CLOTH_KEEPER","en":"Druid Cowl","pt":"Capote de Druida","tierMin":4,"tierMax":8,"res":[{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":8},{"code":"ARTEFACT_HEAD_CLOTH_KEEPER","en":"Druidic Preserved Beak","pt":"Bico Preservado Druídico","qty":1}]},{"family":"HEAD_CLOTH_MORGANA","en":"Cultist Cowl","pt":"Capote Sectário","tierMin":4,"tierMax":8,"res":[{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":8},{"code":"ARTEFACT_HEAD_CLOTH_MORGANA","en":"Alluring Padding","pt":"Estofamento Fascinante","qty":1}]},{"family":"HEAD_CLOTH_SET1","en":"Scholar Cowl","pt":"Capote de Erudito","tierMin":2,"tierMax":8,"res":[{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":8}]}]},{"group":"leather_helmet","label":{"en":"Leather Helmet","pt":"Capuz de Couro"},"city":"Lymhurst","variants":[{"family":"HEAD_LEATHER_AVALON","en":"Hood of Tenacity","pt":"Capuz da Tenacidade","tierMin":4,"tierMax":8,"res":[{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":8},{"code":"ARTEFACT_HEAD_LEATHER_AVALON","en":"Augured Padding","pt":"Estofamento Augurado","qty":1}]},{"family":"HEAD_LEATHER_FEY","en":"Mistwalker Hood","pt":"Capuz de Andarilho da Névoa","tierMin":4,"tierMax":8,"res":[{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":8},{"code":"ARTEFACT_HEAD_LEATHER_FEY","en":"Flawless Griffin Beak","pt":"Bico de Grifo Impecável","qty":1}]},{"family":"HEAD_LEATHER_HELL","en":"Hellion Hood","pt":"Capuz Inferial","tierMin":4,"tierMax":8,"res":[{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":8},{"code":"ARTEFACT_HEAD_LEATHER_HELL","en":"Demonhide Padding","pt":"Estofamento de Pele Demoníaca","qty":1}]},{"family":"HEAD_LEATHER_MORGANA","en":"Stalker Hood","pt":"Capuz de Espreitador","tierMin":4,"tierMax":8,"res":[{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":8},{"code":"ARTEFACT_HEAD_LEATHER_MORGANA","en":"Imbued Visor","pt":"Visor Imbuído","qty":1}]},{"family":"HEAD_LEATHER_SET1","en":"Mercenary Hood","pt":"Capuz de Mercenário","tierMin":1,"tierMax":8,"res":[{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":8}]},{"family":"HEAD_LEATHER_UNDEAD","en":"Specter Hood","pt":"Capuz Espectral","tierMin":4,"tierMax":8,"res":[{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":8},{"code":"ARTEFACT_HEAD_LEATHER_UNDEAD","en":"Ghastly Visor","pt":"Visor Sinistro","qty":1}]}]},{"group":"plate_helmet","label":{"en":"Plate Helmet","pt":"Elmo de Placas"},"city":"Fort Sterling","variants":[{"family":"HEAD_PLATE_AVALON","en":"Helmet of Valor","pt":"Elmo da Bravura","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":8},{"code":"ARTEFACT_HEAD_PLATE_AVALON","en":"Exalted Visor","pt":"Viseira Elevada","qty":1}]},{"family":"HEAD_PLATE_FEY","en":"Duskweaver Helmet","pt":"Elmo de Tecelão do Crepúsculo","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":8},{"code":"ARTEFACT_HEAD_PLATE_FEY","en":"Veilweaver Mandibles","pt":"Mandíbulas da Tecelã","qty":1}]},{"family":"HEAD_PLATE_HELL","en":"Demon Helmet","pt":"Elmo Demônio","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":8},{"code":"ARTEFACT_HEAD_PLATE_HELL","en":"Demonic Scraps","pt":"Restos Demoníacos","qty":1}]},{"family":"HEAD_PLATE_KEEPER","en":"Judicator Helmet","pt":"Elmo Judicante","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":8},{"code":"ARTEFACT_HEAD_PLATE_KEEPER","en":"Carved Skull Padding","pt":"Estofamento de Caveira Entalhada","qty":1}]},{"family":"HEAD_PLATE_SET1","en":"Soldier Helmet","pt":"Elmo de Soldado","tierMin":2,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":8}]},{"family":"HEAD_PLATE_UNDEAD","en":"Graveguard Helmet","pt":"Elmo de Guarda-tumbas","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":8},{"code":"ARTEFACT_HEAD_PLATE_UNDEAD","en":"Ancient Padding","pt":"Estofamento Ancestral","qty":1}]}]},{"group":"cloth_shoes","label":{"en":"Cloth Shoes","pt":"Sapatos de Tecido"},"city":"Bridgewatch","variants":[{"family":"SHOES_CLOTH_AVALON","en":"Sandals of Purity","pt":"Sandálias da Pureza","tierMin":4,"tierMax":8,"res":[{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":8},{"code":"ARTEFACT_SHOES_CLOTH_AVALON","en":"Sanctified Bindings","pt":"Ligaduras Santificadas","qty":1}]},{"family":"SHOES_CLOTH_FEY","en":"Feyscale Sandals","pt":"Sandálias Feéricas","tierMin":4,"tierMax":8,"res":[{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":8},{"code":"ARTEFACT_SHOES_CLOTH_FEY","en":"Fey Dragonscales","pt":"Escamas Feéricas","qty":1}]},{"family":"SHOES_CLOTH_HELL","en":"Fiend Sandals","pt":"Sandálias Malévolas","tierMin":4,"tierMax":8,"res":[{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":8},{"code":"ARTEFACT_SHOES_CLOTH_HELL","en":"Infernal Cloth Bindings","pt":"Ataduras de Tecido Infernal","qty":1}]},{"family":"SHOES_CLOTH_KEEPER","en":"Druid Sandals","pt":"Sandálias de Druida","tierMin":4,"tierMax":8,"res":[{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":8},{"code":"ARTEFACT_SHOES_CLOTH_KEEPER","en":"Druidic Bindings","pt":"Ataduras Druídicas","qty":1}]},{"family":"SHOES_CLOTH_MORGANA","en":"Cultist Sandals","pt":"Sandálias Sectárias","tierMin":4,"tierMax":8,"res":[{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":8},{"code":"ARTEFACT_SHOES_CLOTH_MORGANA","en":"Alluring Bindings","pt":"Ataduras Fascinantes","qty":1}]},{"family":"SHOES_CLOTH_SET1","en":"Scholar Sandals","pt":"Sandálias de Erudito","tierMin":2,"tierMax":8,"res":[{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":8}]}]},{"group":"leather_shoes","label":{"en":"Leather Shoes","pt":"Sapatos de Couro"},"city":"Lymhurst","variants":[{"family":"SHOES_LEATHER_AVALON","en":"Shoes of Tenacity","pt":"Sapatos da Tenacidade","tierMin":4,"tierMax":8,"res":[{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":8},{"code":"ARTEFACT_SHOES_LEATHER_AVALON","en":"Augured Fasteners","pt":"Botas Auguradas","qty":1}]},{"family":"SHOES_LEATHER_FEY","en":"Mistwalker Shoes","pt":"Sapatos de Andarilho da Névoa","tierMin":4,"tierMax":8,"res":[{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":8},{"code":"ARTEFACT_SHOES_LEATHER_FEY","en":"Griffin Underfur","pt":"Penugem de Grifo","qty":1}]},{"family":"SHOES_LEATHER_HELL","en":"Hellion Shoes","pt":"Sapatos Inferiais","tierMin":4,"tierMax":8,"res":[{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":8},{"code":"ARTEFACT_SHOES_LEATHER_HELL","en":"Demonhide Bindings","pt":"Ataduras de Pele Demoníaca","qty":1}]},{"family":"SHOES_LEATHER_MORGANA","en":"Stalker Shoes","pt":"Sapatos de Espreitador","tierMin":4,"tierMax":8,"res":[{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":8},{"code":"ARTEFACT_SHOES_LEATHER_MORGANA","en":"Imbued Soles","pt":"Solas Imbuídas","qty":1}]},{"family":"SHOES_LEATHER_SET1","en":"Mercenary Shoes","pt":"Sapatos de Mercenário","tierMin":1,"tierMax":8,"res":[{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":8}]},{"family":"SHOES_LEATHER_UNDEAD","en":"Specter Shoes","pt":"Sapatos Espectrais","tierMin":4,"tierMax":8,"res":[{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":8},{"code":"ARTEFACT_SHOES_LEATHER_UNDEAD","en":"Ghastly Bindings","pt":"Ataduras Sinistras","qty":1}]}]},{"group":"plate_shoes","label":{"en":"Plate Boots","pt":"Botas de Placas"},"city":"Martlock","variants":[{"family":"SHOES_PLATE_AVALON","en":"Boots of Valor","pt":"Botas da Bravura","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":8},{"code":"ARTEFACT_SHOES_PLATE_AVALON","en":"Exalted Greave","pt":"Perneira Elevada","qty":1}]},{"family":"SHOES_PLATE_FEY","en":"Duskweaver Boots","pt":"Botas de Tecelão do Crepúsculo","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":8},{"code":"ARTEFACT_SHOES_PLATE_FEY","en":"Veilweaver Claws","pt":"Garras da Tecelã","qty":1}]},{"family":"SHOES_PLATE_HELL","en":"Demon Boots","pt":"Botas Demônias","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":8},{"code":"ARTEFACT_SHOES_PLATE_HELL","en":"Demonic Filling","pt":"Preenchimento Demoníaco","qty":1}]},{"family":"SHOES_PLATE_KEEPER","en":"Judicator Boots","pt":"Botas Judicantes","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":8},{"code":"ARTEFACT_SHOES_PLATE_KEEPER","en":"Inscribed Bindings","pt":"Ataduras Inscritas","qty":1}]},{"family":"SHOES_PLATE_SET1","en":"Soldier Boots","pt":"Botas de Soldado","tierMin":2,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":8}]},{"family":"SHOES_PLATE_UNDEAD","en":"Graveguard Boots","pt":"Botas de Guarda-tumbas","tierMin":4,"tierMax":8,"res":[{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":8},{"code":"ARTEFACT_SHOES_PLATE_UNDEAD","en":"Ancient Bindings","pt":"Ataduras Ancestrais","qty":1}]}]},{"group":"bag","label":{"en":"Bag","pt":"Bolsa"},"city":"Brecilien","variants":[{"family":"BAG","en":"Bag","pt":"Bolsa","tierMin":2,"tierMax":8,"res":[{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":8},{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":8}]}]},{"group":"cape","label":{"en":"Cape","pt":"Capa"},"city":"Brecilien","variants":[{"family":"CAPE","en":"Cape","pt":"Capa","tierMin":2,"tierMax":8,"res":[{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":4},{"code":"LEATHER","en":"Worked Leather","pt":"Couro Trabalhado","qty":4}]}]},{"group":"furniture","label":{"en":"Furniture & Other","pt":"Móveis e Outros"},"city":null,"variants":[{"family":"FURNITUREITEM_BED","en":"Bed","pt":"Cama","tierMin":2,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":10},{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":20}]},{"family":"FURNITUREITEM_CHEST","en":"Chest","pt":"Baú","tierMin":2,"tierMax":5,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":20},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":10}]},{"family":"FURNITUREITEM_TABLE","en":"Table","pt":"Mesa","tierMin":2,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":30},{"code":"CLOTH","en":"Fine Cloth","pt":"Tecido Fino","qty":30}]},{"family":"FURNITUREITEM_REPAIRKIT","en":"Repair Kit","pt":"Kit de Reparo","tierMin":4,"tierMax":8,"res":[{"code":"PLANKS","en":"Pine Planks","pt":"Tábuas de Pinho","qty":8},{"code":"METALBAR","en":"Steel Bar","pt":"Barra de Aço","qty":8}]}]}];

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
  const useLiveNats = USE_NATS && req.query.liveNats === 'true';

  if (!CITIES.includes(buyCity)) return res.status(400).json({ status: 'invalid_buy_city' });
  const sellCities = parseSellCities(req, buyCity);
  if (sellCities.error) return res.status(400).json({ status: 'invalid_sell_city', invalid: sellCities.error });
  if (sellCities.length === 0) return res.status(400).json({ status: 'no_sell_cities' });
  const categories = parseCategories(req);
  if (categories.error) return res.status(400).json({ status: 'invalid_category', invalid: categories.error });

  const cacheKey = JSON.stringify({ categories, includeEnchanted, includeQualities, buyCity, sellCities, region, useLiveNats });
  const cached = opportunityCache.get(cacheKey);
  if (cached && Date.now() - cached.at < OPP_CACHE_TTL_MS) {
    return res.json(cached.payload);
  }

  const items = buildItemList(categories, includeEnchanted);
  if (items.length === 0) return res.json({ status: 'no_items', opportunities: [] });

  const ids = items.map((it) => it.id);
  const data = await fetchPricesInBatches(ids, qualities, region);

  const byItem = {};
  data.forEach((row) => {
    if (!byItem[row.item_id]) byItem[row.item_id] = {};
    if (!byItem[row.item_id][row.city]) byItem[row.item_id][row.city] = {};
    byItem[row.item_id][row.city][row.quality] = row;
  });

  const opportunities = [];
  items.forEach((it) => {
    const byCity = byItem[it.id];
    qualities.forEach((q) => {
      const restOrigin = byCity && byCity[buyCity] && byCity[buyCity][q];
      const natsOrigin = useLiveNats ? natsClient.bestPrices(it.id, buyCity, q, region) : { sellMin: null, buyMax: null };
      const buyLive = natsOrigin.sellMin != null && natsOrigin.sellMin > 0;
      const buyCost = buyLive ? natsOrigin.sellMin : (restOrigin ? restOrigin.sell_price_min : null);
      if (!buyCost || buyCost <= 0) return;

      sellCities.forEach((sellCity) => {
        const restDest = byCity && byCity[sellCity] && byCity[sellCity][q];
        const natsDest = useLiveNats ? natsClient.bestPrices(it.id, sellCity, q, region) : { sellMin: null, buyMax: null };
        const sellLive = natsDest.buyMax != null && natsDest.buyMax > 0;
        const sellPrice = sellLive ? natsDest.buyMax : (restDest ? restDest.buy_price_max : null);
        if (sellPrice && sellPrice > buyCost) {
          const profit = sellPrice - buyCost;
          opportunities.push({
            id: it.id, quality: q, en: it.en, pt: it.pt,
            buyCost, destCity: sellCity, sellPrice,
            profit, pct: profit / buyCost * 100,
            buyCostDate: buyLive ? null : (restOrigin && restOrigin.sell_price_min_date) || null,
            sellPriceDate: sellLive ? null : (restDest && restDest.buy_price_max_date) || null,
            buyLive, sellLive
          });
        }
      });
    });
  });

  opportunities.sort((a, b) => b.profit - a.profit);
  const top = opportunities.slice(0, 60);
  if (top.length > 0) await attachVolume24h(top, region);

  const payload = {
    status: top.length ? 'ok' : 'no_opportunities',
    dataCount: data.length,
    natsStatus: USE_NATS ? natsClient.status()[region] : null,
    opportunities: top
  };
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
    encodeURIComponent(ALL_LOCATIONS.join(',')) + '&qualities=1&time-scale=24&date=' + fmt(start) + '&end_date=' + fmt(end);

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

// The 5 base refined materials get a genuinely different name per tier (not
// just an honorific prefix like equipment/artifacts do), so they need their
// own per-tier lookup instead of reusing one static label.
const MATERIAL_NAMES = {
  METALBAR: {
    2: ['Copper Bar', 'Barra de Cobre'], 3: ['Bronze Bar', 'Barra de Bronze'], 4: ['Steel Bar', 'Barra de Aço'],
    5: ['Titanium Steel Bar', 'Barra de Aço Titânio'], 6: ['Runite Steel Bar', 'Barra de Aço Runita'],
    7: ['Meteorite Steel Bar', 'Barra de Aço Meteorito'], 8: ['Adamantium Steel Bar', 'Barra de Aço de Adamante']
  },
  PLANKS: {
    2: ['Birch Planks', 'Tábuas de Bétula'], 3: ['Chestnut Planks', 'Tábuas de Castanheira'], 4: ['Pine Planks', 'Tábuas de Pinho'],
    5: ['Cedar Planks', 'Tábuas de Cedro'], 6: ['Bloodoak Planks', 'Tábuas de Carvalho-sangue'],
    7: ['Ashenbark Planks', 'Tábuas de Freixo'], 8: ['Whitewood Planks', 'Tábuas de Pau-branco']
  },
  CLOTH: {
    2: ['Simple Cloth', 'Tecido Simples'], 3: ['Neat Cloth', 'Tecido Limpo'], 4: ['Fine Cloth', 'Tecido Fino'],
    5: ['Ornate Cloth', 'Tecido Ornado'], 6: ['Lavish Cloth', 'Tecido Rico'],
    7: ['Opulent Cloth', 'Tecido Opulento'], 8: ['Baroque Cloth', 'Tecido Barroco']
  },
  LEATHER: {
    2: ['Stiff Leather', 'Couro Esticado'], 3: ['Thick Leather', 'Couro Grosso'], 4: ['Worked Leather', 'Couro Trabalhado'],
    5: ['Cured Leather', 'Couro Curtido'], 6: ['Hardened Leather', 'Couro Endurecido'],
    7: ['Reinforced Leather', 'Couro Reforçado'], 8: ['Fortified Leather', 'Couro Fortificado']
  },
  STONEBLOCK: {
    2: ['Limestone Block', 'Bloco de Calcário'], 3: ['Sandstone Block', 'Bloco de Arenito'], 4: ['Travertine Block', 'Bloco de Travertino'],
    5: ['Granite Block', 'Bloco de Granito'], 6: ['Slate Block', 'Bloco de Ardósia'],
    7: ['Basalt Block', 'Bloco de Basalto'], 8: ['Marble Block', 'Bloco de Mármore']
  }
};

function resourceNameForTier(code, tier, fallbackEn, fallbackPt) {
  const perTier = MATERIAL_NAMES[code] && MATERIAL_NAMES[code][tier];
  if (perTier) return { en: perTier[0], pt: perTier[1] };
  return { en: fallbackEn, pt: fallbackPt };
}

app.get('/api/craft-families', (req, res) => {
  res.json({
    groups: CRAFT_GROUPS.map((g) => ({
      group: g.group, label: g.label, city: g.city,
      variants: g.variants.map((v) => ({ family: v.family, en: v.en, pt: v.pt, tierMin: v.tierMin, tierMax: v.tierMax }))
    }))
  });
});

app.get('/api/craft-info', (req, res) => {
  const family = String(req.query.family || '');
  let variant = null;
  let group = null;
  for (const g of CRAFT_GROUPS) {
    const v = g.variants.find((x) => x.family === family);
    if (v) { variant = v; group = g; break; }
  }
  if (!variant) return res.status(404).json({ status: 'unknown_family' });

  const tier = parseInt(req.query.tier, 10);
  if (!tier || tier < variant.tierMin || tier > variant.tierMax) {
    return res.status(400).json({ status: 'invalid_tier', tierMin: variant.tierMin, tierMax: variant.tierMax });
  }

  const itemId = 'T' + tier + '_' + family;
  const resources = variant.res.map((r) => {
    const names = resourceNameForTier(r.code, tier, r.en, r.pt);
    return { code: r.code, id: 'T' + tier + '_' + r.code, en: names.en, pt: names.pt, qty: r.qty };
  });

  res.json({
    status: 'ok',
    family, tier, itemId, en: variant.en, pt: variant.pt,
    group: group.group, groupLabel: group.label, city: group.city,
    resources
  });
});

app.get('/api/nats-status', (req, res) => {
  res.json({ enabled: USE_NATS, regions: natsClient.status() });
});

app.listen(PORT, () => {
  console.log('Albion market backend listening on port ' + PORT);
  loadCatalog();
  if (USE_NATS) natsClient.start(REGIONS);
});