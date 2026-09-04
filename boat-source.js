#!/usr/bin/env node
// Pixel Companion — real boat data for the beach scene.
//
// Streams live AIS (Automatic Identification System) vessel positions from
// aisstream.io for the patch of North Sea you can actually see from Whitley
// Bay, and keeps a rolling snapshot of what's out there right now.
//
// AIS is the transponder system ships legally broadcast their position on, so
// these are genuine vessels in genuine positions — the boats drawn on the sea
// in the beach scene are the ones really off the coast at that moment.
//
// Design notes:
//  - Zero dependencies, like the rest of this project. Node 22+ / Electron 43+
//    ship a global `WebSocket`, so no `ws` package is needed.
//  - aisstream requires an API key and says to keep it server-side, so it
//    lives here (in companion-server.js's process) and never reaches the page.
//    The page just polls GET /boats for an already-filtered summary.
//  - Everything degrades quietly. No key, no network, no key yet approved —
//    getBoats() just reports ok:false and the scene falls back to invented
//    boats, exactly like chat falls back to canned replies.
//
// Run it directly to check your key works:
//   node boat-source.js

const fs = require('fs');
const os = require('os');
const path = require('path');

// Whitley Bay seafront — same coordinates the weather lookup uses.
const HOME_LAT = 55.0393;
const HOME_LON = -1.4472;

// The sea you can see from the beach, plus the Tyne approaches to the south
// (Port of Tyne is busy — ferries, cargo, tugs) and Blyth to the north.
// aisstream wants [[SW lat, SW lon], [NE lat, NE lon]].
const BOUNDING_BOX = [[54.90, -1.55], [55.25, -0.90]];

const STREAM_URL = 'wss://stream.aisstream.io/v0/stream';
// Two places, checked in order. The home-directory one matters for the
// packaged .app: its bundled files live inside a read-only app.asar, so a key
// kept there would be frozen at build time and lost on every rebuild.
const CONFIG_FILES = [
  path.join(os.homedir(), '.pixel-companion', 'ais-config.json'),
  path.join(__dirname, 'ais-config.json'),
];

// A vessel that hasn't reported in this long has probably left the box.
const STALE_MS = 30 * 60 * 1000;
const MAX_VESSELS = 300;

// ---------------------------------------------------------------------------
// API key

// Env var first (nice for a terminal run), then a gitignored config file
// (needed for the packaged .app, which gets no useful environment).
function loadApiKey(){
  if (process.env.AISSTREAM_API_KEY) return process.env.AISSTREAM_API_KEY.trim();
  for (const file of CONFIG_FILES) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const key = raw && typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '';
      if (key && key !== 'PASTE_YOUR_AISSTREAM_KEY_HERE') return key;
    } catch { /* missing or malformed — treated the same as "no key" */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Geometry

function toRad(d){ return d * Math.PI / 180; }

// Great-circle distance in km.
function distanceKm(lat1, lon1, lat2, lon2){
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Compass bearing from the beach to the vessel, 0=N, 90=E.
function bearingDeg(lat1, lon1, lat2, lon2){
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
            Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// ---------------------------------------------------------------------------
// Vessel classification
//
// AIS ship-type codes are a fiddly numeric range. Collapse them into a handful
// of categories, chosen so each one can get its own pixel-art boat sprite.
function categorise(typeCode){
  const t = Number(typeCode);
  if (!Number.isFinite(t) || t <= 0) return 'unknown';
  if (t === 30) return 'fishing';
  if (t === 36) return 'sailing';
  if (t === 37) return 'pleasure';
  if (t === 31 || t === 32 || t === 52) return 'tug';
  if (t === 35) return 'military';
  if (t === 51 || t === 50 || t === 55) return 'service';   // pilot / SAR / law enforcement
  if (t >= 40 && t <= 49) return 'fast';                    // high-speed craft
  if (t >= 60 && t <= 69) return 'passenger';               // ferries, cruise
  if (t >= 70 && t <= 79) return 'cargo';
  if (t >= 80 && t <= 89) return 'tanker';
  return 'other';
}

// AIS strings are fixed-width and come back padded with spaces or '@'.
function cleanName(s){
  if (typeof s !== 'string') return '';
  return s.replace(/@+/g, '').trim();
}

// ---------------------------------------------------------------------------
// Live state

const positions = new Map();  // mmsi -> { lat, lon, sog, cog, heading, at }
const statics   = new Map();  // mmsi -> { name, type, destination, length }

let ws = null;
let connected = false;
let lastError = null;
let reconnectDelay = 5000;
let reconnectTimer = null;
let rawFrames = 0;
let messageCount = 0;
let started = false;
let everAuthed = false;   // true once real AIS data has arrived at least once

function prune(){
  const cutoff = Date.now() - STALE_MS;
  for (const [mmsi, p] of positions) {
    if (p.at < cutoff) { positions.delete(mmsi); statics.delete(mmsi); }
  }
  // Hard cap as a backstop, dropping the least recently heard from.
  if (positions.size > MAX_VESSELS) {
    const order = [...positions.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [mmsi] of order.slice(0, positions.size - MAX_VESSELS)) {
      positions.delete(mmsi); statics.delete(mmsi);
    }
  }
}

// aisstream sends its JSON over binary WebSocket frames. With
// `binaryType = 'arraybuffer'` set on the socket those arrive as an
// ArrayBuffer, which decodes synchronously; the Blob branch is a safety net
// (Blob is the default binaryType, and reading it is async).
const DECODER = new TextDecoder();
function frameToText(data){
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return DECODER.decode(data);
  if (ArrayBuffer.isView(data)) return DECODER.decode(data);
  return null;
}

function handleMessage(raw){
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  const meta = msg.MetaData || {};
  const mmsi = String(meta.MMSI || meta.MMSI_String || '');
  if (!mmsi) return;
  messageCount++;

  if (msg.MessageType === 'PositionReport') {
    const r = (msg.Message && msg.Message.PositionReport) || {};
    const lat = Number(r.Latitude ?? meta.latitude);
    const lon = Number(r.Longitude ?? meta.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    positions.set(mmsi, {
      lat, lon,
      sog: Number(r.Sog) || 0,            // speed over ground, knots
      cog: Number(r.Cog) || 0,            // course over ground, degrees
      // 511 is AIS for "heading not available" — fall back to course.
      heading: (Number(r.TrueHeading) === 511 ? null : Number(r.TrueHeading)),
      at: Date.now(),
    });
    // Names often arrive on the position message's metadata too.
    const nm = cleanName(meta.ShipName);
    if (nm && !statics.has(mmsi)) statics.set(mmsi, { name: nm, type: 0 });
    else if (nm && !statics.get(mmsi).name) statics.get(mmsi).name = nm;

  } else if (msg.MessageType === 'ShipStaticData') {
    const s = (msg.Message && msg.Message.ShipStaticData) || {};
    const dim = s.Dimension || {};
    statics.set(mmsi, {
      name: cleanName(s.Name) || cleanName(meta.ShipName) || '',
      type: Number(s.Type) || 0,
      destination: cleanName(s.Destination),
      length: (Number(dim.A) || 0) + (Number(dim.B) || 0),   // bow + stern, metres
    });
  }
}

function connect(){
  const apiKey = loadApiKey();
  if (!apiKey) {
    lastError = 'No aisstream API key configured.';
    return;
  }

  try {
    ws = new WebSocket(STREAM_URL);
  } catch (e) {
    lastError = e.message;
    scheduleReconnect();
    return;
  }

  ws.binaryType = 'arraybuffer';

  ws.addEventListener('open', () => {
    connected = true;
    lastError = null;
    reconnectDelay = 5000;   // reset backoff after a good connection
    // aisstream drops the connection if no subscription arrives within 3s.
    ws.send(JSON.stringify({
      APIKey: apiKey,
      BoundingBoxes: [BOUNDING_BOX],
      FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
    }));
  });

  ws.addEventListener('message', async (ev) => {
    rawFrames++;
    let text = frameToText(ev.data);
    if (text === null) {
      // Blob fallback — only reached if binaryType didn't take effect.
      try { text = await ev.data.text(); } catch { return; }
    }
    // An auth or subscription failure arrives as a plain-text frame, not JSON.
    if (text.startsWith('Error') || text.includes('Invalid API key')) {
      lastError = text.slice(0, 200);
      return;
    }
    everAuthed = true;
    handleMessage(text);
  });

  ws.addEventListener('error', () => {
    // The close handler does the reconnecting; this just notes that the
    // failure was at the socket level rather than a clean server close.
    if (!lastError) lastError = 'Could not reach aisstream.io.';
  });

  ws.addEventListener('close', (ev) => {
    connected = false;
    // aisstream accepts the socket first and only then validates the
    // subscription, so a bad key looks like an immediate close with no data
    // ever received. Say so plainly rather than blaming the network.
    if (!everAuthed) {
      const reason = (ev && ev.reason) ? ` (${String(ev.reason).slice(0, 120)})` : '';
      lastError = `aisstream.io closed the connection before sending any data${reason}. ` +
        `This usually means the API key is missing, wrong, or not activated yet.`;
    }
    scheduleReconnect();
  });
}

function scheduleReconnect(){
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 60000);
}

function start(){
  if (started) return;
  started = true;
  connect();
  setInterval(prune, 60000).unref?.();
}

// ---------------------------------------------------------------------------
// Public read

// A snapshot of what's out there, nearest first. `limit` keeps the payload
// small — the beach scene only has room to draw a handful of boats.
function getBoats(limit = 12){
  const out = [];
  for (const [mmsi, p] of positions) {
    const s = statics.get(mmsi) || {};
    out.push({
      mmsi,
      name: s.name || `Vessel ${mmsi.slice(-4)}`,
      category: categorise(s.type),
      lat: p.lat,
      lon: p.lon,
      distanceKm: Math.round(distanceKm(HOME_LAT, HOME_LON, p.lat, p.lon) * 10) / 10,
      bearing: Math.round(bearingDeg(HOME_LAT, HOME_LON, p.lat, p.lon)),
      speedKts: Math.round(p.sog * 10) / 10,
      course: Math.round(p.heading ?? p.cog),
      lengthM: s.length || null,
      destination: s.destination || null,
      moving: p.sog > 0.5,
      ageSec: Math.round((Date.now() - p.at) / 1000),
    });
  }
  out.sort((a, b) => a.distanceKm - b.distanceKm);
  return {
    ok: connected && out.length > 0,
    connected,
    error: lastError,
    tracking: positions.size,
    frames: rawFrames,
    messages: messageCount,
    boats: out.slice(0, limit),
  };
}

module.exports = { start, getBoats, HOME_LAT, HOME_LON, BOUNDING_BOX, categorise, distanceKm, bearingDeg };

// ---------------------------------------------------------------------------
// Direct run: connect, listen for a bit, print what's out there.

if (require.main === module) {
  const seconds = Number(process.argv[2]) || 30;
  if (!loadApiKey()) {
    console.error('No API key found.\n');
    console.error('Get a free one at https://aisstream.io (sign up, then "Create API key"),');
    console.error('then either:');
    console.error(`  mkdir -p ~/.pixel-companion`);
    console.error(`  echo '{"apiKey":"YOUR_KEY"}' > ~/.pixel-companion/ais-config.json`);
    console.error('or:  export AISSTREAM_API_KEY=YOUR_KEY');
    process.exit(1);
  }
  console.log(`Connecting to aisstream.io, listening ${seconds}s for vessels off Whitley Bay...`);
  start();
  setTimeout(() => {
    const snap = getBoats(20);
    console.log(`\nConnected: ${snap.connected} | frames: ${snap.frames} | AIS messages: ${snap.messages} | vessels tracked: ${snap.tracking}`);
    if (snap.error) console.log(`Last error: ${snap.error}`);
    if (!snap.boats.length) {
      if (!snap.frames) {
        console.log('\nNo data received at all — check the key above rather than the sea.');
      } else if (!snap.messages) {
        console.log(`\n${snap.frames} frames arrived but none parsed — that is a bug in this file,`);
        console.log('not a problem with your key or the sea.');
      } else {
        console.log('\nConnected fine, but no vessels in range yet. The sea off Whitley Bay');
        console.log('can genuinely be empty — try a longer listen:  node boat-source.js 120');
      }
    } else {
      console.log('');
      for (const b of snap.boats) {
        const dest = b.destination ? `  -> ${b.destination}` : '';
        console.log(
          `${b.name.padEnd(22)} ${b.category.padEnd(10)} ` +
          `${String(b.distanceKm).padStart(6)} km  ` +
          `${String(b.bearing).padStart(3)}deg  ` +
          `${String(b.speedKts).padStart(5)} kts${dest}`
        );
      }
    }
    process.exit(0);
  }, seconds * 1000);
}
