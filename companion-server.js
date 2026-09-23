#!/usr/bin/env node
// Pixel Companion — local chat bridge + static server.
//
// Runs a tiny HTTP server on your machine that both serves pixel-companion.html
// itself AND answers its chat requests. It shells out to the Claude Code CLI
// (`claude -p ...`), which uses whatever auth you're logged into Claude Code
// with — if that's your Claude subscription, replies draw from your plan's
// usage rather than a separately billed API key.
//
// Why serve the HTML too: Safari (and some other browsers) block fetch()
// calls from a file:// page to http://localhost as a security restriction —
// no CORS header can override it. Opening the app at http://localhost:8934/
// instead of double-clicking the file sidesteps that entirely.
//
// Usage:
//   node companion-server.js
// Then open http://localhost:8934/ in your browser (not the HTML file
// directly). Leave the server running while you use the app. Requires the
// `claude` CLI to be installed and on PATH in the terminal you run this from.

const http = require('http');
const { execFile, execFileSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const boats = require('./boat-source.js');

// Override with PIXEL_COMPANION_PORT if something else already holds 8934.
const PORT = Number(process.env.PIXEL_COMPANION_PORT) || 8934;
const STATIC_DIR = __dirname;
const MIME_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

// GUI apps launched by double-click (e.g. from a packaged Electron app) get a
// minimal PATH that usually doesn't include ~/.local/bin or Homebrew's bin —
// unlike a terminal, which sources your shell's rc file. Resolve `claude`'s
// real location up front so chat still works when launched that way.
function resolveClaudeBin(){
  try {
    return execFileSync('which', ['claude'], { encoding: 'utf8' }).trim() || 'claude';
  } catch {
    const candidates = [
      path.join(os.homedir(), '.local/bin/claude'),
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      path.join(os.homedir(), '.claude/local/claude'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return 'claude'; // give up — will surface as a clear "can't find claude" error
  }
}
const CLAUDE_BIN = resolveClaudeBin();

// Which model answers chat. Pinned rather than left to the CLI's default, so
// his voice doesn't shift whenever Claude Code changes what it defaults to.
// Override with PIXEL_COMPANION_MODEL (set it to an empty string to go back to
// the CLI default). Opus 5.5 can't switch thinking off, so effort is the
// latency lever: 1-3 sentence small talk runs at low; search questions, which
// need a little judgement about what's worth mentioning, at medium.
const CHAT_MODEL = process.env.PIXEL_COMPANION_MODEL ?? 'claude-opus-5-5';
const EFFORT = { chat: 'low', search: 'medium' };
// Flipped if the installed CLI turns out not to know CHAT_MODEL (an older
// Claude Code predates newer models) — chat then carries on with the CLI's
// default for the rest of this run instead of failing every message.
let modelPinDisabled = false;

// Run Claude Code from a neutral, empty directory so it doesn't pick up this
// project's own CLAUDE.md / memory files as context for a chat reply.
const NEUTRAL_CWD = path.join(os.tmpdir(), 'pixel-companion-chat-cwd');
fs.mkdirSync(NEUTRAL_CWD, { recursive: true });

// Turn a bearing into something a person would actually say.
function compass(deg){
  const names = ['due north','north-east','east','south-east','due south','south-west','west','north-west'];
  return names[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

// A short, plain-language description of what's actually out on the water, so
// he can talk about the ships he can see. Deliberately compact: this rides
// along on every chat message.
function describeBoats(){
  let snap;
  try { snap = boats.getBoats(6); } catch { return ''; }
  if (!snap.ok || !snap.boats.length) return '';

  const lines = snap.boats.map((b) => {
    const bits = [b.name];
    if (b.category && b.category !== 'unknown' && b.category !== 'other') bits.push(`a ${b.category} vessel`);
    if (b.lengthM) bits.push(`${b.lengthM}m long`);
    bits.push(`${b.distanceKm}km ${compass(b.bearing)}`);
    bits.push(b.moving ? `under way at ${b.speedKts} knots` : 'stopped or at anchor');
    if (b.destination) bits.push(`destination given as "${b.destination}"`);
    return '- ' + bits.join(', ');
  });

  return `\n\nShips within sight of the beach right now, from their live AIS ` +
    `transponders:\n${lines.join('\n')}\n` +
    `Destinations are AIS codes, usually UN/LOCODE (GBTYN is the Port of Tyne, ` +
    `GBNCL is Newcastle) — say the place name, never the code. Talk about these ` +
    `only if the user asks about the sea or ships, or if you're at the beach and ` +
    `one is worth a passing remark. Mention at most one or two, the way someone ` +
    `would nod at a ship on the horizon — never list them. This is what you can ` +
    `see, so don't say you looked it up.`;
}

const SKY_WORDS = { dawn: 'dawn', day: 'daytime', dusk: 'dusk, the sun going down', night: 'night' };
const MOON_WORDS = new Set(['new moon', 'waxing crescent', 'first quarter moon', 'waxing gibbous moon',
  'full moon', 'waning gibbous moon', 'last quarter moon', 'waning crescent']);

function buildSystemPrompt(weather, location, isDay, tide, sky, moon) {
  const when = SKY_WORDS[sky] || (isDay ? 'daytime' : 'night');
  return `You are a quiet, easygoing pixel-art companion character living in a small ` +
    `desktop app, based in Whitley Bay, UK. Right now it's ${weather} and ` +
    `${when}, and you're currently at "${location}". ` +
    (moon && MOON_WORDS.has(moon) ? `Tonight's moon is a ${moon}. ` : '') +
    (tide ? `The tide is currently: ${tide}. Mention it only if it comes up naturally. ` : '') +
    `You share your ` +
    `home with a bearded dragon. Reply in-character, first person, 1-3 short sentences, ` +
    `casual and warm, no roleplay asterisks or emoji spam. You're a real presence in the ` +
    `user's day, not an assistant — don't offer to help with tasks, just talk like a person would. ` +
    `If you use web search, mention what you found as an offhand in-character remark, like you ` +
    `glanced at your phone — never as a report or news summary. This is plain chat text with no ` +
    `markdown rendering, so never include a "Sources:" list, citations, or raw URLs/links of any kind.` +
    describeBoats();
}

// Enabling any tool (even just web search) pulls in a much larger default
// context on the first call in a while — real per-call cost, cached for an
// hour after. Most chat ("hey", "how's it going") never needs live info, so
// only pay that cost when the message actually looks like it needs it.
const SEARCH_TRIGGERS = [
  'news', 'headline', 'today', 'happening', 'happened', 'current event',
  'latest', 'score', 'who won', 'result', 'stock', 'price of', 'election',
  'weather forecast', 'search', 'look up', 'google', "what's on",
];
function needsWebSearch(message) {
  const lower = message.toLowerCase();
  return SEARCH_TRIGGERS.some((k) => lower.includes(k));
}

// Failures carry a `reason` the page can act on — "log in again" is a very
// different message from "that took too long".
function chatError(reason, message){
  const e = new Error(message);
  e.reason = reason;
  return e;
}

// The CLI can print warning lines (e.g. `[claude-code:unrecognized_model] ...`)
// on stdout ahead of the JSON result, so a plain JSON.parse(stdout) fails on
// output that's actually fine. Take the last line that parses as an object.
function parseCliJson(stdout){
  const lines = String(stdout || '').trim().split('\n').reverse();
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { return JSON.parse(t); } catch { /* keep looking */ }
  }
  return null;
}

function classifyFailure(text){
  const t = String(text || '');
  if (/authenticat|oauth|log ?in|logged ?in|credential|unauthori[sz]ed|\b401\b/i.test(t)) return 'auth';
  if (/unrecognized_model|unknown model|model.*not (found|available|supported)/i.test(t)) return 'model';
  return 'other';
}

function runClaude(args, timeoutMs){
  return new Promise((resolve) => {
    execFile(CLAUDE_BIN, args, { cwd: NEUTRAL_CWD, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

async function askClaude(message, weather, location, isDay, tide, sky, moon) {
  const wantsSearch = needsWebSearch(message);
  const baseArgs = [
    '-p', message,
    '--system-prompt', buildSystemPrompt(weather, location, isDay, tide, sky, moon),
    '--output-format', 'json',
    '--no-session-persistence',
    '--tools', wantsSearch ? 'WebSearch' : '',
    ...(wantsSearch ? ['--allowedTools', 'WebSearch'] : []),
  ];
  const timeoutMs = wantsSearch ? 45000 : 25000;

  const attempt = async (pinModel) => {
    const args = pinModel
      ? [...baseArgs, '--model', CHAT_MODEL, '--effort', wantsSearch ? EFFORT.search : EFFORT.chat]
      : baseArgs;
    const { err, stdout, stderr } = await runClaude(args, timeoutMs);

    if (err && err.code === 'ENOENT') {
      throw chatError('missing', "Can't find the `claude` command — is Claude Code installed?");
    }
    if (err && err.killed) {
      throw chatError('timeout', 'Claude Code took too long to reply.');
    }
    // A failed call can still exit with a perfectly good JSON explanation on
    // stdout (an expired login does exactly this), so read that before
    // falling back to stderr.
    const data = parseCliJson(stdout);
    const wasUnknownModel = pinModel && /unrecognized_model/.test(stdout + stderr);
    if (data && !data.is_error && typeof data.result === 'string' && data.result.trim()) {
      return data.result.trim();
    }
    const detail = (data && data.result) || stderr.trim() || (err && err.message) || 'Claude Code returned an error.';
    // The auth check wins over the model check: with both wrong, logging in is
    // the thing the user actually has to do.
    const reason = classifyFailure(detail);
    throw chatError(reason === 'other' && wasUnknownModel ? 'model' : reason, detail);
  };

  const pin = Boolean(CHAT_MODEL) && !modelPinDisabled;
  try {
    return await attempt(pin);
  } catch (e) {
    if (pin && e.reason === 'model') {
      modelPinDisabled = true;
      console.warn(`This Claude Code CLI doesn't recognise "${CHAT_MODEL}" — using its default model instead. ` +
        'Run `claude update` to get the newer models.');
      return attempt(false);
    }
    throw e;
  }
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/pixel-companion.html';
  const resolved = path.normalize(path.join(STATIC_DIR, urlPath));
  if (!resolved.startsWith(STATIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(resolved)] || 'application/octet-stream' });
    res.end(data);
  });
}

// Only answer requests addressed to this machine's loopback by name. A page
// can use DNS rebinding to point its own domain at 127.0.0.1 and slip past
// the browser's same-origin rules, but it can't fake the Host header its
// requests carry — so checking it is what stops a random website from using
// your Claude subscription through this server.
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

const server = http.createServer((req, res) => {
  // No CORS headers, deliberately. The page is served from this same origin,
  // so it never needs them — and `Access-Control-Allow-Origin: *` used to let
  // any website you had open call /chat and read the replies.
  if (!ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase())) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  if (req.method === 'POST' && req.url === '/chat') {
    let body = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10000) { tooBig = true; req.destroy(); }
    });
    req.on('end', async () => {
      if (tooBig) return;
      try {
        const parsed = JSON.parse(body);
        const message = typeof parsed.message === 'string' ? parsed.message.trim().slice(0, 300) : '';
        if (!message) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Empty message' }));
          return;
        }
        const weather = typeof parsed.weather === 'string' ? parsed.weather : 'unknown';
        const location = typeof parsed.location === 'string' ? parsed.location : 'home';
        const isDay = parsed.isDay !== false;
        const tide = typeof parsed.tide === 'string' ? parsed.tide.slice(0, 40) : null;
        // Both checked against fixed lists in buildSystemPrompt, never passed through raw.
        const sky = typeof parsed.sky === 'string' ? parsed.sky : null;
        const moon = typeof parsed.moon === 'string' ? parsed.moon : null;
        const reply = await askClaude(message, weather, location, isDay, tide, sky, moon);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ reply }));
      } catch (e) {
        if (e.reason !== 'auth') console.error('Chat failed:', e.reason || 'other', '-', e.message);
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message, reason: e.reason || 'other' }));
      }
    });
    return;
  }

  // Live vessel positions for the beach scene. The aisstream API key stays in
  // this process — the page only ever sees this already-filtered summary.
  if (req.method === 'GET' && req.url.split('?')[0] === '/boats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(boats.getBoats(12)));
    return;
  }

  if (req.method === 'GET') {
    serveStatic(req, res);
    return;
  }

  res.writeHead(404);
  res.end();
});

// Loopback only. Listening on every interface (the default) made /chat
// reachable by anyone on the same wifi — a café, a hotel — at this Mac's LAN
// address, spending your Claude usage.
server.listen(PORT, '127.0.0.1', () => {
  boats.start();   // no-op if no aisstream key is configured
  console.log(`Pixel Companion running at http://localhost:${PORT}`);
  console.log('Open that link in your browser (not the .html file directly) — real AI replies use your Claude Code login.');
  console.log('Press Ctrl+C to stop.');
});

module.exports = { PORT, server };
