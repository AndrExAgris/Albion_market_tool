const { connect } = require('nats');

// Region -> NATS port (same host, different port per
// https://www.albion-online-data.com/developer)
const REGION_PORTS = { west: 4222, east: 24222, europe: 34222 };
const REGIONS = Object.keys(REGION_PORTS);

// Location IDs from formatted/world.txt in ao-data/ao-bin-dumps. Each city
// has a "city/zone" id and a separate "market building" id — live traffic
// confirmed at least Caerleon reports under the CITY id (3003) rather than
// the market id (3005), so both are mapped here for every city to maximize
// coverage. No collision risk: every numeric id below belongs to exactly
// one city.
const LOCATION_MAP = {
  0: 'Thetford', 7: 'Thetford',
  1000: 'Lymhurst', 1002: 'Lymhurst',
  2000: 'Bridgewatch', 2004: 'Bridgewatch',
  3003: 'Caerleon', 3005: 'Caerleon',
  3004: 'Martlock', 3008: 'Martlock',
  4000: 'Fort Sterling', 4002: 'Fort Sterling',
  5000: 'Brecilien', 5001: 'Brecilien', 5003: 'Brecilien'
};

// One independent state bucket per region.
const state = {};
REGIONS.forEach((r) => {
  state[r] = {
    connected: false,
    orderBook: new Map(), // orderId -> { itemId, city, quality, price, auction, expiresAt }
    byKey: new Map(), // "itemId|city|quality" -> Map(orderId -> order)  (fast lookup index)
    unknownLocationCounts: new Map(),
    perCityMessageCounts: new Map(),
    messageCount: 0,
    lastMessageAt: null
  };
});

function keyOf(order) {
  return order.itemId + '|' + order.city + '|' + order.quality;
}

function removeFromIndex(s, orderId, oldOrder) {
  if (!oldOrder) return;
  const bucket = s.byKey.get(keyOf(oldOrder));
  if (bucket) {
    bucket.delete(orderId);
    if (bucket.size === 0) s.byKey.delete(keyOf(oldOrder));
  }
}

function addToIndex(s, orderId, order) {
  const key = keyOf(order);
  let bucket = s.byKey.get(key);
  if (!bucket) { bucket = new Map(); s.byKey.set(key, bucket); }
  bucket.set(orderId, order);
}

function normalizeAuctionType(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  if (s.indexOf('offer') !== -1) return 'offer'; // sell order -> contributes to sell_price_min
  if (s.indexOf('request') !== -1) return 'request'; // buy order -> contributes to buy_price_max
  return null;
}

function ingestOrder(region, o) {
  const s = state[region];
  if (!o || !o.ItemTypeId || o.LocationId === undefined) return;
  const city = LOCATION_MAP[o.LocationId];
  if (!city) {
    s.unknownLocationCounts.set(o.LocationId, (s.unknownLocationCounts.get(o.LocationId) || 0) + 1);
    return;
  }
  const auction = normalizeAuctionType(o.AuctionType);
  if (!auction || !o.UnitPriceSilver || o.UnitPriceSilver <= 0) return;

  const parsedExpires = o.Expires ? Date.parse(o.Expires) : NaN;
  const expiresAt = Number.isNaN(parsedExpires) ? Date.now() + 24 * 3600 * 1000 : parsedExpires;

  const order = {
    itemId: o.ItemTypeId,
    city,
    quality: o.QualityLevel || 1,
    price: o.UnitPriceSilver,
    auction,
    expiresAt
  };

  const oldOrder = s.orderBook.get(o.Id);
  if (oldOrder) removeFromIndex(s, o.Id, oldOrder);
  s.orderBook.set(o.Id, order);
  addToIndex(s, o.Id, order);

  s.messageCount++;
  s.lastMessageAt = new Date();
  s.perCityMessageCounts.set(city, (s.perCityMessageCounts.get(city) || 0) + 1);
}

function pruneExpired(region) {
  const s = state[region];
  const now = Date.now();
  for (const [id, order] of s.orderBook) {
    if (order.expiresAt < now) {
      removeFromIndex(s, id, order);
      s.orderBook.delete(id);
    }
  }
}

async function startRegion(region) {
  const port = REGION_PORTS[region];
  try {
    const nc = await connect({
      servers: 'nats.albion-online-data.com:' + port,
      user: 'public',
      pass: 'thenewalbiondata',
      reconnect: true,
      maxReconnectAttempts: -1
    });
    state[region].connected = true;
    console.log('Connected to AODP NATS (' + region + ', port ' + port + ')');

    (async () => {
      const sub = nc.subscribe('marketorders.deduped');
      const decoder = new TextDecoder();
      for await (const msg of sub) {
        try {
          const text = decoder.decode(msg.data);
          const payload = JSON.parse(text);
          const orders = Array.isArray(payload) ? payload : (payload.Orders ? payload.Orders : [payload]);
          orders.forEach((o) => ingestOrder(region, o));
        } catch (e) {
          // ignore malformed / unexpected message shapes
        }
      }
    })();

    nc.closed().then((err) => {
      state[region].connected = false;
      console.warn('NATS connection closed (' + region + ')' + (err ? ': ' + err.message : ''));
    });

    setInterval(() => pruneExpired(region), 5 * 60 * 1000);
  } catch (e) {
    state[region].connected = false;
    console.error('NATS connect failed (region ' + region + '):', e.message);
  }
}

async function start(regions) {
  const list = regions && regions.length ? regions : REGIONS;
  await Promise.all(list.map(startRegion));
}

function bestPrices(itemId, city, quality, region) {
  const s = state[region] || state.west;
  const bucket = s.byKey.get(itemId + '|' + city + '|' + quality);
  if (!bucket || bucket.size === 0) return { sellMin: null, buyMax: null };

  let sellMin = null;
  let buyMax = null;
  const now = Date.now();
  for (const order of bucket.values()) {
    if (order.expiresAt < now) continue;
    if (order.auction === 'offer') {
      if (sellMin === null || order.price < sellMin) sellMin = order.price;
    } else if (order.auction === 'request') {
      if (buyMax === null || order.price > buyMax) buyMax = order.price;
    }
  }
  return { sellMin, buyMax };
}

function status() {
  const out = {};
  REGIONS.forEach((r) => {
    const s = state[r];
    out[r] = {
      connected: s.connected,
      orderCount: s.orderBook.size,
      messageCount: s.messageCount,
      lastMessageAt: s.lastMessageAt,
      perCityMessageCounts: Object.fromEntries(s.perCityMessageCounts),
      unknownLocations: Object.fromEntries(s.unknownLocationCounts)
    };
  });
  return out;
}

module.exports = { start, bestPrices, status, REGIONS, LOCATION_MAP };