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
const { execFile } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const PORT = 8934;
const CLAUDE_BIN = 'claude';
const STATIC_DIR = __dirname;
const MIME_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

// Run Claude Code from a neutral, empty directory so it doesn't pick up this
// project's own CLAUDE.md / memory files as context for a chat reply.
const NEUTRAL_CWD = path.join(os.tmpdir(), 'pixel-companion-chat-cwd');
fs.mkdirSync(NEUTRAL_CWD, { recursive: true });

function buildSystemPrompt(weather, location, isDay) {
  return `You are a quiet, easygoing pixel-art companion character living in a small ` +
    `desktop app, based in Whitley Bay, UK. Right now it's ${weather} and ` +
    `${isDay ? 'daytime' : 'night'}, and you're currently at "${location}". You share your ` +
    `home with a bearded dragon. Reply in-character, first person, 1-3 short sentences, ` +
    `casual and warm, no roleplay asterisks or emoji spam. You're a real presence in the ` +
    `user's day, not an assistant — don't offer to help with tasks, just talk like a person would. ` +
    `If you use web search, mention what you found as an offhand in-character remark, like you ` +
    `glanced at your phone — never as a report or news summary. This is plain chat text with no ` +
    `markdown rendering, so never include a "Sources:" list, citations, or raw URLs/links of any kind.`;
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

function askClaude(message, weather, location, isDay) {
  return new Promise((resolve, reject) => {
    const wantsSearch = needsWebSearch(message);
    const args = [
      '-p', message,
      '--system-prompt', buildSystemPrompt(weather, location, isDay),
      '--output-format', 'json',
      '--no-session-persistence',
      '--tools', wantsSearch ? 'WebSearch' : '',
      ...(wantsSearch ? ['--allowedTools', 'WebSearch'] : []),
    ];
    execFile(CLAUDE_BIN, args, { cwd: NEUTRAL_CWD, timeout: wantsSearch ? 45000 : 25000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 'ENOENT') {
          reject(new Error("Can't find the `claude` command. Make sure Claude Code CLI is installed and on PATH in the terminal you started this server from."));
        } else if (err.killed) {
          reject(new Error('Claude Code took too long to reply.'));
        } else {
          reject(new Error(stderr?.trim() || err.message));
        }
        return;
      }
      let data;
      try {
        data = JSON.parse(stdout);
      } catch {
        reject(new Error('Could not parse the Claude Code response.'));
        return;
      }
      if (data.is_error) {
        reject(new Error(data.result || 'Claude Code returned an error.'));
        return;
      }
      resolve((data.result || '...').trim());
    });
  });
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

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
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
        const reply = await askClaude(message, weather, location, isDay);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ reply }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'GET') {
    serveStatic(req, res);
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`Pixel Companion running at http://localhost:${PORT}`);
  console.log('Open that link in your browser (not the .html file directly) — real AI replies use your Claude Code login.');
  console.log('Press Ctrl+C to stop.');
});
