# Pixel Companion — Project Notes

A small pixel-art desktop companion that lives in six scenes (home, cafe,
work, bookstore, outside, beach), reacts to real weather in Whitley Bay, UK,
watches real ships pass on the North Sea, and can hold a real conversation via
a local Claude Code bridge. Originally built as
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

### Time of day: dusk, dawn and the moon

Day and night used to be a switch: Open-Meteo's `is_day`, refreshed with
the weather every 30 minutes, flipped the whole scene at once and could lag
the real sunset by up to half an hour. Now the weather request also asks for
`daily=sunrise,sunset` (in GMT, parsed with an explicit `Z`, same reason as
the tide; `past_days=1` covers the small hours) and `skyState()` works out,
from the clock, every frame:

- `night`: 0 day to 1 night. Darkening runs from 15 min before sunset to 45
  min after, and the reverse around sunrise.
- `glow`: how strongly the sky is sunset/sunrise coloured, peaking at the
  event and gone 55 min either side.
- `lift`: the sun's height, sinking to the horizon (and clipped there) over
  the last 70 min before sunset, rising the same way after sunrise.
- `phase`: dawn / day / dusk / night, used by the status line, his speech and
  the chat prompt.

The sky blends day into night gradients with sunset colour over them, and so
does the view through every window. Clouds tint pink at dusk and go slate
grey at night; the sea follows the light and catches the sky's colour. An
outdoor golden-hour wash warms everything around sunset. Lamps, windows and
ships' lights switch on part-way into dusk (`lampsOn()`, night > 0.25) and
brighten as it gets darker. From the beach you face east over the sea, so
the sun rises out of it at dawn, but in the evening it's setting behind you
and isn't drawn, while the sky still colours.

Stars and the moon only show where the sky is clear. Before this, a rainy
night showed a sky full of stars.

**The moon is in its real phase**, computed from the mean synodic month
counted from a known new moon, with no API. Checked against five eclipse
dates, it's within about 16 hours every time, well under a pixel at this
size. It's drawn row by row from the terminator to the limb, the dark side
faintly visible. On a clear night it's registered as a light, so it glows;
on a cloudy one it's drawn behind the clouds, dimmed. Simplification: it
always sits in the same spot and is shown whenever it's night, ignoring
moonrise and moonset.

Chat is told the phase (dawn/day/dusk/night) and the moon phase, both
checked against fixed lists on the server, so he doesn't call dusk
"daytime". He also comments on the sky outdoors: a sunset, an early start, a
full moon, a moonless night. And he no longer says "Lovely bit of sun" at
10pm, since Open-Meteo calls a clear night "sunny" as well.

### Night lighting

Outdoor scenes (outside, beach, and the walk between places) don't darken
themselves any more. They register light sources with `addLight()` as they
draw, and `render()` calls `finishOutdoor()` **after** drawing him. That lays
the night shade over everything, him included, then paints the lights back
on top with additive blending (`'lighter'`) so they glow into the dark.
Weather is drawn last, in front of the lights.

Before this, night was a flat tint drawn inside each scene *before* the
character, so every window and lamp got dimmed with everything else while he
stayed at full daylight brightness and looked pasted on. What now lights up:

- house, shop and office windows (`litWindow`), warm glass with mullions and
  a halo on the wall;
- the streetlamp, which now stands there by day too instead of appearing at
  dusk, and throws a pool of light on the path;
- St Mary's lighthouse when its beam comes round;
- **ships' navigation lights, from their real AIS state.** A vessel under way
  shows a white masthead light and a sidelight; one at anchor or moored shows
  only a white anchor light. Looking east at north/south traffic, a ship
  heading right has its green starboard side toward you, one heading left its
  red port side. The glow is kept small on purpose: at first a near ship's
  light blew out into a white disc bigger than the ship.

Interiors go through the same `finishScene()`, with a gentler shade: the
room dims while its lamp throws a warm pool of light (home's table lamp, the
café's pendant, the bookshop's floor lamp). The office, which had no light at
all, got a desk lamp, and its monitors cast blue light on him. Monitors are
glow-only, with no redraw, because he sits right in front of the screen and a
redraw would paint it over his head. More generally, any light whose redraw
would land on him is skipped (`state.charBox`).

Cost: frames still draw in 0.29 to 0.86 ms with all of this on.

He also blinks: one frame every ~5 seconds (`state.tick % 29`), with a quick
double blink every third time.

### Render loop & behavior

- A single `state` object holds current weather, location, transition flag,
  and a tick counter. Redrawn every ~180ms via `setInterval` — no diffing,
  the whole canvas just repaints each tick. Measured in the Opus 5.5 review,
  that's cheap: 0.46-0.91 ms per frame depending on scene (340-880 canvas
  calls), about half a percent of one core. Caching static layers in an
  offscreen canvas would save a fraction of a millisecond, so it wasn't done.
- **Drawing stops while the window is hidden** (`syncRendering()` on
  `visibilitychange`). It used to keep repainting at the same rate in the
  tray, measured at ~3% CPU hidden, the same as visible. Boat polling pauses
  too; the server keeps listening to AIS regardless, so the vessel cache still
  learns while he's out of sight. A page that loads hidden stays blank until
  shown, which is harmless since nobody can see it.
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
2. On any failure — server not running, timeout, expired login — falls back
   to `localReply()`, a keyword-matched canned-reply table (`CHAT_REPLIES`)
   layered over the existing weather/location `SPEECH` pool used for idle
   speech bubbles.

Failures carry a **reason** (`auth`, `missing`, `timeout`, `offline`, `other`)
and the chat log shows a NOTE saying what's actually wrong, once per kind of
problem (`BRIDGE_PROBLEMS`). An expired Claude Code login used to show up as
"couldn't reach the chat bridge", which sent you looking in the wrong place.
A failure also only **pauses** the bridge — for a minute, or five if there's
no server at all — rather than switching it off for the rest of the session.
That mattered: this runs all day in the tray, and before, one timeout or login
lapse meant canned replies until the next restart, even after logging back in.

On the server side, `askClaude()` runs:
```
claude -p "<message>" --system-prompt "<character persona>" \
  --output-format json --no-session-persistence --tools "" [--allowedTools "WebSearch"] \
  --model claude-opus-5-5 --effort low|medium
```

**The model is pinned** (`CHAT_MODEL`, default Claude Opus 5.5), so his voice
doesn't drift whenever Claude Code changes its own default. Override with
`PIXEL_COMPANION_MODEL`; an empty string means "whatever the CLI defaults to".
Opus 5.5 can't switch thinking off, so effort is the latency lever: `low` for
small talk, `medium` for search-triggered questions. Those are starting
points, not measured values — tune them once real replies can be timed.

An older CLI may not know the pinned model. It then prints
`[claude-code:unrecognized_model] ...` on stdout **ahead of** the JSON result.
That broke the old plain `JSON.parse(stdout)` even when the reply itself was
fine, so `parseCliJson()` now takes the last line that parses as an object.
If the pinned call fails that way, the server retries once on the CLI's
default and stops pinning for the rest of that run, logging a single warning
to run `claude update`. Verified against a stand-in CLI that mimics that
output: the first message falls back and replies, and later ones skip
straight to the default with no wasted call.
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

### Boats: live AIS vessel data

The beach scene (in progress) draws real ships. `boat-source.js` streams live
AIS — the transponder positions ships broadcast by law — from
[aisstream.io](https://aisstream.io) for a bounding box covering the sea off
Whitley Bay, the Tyne approaches to the south and Blyth to the north
(`54.90,-1.55` to `55.25,-0.90`). Vessels really out there, in real positions.

**Setup (one-off).** aisstream is free but needs a free key — sign up, create
an API key, then:
```bash
mkdir -p ~/.pixel-companion
echo '{"apiKey":"YOUR_KEY"}' > ~/.pixel-companion/ais-config.json
node boat-source.js 60     # verify: prints vessels found in 60s
```
The key lives in `~/.pixel-companion/`, **not** in the project folder, on
purpose: the packaged `.app` bundles its files into a read-only `app.asar`, so
a key kept alongside the source would be frozen at build time and lost on every
rebuild. A project-local `ais-config.json` also works (gitignored, see
`ais-config.example.json`), as does an `AISSTREAM_API_KEY` env var.

**Why it's server-side.** aisstream is WebSocket-only and its docs say to keep
the key on your own server and proxy to clients. So `boat-source.js` runs
inside `companion-server.js`'s process, holds the key, maintains the stream,
and the page only ever polls `GET /boats` for an already-filtered summary. The
key never reaches the browser and never reaches GitHub.

**Zero dependencies still holds.** Node 22+ and Electron 43+ ship a global
`WebSocket`, so no `ws` package was needed. Verified on Node 24.16 (terminal)
and Electron's bundled Node 24.18.

**The identities are cached to disk.** `~/.pixel-companion/vessel-cache.json`.
Positions expire after 30 minutes, but what a ship *is* — name, type, length —
never changes, and vessels broadcast that only every ~6 minutes (moored ones
are heard from rarely). Without a cache the scene draws `unknown` boats for
ages after every launch. `prune()` therefore clears positions only, and
deliberately leaves identities alone. After a few days' running the local fleet
is essentially all known on startup.

### Tide

The waterline is the real one. Open-Meteo's **marine** endpoint
(`marine-api.open-meteo.com`, `sea_level_height_msl`) gives sea level including
tides and needs no API key, so unlike the boats this is fetched **from the
page**, like the weather — meaning the tide works in every mode, including the
plain double-clicked HTML file with no server at all.

- Times are requested with `timezone=GMT` and parsed with an explicit `Z`.
  Asking for `Europe/London` returns naive local timestamps that `Date.parse`
  reads as the *viewer's* local time, which would silently shift the tide for
  anyone outside the UK.
- The hourly samples are interpolated (`sampleTide`) so the water moves
  continuously instead of stepping once an hour. The forecast is refetched
  every 30 minutes; the position within it is recomputed every minute.
- Height is normalised against the whole 3-day window, so "high" and "low"
  mean high and low for this run of tides rather than for one day — which
  matters, because springs and neaps differ a lot.
- Caveat from Open-Meteo's own docs: the model is 8 km resolution and
  referenced to global mean sea level, not chart datum. Fine for deciding
  where to draw foam; **not** navigational data.

On screen, `HIGH_WATER` (192) is fixed — that's where the dry sand starts and
it doesn't move. `shoreLine()` moves between 166 and 188 with the tide, so low
water uncovers a broad band of wet sand and high water brings the sea almost to
the dry sand. Boat depth is measured against the *current* waterline, not a
fixed one, or a near vessel ends up beached on the sand at low water.

He'll comment on it too — locally in speech bubbles, and via the chat bridge,
which now receives the tide state alongside weather and location.

### The beach scene

Bands: sky `0..108`, sea `108..178`, wet sand `178..190`, dry sand `190..240`.
St Mary's Island sits low and hazy off to the north (your left), its light
turning at night.

Two mappings put a real vessel on screen, and both needed tuning against the
actual data rather than first principles:

- **Bearing to x.** You face east, so north (0°) is on your left and south
  (180°) on your right. A literal half-circle map looked obvious and was
  wrong: local traffic bunches into the Tyne mouth at ~170-190° and the run
  north past St Mary's at ~340-360°, so every boat clamped to the two edges of
  the canvas in a heap. `VIEW_ARC` is 120° either side of east instead, which
  spreads both clusters into view.
- **Distance to y and size.** Far boats sit high and small near the horizon.
  A flat 0-22 km ratio also failed, because real vessels here are 3-12 km out
  and landed in a single band halfway up the water. The curve is
  `(min(d,16)/16) ** 0.7`, which stretches that common range across the sea.

Even so, ships queueing for the same river mouth overlap, so after placement a
pass nudges apart any two at a similar depth. It's a small visual liberty, and
the alternative is boats stacked invisibly on top of each other.

`drawBoat` picks a silhouette per category — container stacks for cargo, tiered
white superstructure for ferries, a tall wheelhouse on a stubby hull for tugs,
mast and derrick for fishing boats, a triangular sail for yachts. Vessels on a
westerly course are mirrored so they face the way they're actually steaming.

**Hovering.** `drawBeach` records a hit box per boat each frame into
`state.boatHits`, in the canvas's own 320×240 space; pointer coordinates are
scaled back into that space before testing, since the canvas is stretched to
fit. The card is built with `textContent`, never `innerHTML` — vessel names
arrive off a public radio feed and must never be able to act as markup. Tapping
works too, for touch. With no live data the sea falls back to fixed example
boats, and the card says so explicitly rather than passing them off as real.

**He can talk about the ships.** `describeBoats()` in `companion-server.js`
appends a short plain-language list of what's currently in view to the chat
system prompt. The server already holds the AIS data in-process, so nothing
extra is sent from the page. Bearings become words ("south-east", not "148°"),
and the prompt tells him destinations are UN/LOCODE and to say the place name
rather than the code — Claude decodes these fine, so no lookup table is needed
server-side. It's gated in the prompt: he mentions a ship only if asked about
the sea, or if he's at the beach and one is worth a passing remark, at most one
or two, never as a list. Verified: asked at the beach he picked out Princess
Seaways heading for Newcastle; asked at home how his day was, he didn't mention
the sea at all.

His idle speech bubbles do this too, but **locally** rather than via the
bridge (`boatSpeech()` in the page), so the beach still feels alive with no
server running. Those need a small `PORT_NAMES` table since there's no model to
interpret codes, plus `SPOKEN_CATEGORY` — the AIS words are fine as data labels
but stilted out loud, and nobody says "a passenger vessel" standing on a beach.
`vesselCase()` softens the block capitals AIS broadcasts names in, which
otherwise read as shouting in a speech bubble — with two exceptions learned
from real names on this coast: roman numerals stay upper ("Success III", not
"Success Iii") and connecting words stay lower unless they lead ("Pride of the
Tyne", not "Pride Of The Tyne").

Implementation notes:
- Two AIS message types are subscribed: `PositionReport` (position, speed,
  course — every few seconds) and `ShipStaticData` (name, type, destination,
  length — every ~6 minutes). They're kept in separate maps and merged on read,
  since positions arrive far more often than names.
- `categorise()` collapses AIS's fiddly numeric ship-type codes into a handful
  of categories (fishing, sailing, pleasure, tug, passenger, cargo, tanker,
  military, service, fast) — chosen so each can get its own boat sprite.
- Each boat is returned with `distanceKm` and `bearing` from the beach, which
  is what the scene needs to place it: distant boats small and high toward the
  horizon, near boats larger and lower.
- Stale vessel *positions* (30 min silent) are pruned; a 300-vessel cap is a
  backstop. Identities survive, by design — see the cache note above.
- Reconnects with exponential backoff (5s doubling to 60s).
- Degrades quietly, exactly like chat: no key or no network means `ok:false`
  and the scene falls back to invented boats.

## Known gotchas

- **The server only listens on loopback (`127.0.0.1`) and checks the Host
  header.** Before, it listened on every interface and sent
  `Access-Control-Allow-Origin: *`. Anyone on the same wifi could reach
  `/chat` at this Mac's LAN address, and any website you had open could call
  it from your browser and read the replies. The CLI runs with no tools (web
  search at most), so this never exposed files, but it did let others spend
  your Claude usage. The page is same-origin, so it needs no CORS headers at
  all. The Host allowlist (`localhost:PORT`, `127.0.0.1:PORT`) also blocks
  DNS-rebinding pages that point their own domain at 127.0.0.1. If you ever
  deliberately want it reachable from another device, that's a design change,
  not a one-line bind address edit — it would need authentication first.
- **Quitting.** Closing the window only hides it, as a tray app should,
  via the `close` handler in `main.js`. That handler used to swallow *every*
  quit that didn't come from the tray menu, including the one macOS sends at
  logout, restart and shutdown. Measured: a quit request, and even SIGTERM,
  left it running 20+ seconds later. `before-quit` now marks the quit as
  real first.
- **Chat needs Claude Code logged in.** `claude auth status` shows
  `loggedIn`. When the login lapses, the chat log says so; run `claude` in
  Terminal and log in, and he picks real replies back up within a minute
  without restarting.

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
- **aisstream sends its JSON over *binary* WebSocket frames.** Node's built-in
  `WebSocket` defaults `binaryType` to `'blob'`, so `String(ev.data)` yields the
  literal string `"[object Blob]"` and every message silently fails to parse —
  it looks exactly like "connected fine but the sea is empty". `boat-source.js`
  sets `ws.binaryType = 'arraybuffer'` and decodes with `TextDecoder`. The CLI
  test now reports raw frame count separately from parsed messages so this
  class of bug is visible rather than mistaken for an empty ocean.
- **Ship categories start as `unknown` and fill in over a few minutes.** Names,
  types and destinations come from `ShipStaticData`, which vessels broadcast
  only every ~6 minutes, whereas positions arrive every few seconds. A short
  `node boat-source.js 45` run will show mostly `unknown`; that's expected, and
  self-corrects once the server has been running a while.
- **`drawCharacter`'s `facingLeft` mirror was broken until the Opus 5.5
  review** — it translated by `x*2` and then negated `x`, landing him at
  roughly `3x`. It never showed because nothing passes `true`. It now mirrors
  about the sprite's own centre line (`x+12`), matching how the boats flip.
- **A bad aisstream key looks like a network failure.** aisstream accepts the
  WebSocket first and only then validates your subscription, so a wrong key
  shows up as an immediate close with no data. `boat-source.js` detects this
  (nothing ever received) and says so explicitly rather than blaming the
  network — if you see "closed the connection before sending any data", check
  the key, not your wifi.
- Port 8934 is the default, overridable with `PIXEL_COMPANION_PORT`. If something else is already using it, the server
  will fail to start with `EADDRINUSE` — find and stop whatever's holding
  the port, or run with `PIXEL_COMPANION_PORT=8935 node companion-server.js`.
  This also means
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

- Moonrise/moonset, so the moon is only up when it really is (needs an
  astronomy calculation or API; the phase alone is done).
- Wider range of animated expressions/moods reacting to conversation tone.
- Idle animations / small gestures (wave, nod) for extra life.
- A paid Apple Developer ID certificate, if the right-click-Open-once
  friction on a fresh install ever becomes a real problem (e.g. installing
  on another Mac) — would remove the Gatekeeper warning entirely.

## Files

- `pixel-companion.html` — the app itself.
- `companion-server.js` — optional local chat bridge + static server (used
  standalone via terminal, or embedded by `main.js`). Also serves `/boats`.
- `boat-source.js` — live AIS vessel feed for the beach scene. Run directly
  (`node boat-source.js 60`) to test your key.
- `ais-config.example.json` — template for the aisstream key. The real
  `ais-config.json` is gitignored.
- `main.js` / `package.json` / `tray-icon.png` — the Electron desktop-app
  shell (`npm start` for dev mode, `npm run dist` to build the `.app`/`.dmg`).
- `build/icon.icns` — the app icon (generated from a hand-drawn 64×64
  pixel-art scene, scaled up — regenerate via Pillow + `sips`/`iconutil` if
  it ever needs changing; see git history for the generation script).
