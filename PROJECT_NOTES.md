# Pixel Companion — Project Notes

A small pixel-art desktop companion that lives in five scenes (home, cafe,
work, bookstore, outside), reacts to real weather in Whitley Bay, UK, and can
hold a real conversation via a local Claude Code bridge. Originally built as
a Claude.ai artifact; moved to Claude Code so it can keep growing and run as
a real local app. Public repo: https://github.com/davidclose/pixel-companion

## Running it

Three ways, depending on what you want:

**Packaged desktop app (fully standalone, no terminal ever):**
```bash
cd "/Users/david/Documents/Coding Project/Ryker AI/files"
npm install   # first time only
npm run dist  # builds dist/Pixel Companion-1.0.0.dmg
```
Open the `.dmg` and drag **Pixel Companion** into Applications, same as any
other Mac app. **First launch needs a right-click → Open** (not a plain
double-click) — the build is unsigned, so Gatekeeper blocks a normal open
the first time; after that one-time approval it opens normally forever.
Rebuild after any code change — the `.app` is a frozen snapshot, it doesn't
read the source files live.

**Dev-mode desktop app (no terminal after first launch, but rebuilds aren't needed):**
```bash
cd "/Users/david/Documents/Coding Project/Ryker AI/files"
npm install   # first time only
npm start
```
Opens the same window + tray icon, running straight from source instead of
a packaged `.app` — useful while still changing the code, since there's no
rebuild step.

Both desktop modes give you a real window plus a menu-bar tray icon
(Show/Hide, Always on Top, Launch at Login, Quit). Real AI chat works the
same as the browser mode below, since it's the same `companion-server.js`
running embedded in the app.

**Browser, with real AI chat:**
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
  renders to a canvas scaled up with `image-rendering: pixelated`. All art is
  drawn procedurally (`ctx.fillRect` / arcs) — no image assets, no sprite
  sheets. **Native 320×240 logical space** (`const W = 320, H = 240`) with no
  scale transform: every draw call uses those coordinates directly, which is
  what gives the art its detail. (An earlier version drew in 160×120 and used
  `ctx.scale(2,2)`; the art was rebuilt at true 320×240 instead, so any old
  coordinates you see referenced elsewhere are roughly half these.)

  The Stardew-Valley-ish look comes from a small set of shared primitives
  rather than per-object hand-shading:
  - `shade(hex, amt)` — lighten/darken any colour, so highlights and
    shadows are derived from one base colour instead of hardcoded.
  - `bevel(x,y,w,h,base,edge)` — light top/left edge, dark bottom/right.
  - `block(x,y,w,h,base,edge)` — dark outline + bevel. The workhorse:
    almost every solid object is a `block`.
  - `blob(cx,cy,r,base,outline)` — outlined, shaded circle for organic
    shapes (foliage, heads, clouds, sun).
  - `paneCross`, `speckle`, `flower`, `smallTree`, `bookPile`,
    `bookshelfWall` — scene-specific helpers built on the above.

  Practical gotcha when placing furniture: an object's *visual* base must
  line up with whatever it sits on, or it reads as floating. The seated
  character sprite's base is `y+36` (seated legs end at `y+36`), so chair
  seats are positioned to match; lamp stems must reach the table top or the
  floor. Several passes were spent fixing exactly this.
- **`companion-server.js`** — an optional local Node server (stdlib only,
  zero dependencies). Does two jobs: serves `pixel-companion.html` itself
  over HTTP, and answers `POST /chat` by shelling out to the Claude Code CLI.
  Resolves the `claude` binary itself at startup (`resolveClaudeBin()` — `which`,
  then falls back to known install paths like `~/.local/bin/claude`) rather
  than trusting `PATH`, since a double-clicked GUI app gets a minimal `PATH`
  that doesn't include a shell rc file's additions. Exports `{ PORT, server }`
  so `main.js` can run it in-process instead of as a subprocess.
- **`main.js`** — Electron main process. Requires `companion-server.js`
  directly (starts its HTTP server in-process, same code path as the
  terminal mode) and loads `http://localhost:8934/` into a `BrowserWindow`.
  Adds a tray icon (`tray-icon.png`, a tiny hand-written PNG — see the Python
  snippet in git history if it ever needs regenerating) with Show/Hide,
  Always on Top, and Quit. `app.dock.hide()` on macOS — it's meant to live in
  the menu bar, not the Dock/app-switcher. Closing the window hides it rather
  than quitting (`app.isQuiting` flag distinguishes a real quit from the tray
  menu from an incidental window close).

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
- The outside scene shows four buildings side-by-side (house, bookstore,
  cafe, work) sharing one path. The spacing is hand-tuned so the roof
  overhangs never collide — `drawTriRoof` spans `x-8 .. x+w+8`, wider than
  the wall block, and the path sits exactly in the gap between the bookstore
  and cafe roofs. Adding a fifth building means re-spacing the whole row,
  not just appending one.
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
  the port, or change `PORT` in `companion-server.js`. This also means
  **don't run the Electron app and `node companion-server.js` at the same
  time** — the second one to start will fail on the port.
- The packaged `.app` is **unsigned** — no Apple Developer certificate is
  set up for it (that costs money and is a real ongoing commitment, so it
  wasn't done without asking). Consequence: Gatekeeper blocks a plain
  double-click on first launch; right-click → Open bypasses it once, then
  it's remembered. `npm run dist` itself detected an old signing identity on
  this Mac ("David Rutter-Close") but it's expired, so the build correctly
  fell back to unsigned automatically — nothing to configure differently
  unless a fresh paid cert is set up later.
- The `.app` is a **snapshot** of the source at build time (bundled into
  `app.asar` inside it) — editing `pixel-companion.html` etc. afterward has
  no effect on an already-built `.app`. Re-run `npm run dist` after changes
  and reinstall from the new `.dmg` to pick them up. `npm start` (dev mode)
  doesn't have this problem — it always runs the live source.
- `npm run dist` output goes to `dist/` (gitignored, ~120MB `.dmg` — too
  large and too disposable to commit). `build/icon.icns` **is** committed —
  it's a source asset, not a build product.
- This machine is Intel (`x86_64`), so the build only targets `x64`. If this
  ever needs to run on an Apple Silicon Mac, add `"arch": ["x64", "arm64"]`
  (or `"universal"`) under `build.mac` in `package.json` and rebuild.
- First `npm install` needs internet access twice: once for the npm
  packages, once more for `electron`'s own postinstall step, which
  downloads the actual Electron.app binary (~150-200MB) from GitHub — this
  is separate from the npm registry download and can look like it's hanging
  if you're on a slow connection. `npm run dist` needs internet again the
  first time too, to download `electron-builder`'s DMG-building helper.

## Ideas discussed for next steps

- Wider range of animated expressions/moods reacting to conversation tone.
- Idle animations / small gestures (wave, nod) for extra life.
- A paid Apple Developer ID certificate, if the right-click-Open-once
  friction on a fresh install ever becomes a real problem (e.g. installing
  on another Mac) — would remove the Gatekeeper warning entirely.

## Files

- `pixel-companion.html` — the app itself.
- `companion-server.js` — optional local chat bridge + static server (used
  standalone via terminal, or embedded by `main.js`).
- `main.js` / `package.json` / `tray-icon.png` — the Electron desktop-app
  shell (`npm start` for dev mode, `npm run dist` to build the `.app`/`.dmg`).
- `build/icon.icns` — the app icon (generated from a hand-drawn 64×64
  pixel-art scene, scaled up — regenerate via Pillow + `sips`/`iconutil` if
  it ever needs changing; see git history for the generation script).
