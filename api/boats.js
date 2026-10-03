// Pixel Companion on the web: GET /boats (vercel.json rewrites it to here).
//
// The desktop app keeps one connection to aisstream open all day and always
// knows what's out there. A serverless function can't do that: it runs for a
// few seconds and stops. So each request opens the stream, listens briefly,
// and returns whichever ships reported in that window, marked `partial`. The
// page remembers ships across requests and builds the full picture itself.
// While this instance stays warm its own memory helps too.
//
// Needs AISSTREAM_API_KEY set in the Vercel project's environment variables.
// The key never reaches the browser.
//
// Set SITE_PASSCODE there too and the feed is closed to anyone without it
// (sent as an `x-passcode` header, the same scheme as the North Shore
// dashboard). Without SITE_PASSCODE the feed is open, as it was.

const crypto = require('crypto');
const boats = require('../boat-source.js');
boats.seed(require('../vessel-seed.json'));

const WRONG_PASSCODE_DELAY_MS = 1000;   // slows down guessing

// Compared as hashes in constant time, so the response time says nothing
// about how close a guess was.
function passcodeOk(given){
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(process.env.SITE_PASSCODE || '').digest();
  return crypto.timingSafeEqual(a, b);
}

const LISTEN_MS = 15000;   // long enough to catch a fair share of reports; the page asks again soon after

function listen(apiKey){
  return new Promise((resolve) => {
    let frames = 0, error = null, done = false, ws;
    const finish = () => {
      if (done) return;
      done = true;
      try { ws && ws.close(); } catch { /* already closed */ }
      resolve({ frames, error });
    };
    const timer = setTimeout(finish, LISTEN_MS);
    try { ws = new WebSocket(boats.STREAM_URL); } catch (e) { clearTimeout(timer); resolve({ frames, error: e.message }); return; }
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        APIKey: apiKey,
        BoundingBoxes: [boats.BOUNDING_BOX],
        FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
      }));
    });
    ws.addEventListener('message', (ev) => {
      const text = boats.frameToText(ev.data);
      if (text === null) return;
      if (text.startsWith('Error') || text.includes('Invalid API key')) { error = text.slice(0, 200); return; }
      frames++;
      boats.ingest(text);
    });
    ws.addEventListener('error', () => { if (!error) error = 'Could not reach aisstream.io.'; });
    ws.addEventListener('close', () => {
      if (!frames && !error) error = 'aisstream.io closed the connection before sending any data (check the API key).';
      clearTimeout(timer);
      finish();
    });
  });
}

module.exports = async (req, res) => {
  const gated = Boolean(process.env.SITE_PASSCODE);
  if (gated && !passcodeOk(req.headers['x-passcode'])) {
    await new Promise((r) => setTimeout(r, WRONG_PASSCODE_DELAY_MS));
    res.setHeader('Cache-Control', 'no-store');
    res.status(401).json({ error: 'passcode' });
    return;
  }
  const apiKey = boats.loadApiKey();
  if (!apiKey) {
    res.status(200).json({ ok: false, partial: true, connected: false, error: 'No aisstream API key configured.', boats: [] });
    return;
  }
  const heard = await listen(apiKey);
  const snap = boats.getBoats(40);
  // Open feed: shared between visitors for a few seconds, so several people
  // watching don't each open their own connection. Behind a passcode it must
  // never be cached by the CDN, or the cache would hand it to anyone.
  res.setHeader('Cache-Control', gated ? 'private, no-store' : 'public, s-maxage=10');
  res.status(200).json({ ok: snap.boats.length > 0, partial: true, connected: heard.frames > 0,
    error: heard.error, frames: heard.frames, boats: snap.boats });
};
