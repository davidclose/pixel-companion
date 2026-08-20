# Pixel Companion — Project Notes

A small pixel-art desktop companion that lives in five scenes (home, cafe,
work, bookstore, outside), reacts to real weather in Whitley Bay, UK, and can
hold a real conversation via a local Claude Code bridge. Originally built as
a Claude.ai artifact; moved to Claude Code so it can keep growing and run as
a real local app. Public repo: https://github.com/davidclose/pixel-companion

## Running it

Two ways to open it, depending on whether you want real AI chat:

**With real AI chat (recommended):**
```bash
cd "/Users/david/Documents/Coding Project/Ryker AI/files"
node companion-server.js
```
Then open **http://localhost:8934/** in your browser. Leave the terminal
running while you use the app.

**Offline only (no setup):**
Just double-click `pixel-companion.html`. Everything works — scenes,
weather, behavior — except chat replies are canned/keyword-matched instead
of real AI.

## How it's built

Two files, no build step, no npm install:

- **`pixel-companion.html`** — the entire app: HTML/CSS/JS in one file,
  renders to an offscreen canvas scaled up with `image-rendering: pixelated`.
  All art is drawn procedurally (`ctx.fillRect` / arcs) — no image assets,
  no sprite sheets. The canvas element is 320×240, but `ctx.scale(2,2)` is
  applied once at setup, so every `draw*` function still works in the
  original 160×120 logical coordinate space (`const W = 160, H = 120`) — the
  extra resolution just gives finer precision underneath for the outline/
  shading pass. A `PAL.outline` color + `OUTLINE` (0.5 logical units, so a
  crisp 1 real-pixel line) constant are used throughout for the
  Stardew-Valley-style dark borders around buildings, furniture, and the
  character; `paneCross(x,y,w,h)` draws the cross-mullion divider on
  windows.
- **`companion-server.js`** — an optional local Node server (stdlib only,
  zero dependencies). Does two jobs: serves `pixel-companion.html` itself
  over HTTP, and answers `POST /chat` by shelling out to the Claude Code CLI.

### Render loop & behavior

- A single `state` object holds current weather, location, transition flag,
  and a tick counter. Redrawn every ~180ms via `setInterval` — no diffing,
  the whole canvas just repaints each tick.
- Five scene functions (`drawHome`, `drawCafe`, `drawWork`, `drawBookstore`,
  `drawOutside`) each take `(tick, weatherState, isDay)` and draw their
  background, then `drawCharacter(x, y, frame, seated, facingLeft)` draws
  him on top. Adding a location means: a `draw*` function, an entry in
  `LOCATIONS`, a case in `render()`'s if/else chain for placement, an entry
  in `SPEECH`, and a weight in `preferredLocations()`.
- The outside scene now shows four buildings side-by-side (house, bookstore,
  cafe, work) sharing one narrow path — the layout is hand-tuned pixel
  coordinates with no margin to spare, so adding a fifth exterior building
  would need re-spacing the whole row rather than just appending one.
- A weighted rule table (`preferredLocations()`) picks where he'd rather be
  based on weather + time of day (bookstore weighted into rainy/foggy/cloudy
  as a cosy indoor option); a 45s timer rerolls it if idle, or the "Nudge
  him" button forces a reroll. Moving between locations always plays a
  walk-across-outside animation, regardless of actual origin/destination
  (kept simple on purpose).
- Weather comes from `https://api.open-meteo.com/v1/forecast` for Whitley
  Bay (55.0393, -1.4472), refreshed every 30 minutes, mapped from WMO codes
  to six states (sunny/cloudy/foggy/rainy/snowy/night — night is a flag on
  top of the other five, from the API's `is_day`, not a separate code).

### Chat: two backends, one UI

`sendChat()` in `pixel-companion.html` always tries the local bridge first,
then falls back automatically:

1. **POST `/chat`** to the same origin (relative URL, so it only resolves
   when served via `companion-server.js`, not when opened as a raw file).
2. On any failure — server not running, timeout, network error — falls back
   to `localReply()`, a keyword-matched canned-reply table (`CHAT_REPLIES`)
   layered over the existing weather/location `SPEECH` pool used for idle
   speech bubbles. A one-time system message notes the fallback (tracked via
   `state.bridgeAvailable` so it doesn't repeat every message).

On the server side, `askClaude()` runs:
```
claude -p "<message>" --system-prompt "<character persona>" \
  --output-format json --no-session-persistence --tools "" [--allowedTools "WebSearch"]
```
from a neutral temp directory (so it doesn't pick up this project's own
`CLAUDE.md`/memory as context). Because `claude` here is authenticated via
whatever you're logged into Claude Code with — your subscription, not
`ANTHROPIC_API_KEY` — replies draw on the subscription's usage rather than
separate per-token billing.

**Web search is keyword-gated**, not always-on: `needsWebSearch()` checks
the message for trigger words (news, today, latest, score, search, etc.).
Enabling any tool at all pulls in a much larger default context on the
first call in a while — real overhead (roughly $0.002 → $0.02-0.05
equivalent per message, more on a cold cache) — so plain chit-chat stays on
the cheap no-tools path and only search-flavoured questions pay for it. The
system prompt also tells it never to append a "Sources:"/link list, since
the chat log renders plain escaped text with no markdown support.

## Known gotchas

- **Open the app via `http://localhost:8934/`, not the `.html` file**, if
  you want real chat. Safari (and possibly other browsers) block `fetch()`
  from a `file://` page to `http://localhost` outright — no CORS header can
  override it, since the restriction is on `file://` as the *origin*, not
  on the target. `companion-server.js` serves the HTML itself specifically
  so the page and the API share an origin.
- **`node companion-server.js` must be run from inside the project
  folder** — `cd` there first, or Node can't find the file.
- **The `claude` CLI needs to actually be on `PATH`** in whatever terminal
  you run the server from. If a fresh install still isn't found, check
  where your shell's rc file (e.g. `~/.zshrc`) put it — it's commonly a
  symlink under `~/.local/bin/claude`.
- Port 8934 is hardcoded. If something else is already using it, the server
  will fail to start with `EADDRINUSE` — find and stop whatever's holding
  the port, or change `PORT` in `companion-server.js`.

## Ideas discussed for next steps

- Wider range of animated expressions/moods reacting to conversation tone.
- Idle animations / small gestures (wave, nod) for extra life.
- Possible longer-term shape: same trajectory as the bearded dragon buddy
  project — Electron app with always-on-top + system tray, if that's the
  direction (worth confirming before committing to it).

## Files

- `pixel-companion.html` — the app itself.
- `companion-server.js` — optional local chat bridge + static server.
