# MathBoard — plan

## Architecture

```
shared/   pure TypeScript used by client, server and tests
  types.ts      data model + socket protocol types
  schema.ts     zod rules for stored objects / pages / notebooks, salvage of damaged files,
                update validation, clipboard payloads (server and client use the same rules)
  ops.ts        op reducer, page-op reducer, inverse ops (undo)
  geometry.ts   bounds, hit-testing, lasso, object transforms
  ink.ts        perfect-freehand tuning per pen type (one source of truth for live + committed ink)
  erase.ts      partial-eraser stroke splitting
  recognize.ts  conservative shape recognizer + scribble detector
  ruler.ts      ruler / protractor snapping math
  graph.ts      expression parser (mathjs parser only + own whitelisted evaluator) + sampler
  ticks.ts      axis tick helpers (no parser, so the axes renderer stays light)
  space.ts      insert/remove-space op builder
  imageSize.ts  downscale sizing math, multi-image layout
  exportLayout.ts  PDF sheet layout (fit / Letter / A4, splitting tall pages), background geometry
  timer.ts      shared countdown state machine, custom-time parsing
  reset.ts      what "reset for the next class" touches on a page
  crop.ts       non-destructive image crop maths (frame <-> source fractions, handle drags)
  touchTap.ts   two- / three-finger tap detector (never fires for a pinch or pan)
server/   Express + Socket.IO; one process serves client, API, uploads, websockets
  app.ts        createApp(): HTTP routes, socket handlers, presence, rate limits, upload sweep
  store.ts      notebooks in memory (evicted when idle), salvage on load, per-page persistence,
                backups, upload quota and orphan sweep
  schema.ts     zod validation for every incoming message
  limits.ts     in-process rate limiter, client address behind local proxies
client/   Vite + React 18 (UI chrome only) + a canvas engine
  src/engine/   Engine (camera, 3 stacked canvases, render loop, undo), input/tools,
                render (strokes/shapes/images/text/tape/axes/graph), sync (socket + pending queue),
                idb (IndexedDB snapshot + image cache), export, pdf import
  src/main.tsx  entry + error boundary;  src/styles.css  all chrome styling (light / dark)
  src/ui/       landing, toolbar, popovers, pages sidebar, selection bar, graph panel, dialogs
tests/    vitest unit tests + real-server integration test
```

### Rendering
Three stacked canvases: background pattern → committed content → live layer
(`desynchronized: true`). Committed strokes are cached as `Path2D` (perfect-freehand
outline, world space), culled by bounding box, drawn through the camera transform.

Rasterising thousands of ink paths costs far more than a frame (measured: 50–100 µs
per stroke on integrated graphics, and canvas raster is deferred, so script timing
does not see it). The committed layer therefore repaints as little as possible:

- **The camera sits on whole device pixels** (`setCamera` snaps it). A pan then moves
  the cached bitmap by an exact number of pixels: it stays crisp and aligned with the
  live layer without being repainted.
- **Overscan.** The committed canvas is 256 CSS px larger than the viewport on every
  side (less on very large / high-DPI screens, capped near 14 MP). `mainCam` is the
  camera the bitmap was painted at; a CSS transform shows it where `cam` wants it.
- **Pan = slide + strips.** Once the slide exceeds 96 px (or the view leaves the
  cached area, or the motion stops) the bitmap is shifted in place (`drawImage` onto
  itself) and only the newly exposed strips are painted.
- **Edits = dirty rectangles.** Every op batch reports the painted bounds of what it
  touched before and after it was applied; only that rectangle is cleared and
  repainted (clipped to whole device pixels). New top-most objects are simply drawn on
  top. Lifting objects onto the live layer (moving a selection) works the same way.
- **Zoom.** Light pages repaint every frame. Heavy pages show the scaled bitmap and
  repaint on a throttle proportional to the measured cost, and crisply when motion
  stops. "Heavy" is decided from real frame times after full repaints, not script time.

`tests`-wise this is covered by a browser check that compares the incrementally
maintained bitmap with a fresh full repaint after pans, strokes, erasing, selection
moves, undo and zoom (differences are limited to anti-aliasing on a few seam pixels).

### Page thumbnails
`engine/thumbs.ts` draws a 172×104 preview of each page for the sidebar, entirely off the drawing
path: only while the sidebar is shown, in `requestIdleCallback` time (a 50 ms timer where that is
missing), 0.7 s after the last edit to a page, never while a pointer gesture is in progress, in slices
of at most 5 ms, and cached per page until that page changes. The thumbnail canvas is a CPU canvas and
each slice ends by reading one pixel, so the deferred canvas raster happens inside the slice instead of
all at once when the sidebar copies the thumbnail (without that, a 5,000-stroke page caused 70–150 ms
frames). Measured while drawing on a 5,000-stroke page in headless Chrome (6 s of strokes with
pauses, `tests/browser/final.mjs`): sidebar closed p95 17.2 ms / max 57.7 ms; sidebar open
p95 17.1 ms / max 18.1 ms, with 73 ms of thumbnail work spread over idle time.

### Ink
`shared/ink.ts` maps (pen type, size, stabilization) → perfect-freehand options.
The local live stroke, remote previews and committed strokes all call it with
`last: true`, so they are pixel-identical and the tip never trails the pen.
Input points are rounded (0.1 px, pressure 0.01) at capture so what is sent is
exactly what is stored.

## Persistence
- On disk a notebook is `<id>.json` — a manifest `{format: 2, id, title, updatedAt, pages: [{id, title,
  background}]}` — plus `<id>.pages/p_<id>.json` per page (`{id, objects, order}`; upper-case letters
  in the id are escaped so case-insensitive file systems cannot collide). All writes are atomic
  (temp file + rename); page files are written first, the manifest last.
- A save rewrites only pages whose content changed. Each page file is assembled from per-object JSON
  strings cached by object identity (objects are immutable: every change replaces them), and anything
  not yet cached is serialised in short slices that yield to the event loop. Measured with 20 pages ×
  5,000 strokes (96 MB of JSON): the old whole-notebook `JSON.stringify` blocked ~815 ms per save; now
  a save after an edit blocks ~11 ms (median), ~22 ms worst, and the first full write ~45 ms
  (`npm run perf:save`).
- Old single-file notebooks load unchanged and are converted by their first save.
- **Salvage**: a file is validated page by page and object by object; what fails is dropped and
  logged, and the original is copied to `<file>.corrupt-<time>`.
- **Backups**: before `restore` (and on the `backup` request that notebook-wide resets send first) the
  current notebook is written to `<id>.backup-<time>.json` (single-file format; newest five kept).
- **Rooms** are reference-counted by joined sockets. When the last one leaves, the room is evicted
  after a delay (5 min) once its save has flushed; a join during eviction cancels it. Recently seen
  opIds (and a running countdown) outlive the eviction, so re-sent ops are still de-duplicated.
- **Deleting a board** (`deleteBoard` on the socket, or `POST /api/boards/:id/delete` from the start
  page, passcode in `x-passcode`, 30 per address per 10 min): the id is marked deleted at once (joins
  are answered `error: 'deleted'`, uploads 410, saves refused), everyone else in it gets `deleted {by}`
  and is removed from the room, pending changes get one last save, and every file of the board moves
  to `deleted/<id>/` next to a `deleted.json` marker. The daily housekeeping removes those files after
  30 days and keeps the marker, so the id stays deleted (the set is read from `deleted/` on startup).
  Clients drop their IndexedDB copy and the recent-list entry. A code that was never saved is not
  marked at all.
  Joining an unknown id writes nothing until the first change.
- **Uploads**: per-notebook byte quota (`UPLOAD_QUOTA_MB`), checked from Content-Length before the body
  is read and again after; unreferenced files older than 24 h are swept on startup and daily (a
  notebook that did not load cleanly, or whose damaged copy exists, is never swept; files referenced
  by backups are kept; deleting an image restarts its file's clock so Undo still works).
- **Rate limits** (in process, fixed window per client address): wrong passcodes across
  `/api/passcode`, the socket handshake, `join` and uploads (10 / 5 min), uploads (120 / min).

## Data model
As in the spec (section 6), with small additions:
- `Stroke.stab` (stabilization 0–100) and `Stroke.sim` (simulate pressure: mouse/touch)
  so every client renders the identical outline.
- `Shape.kind` rect/ellipse store bounds `[x1,y1,x2,y2]` + `rotation`; other kinds store vertices.
- Optional fields are cleared with `null` in update patches (JSON has no `undefined`).
- `Notebook.title` is shown and edited in the top bar (`notebookTitle` page op).
- Every field added later is optional, so older files still validate.
- `ImageObj.crop {x, y, w, h}`: the visible part of the source image, as fractions of it; the object's
  `x/y/w/h` are the visible frame. Rendering, hit-testing, bounds, export and duplicate all use the
  frame; the uploaded file is never changed, and `crop: null` shows the whole image again.
- `Graph.angle` ('deg', otherwise radians), `Graph.piTicks`, `GraphSlider.play {t0, v0, dir}` (a
  playing slider is a function of the server clock, so every screen shows the same value without a
  stream of updates). `Axes.grid`, `Axes.xLabel`, `Axes.yLabel`, `Axes.piTicks`.

## Socket protocol
Client → server: `join` (ack: snapshot, countdown, server clock), `ops`, `pageop`, `live:start`,
`live:points` (`reset` flag replaces the preview's points — used for straightened/held strokes),
`live:end`, `live:erase`, `cursor` (volatile), `laser`, `ruler`, `viewport`, `page`
(which page I am on), `rename` (my display name), `summon` (bring everyone to my page and view, once),
`timer` (shared countdown actions), `backup` (keep a server copy first), `restore` (upload a full
snapshot; the server backs up the current one first), `deleteBoard` (delete it for everyone).

The countdown (`TimerState`: duration, remaining, `endsAt` on the server clock, position) lives in
the room in memory only: never written to disk, kept across a room eviction like the seen opIds, and
sent with the join ack together with the server clock, so a late joiner shows the right time.
`summon` is relayed once; the receiver waits until its own pointer gesture has ended before it moves,
and it does not start a lasting follow.

Server → client: `ops {seq, ops, from, t}` to others and `ack {seq, opIds, t}` to the
sender; `pageop`; `presence`; `snapshot` (after restore); `saved`; `deleted {by}`; relayed live events
tagged with `userId`.

Op kinds: `add`, `update` (shallow patch), `delete`, `reorder`, plus `move {ids,dx,dy}`
(an efficient translate used for moving selections and insert-space; commutative).
Page ops: `add`, `rename`, `duplicate`, `delete`, `reorder`, `setBackground`, `restorePage` (a deleted page
back with its content at its index — the Undo in the toast) and `notebookTitle`.

Server-side guards: an `update` may only touch fields of the object's own type and the merged object
must pass the same schema as an `add`; a `move` may not take coordinates outside ±1e9. A refused op is
not applied or relayed but is still acknowledged, so the sender's queue drains.

- Optimistic: clients apply their own ops immediately; pending ops are kept until acked.
- Last-writer-wins by server order: when a remote op arrives while I still have unacked
  updates to the same object, mine are re-applied on top (the server will order them later).
- Reconnect: re-join with the ids of pending ops, the server answers which were already
  applied, the client takes the fresh snapshot, re-applies and re-sends the rest.
- Server dedupes by `opId`.
- Restart safety: the client caches the notebook and image blobs in IndexedDB. If the
  server copy is empty or older, the user is asked to restore from the device.

## Graphs
`shared/graph.ts` keeps the whitelist evaluator: only the listed functions and constants can run,
whatever a collaborator types. Degrees mode wraps trig input and inverse-trig output. A trailing `{…}`
(one or two inequalities, or a chained `a <= x <= b`) becomes a mask: masked samples are NaN, so the
curve stops there. Relations in x and y that are not solved for y (`x^2 + y^2 = 25`) are traced with
marching squares; a sign change through a pole is not taken as a crossing, so there are no stray
segments. Points of interest (x-intercepts, the y-intercept, turning points, intersections of visible
curves) are found from sign changes refined by bisection; they are drawn on the live layer while the
graph is selected and are never stored. Tapping a curve shows the nearest point's coordinates.

## Touch gestures and keys
`shared/touchTap.ts`: all fingers down within 200 ms, lifted within 350 ms of the first, none moved
more than 12 px, no pen input meanwhile → two fingers undo, three redo. A pinch or pan moves the
fingers, so it never counts, and taps never reach the drawing tools. Holding L for more than 250 ms
sets `heldTool`, which the input layer uses instead of the chosen tool until the key is released; a
quick press selects the laser as before.

## Undo
Every local commit computes inverse ops against the current state
(`applyWithInverse`). Undo stacks are per user per page (500 entries); undo/redo send
ordinary ops, so they sync and only ever touch my own actions.

## UI chrome (`client/src/ui/`)
React renders only the chrome and talks to the engine through a small external store
(`engine/store.ts`, `useSyncExternalStore`); nothing in React runs per pointer event.

- `App.tsx` — landing (name, passcode, create / join, recent boards) and `/b/<id>` routing
- `Board.tsx` — mounts the engine; text editor overlay, zoom controls, pager, replay bar,
  follow banner, toasts, tooltips
- `Toolbar.tsx` — tools, pen favourites and their popovers, focus-mode bar
- `TopRight.tsx` — presence chips (click to follow), *bring everyone here*, connection / save status, Share, ☰ menu
- `Sidebar.tsx` — pages list with live thumbnails (add, rename, duplicate, delete, drag to reorder)
- `Timer.tsx` — the shared countdown widget, and its presets in the Insert flyout
- `SelectionBar.tsx` — floating actions for the selection
- `Inspector.tsx` — graph panel (expressions, sliders, window) and axes panel
- `Dialogs.tsx` — shortcuts, settings (incl. my name), clear / reset confirms, export options, device
  restore, backup restore, PDF import
- `GraphPanel.tsx` — the graph panel, loaded with the graph code on first use

### Load size
`shared/graph.ts` used to build mathjs with `create(all)`; it now builds only the parser
(`parseDependencies`) and evaluates the parsed tree itself, and the graph renderer + panel are loaded
on first use (`graphLoader.ts`; a placeholder is drawn until then). Main bundle: 1,043 kB (311 kB gzip)
→ 415 kB (134 kB gzip); the graph chunk is 316 kB (91 kB gzip).

### Clipboard
Copy puts `mathboard-clip:` + JSON `{v, token, board, objs}` on the system clipboard (≤ 4 MB). Paste in
the same tab uses the in-memory copy; anything else is validated with `shared/schema.ts`, and images
from another board are re-uploaded into this one.

### Export
`exporter.ts` + `shared/exportLayout.ts`. PDF: strokes become filled vector outlines (the same
perfect-freehand polygon, with its quadratic smoothing as cubic Béziers) and shapes vector paths; other
objects are embedded per object at ≥ 300 dpi for the paper. Paper: fit to content, Letter or A4 with
0.5" margins (landscape when that shows it larger); content much taller than a sheet is split across
portrait sheets at a readable scale, cutting between objects where possible. Tape: covered or left out
(answer key). Background: white or the page pattern. PNG gets the tape and background options.

Sliders and typing in the graph panel commit continuously but collapse into a single
undo step (`UndoGroup`).

## Milestones
All four are implemented and verified end to end in two browser sessions
(`npm test`, `npm run typecheck`, `npm run build` pass).

- M1 canvas engine, pen input, ink, live sync, persistence
- M2 pen types, favorites, highlighter, erasers, lasso, undo, shapes, ink-to-shape, hold, ruler
- M3 pages, images/paste, backgrounds, laser, insert space, text
- M4 axes, graph, protractor, scribble erase, tape, replay, follow, PDF import, export,
  focus mode, dark mode, tests, README

## Toolbar at 1280×720
Graph, axes, tape and image are in one *Insert* flyout; ruler and protractor share a button. With
more than ten pens they are narrower, the status shows icons only below 1500 px (the words appear
in a banner over the board), presence chips overlap, and the board name gets 80 px (full name in
its tooltip). The *bring everyone here* button sits after the chips; to make room, with more than
ten pens each is 26 px wide and the top-right items are 3 px apart. Checked with 15 pens, three people and the sidebar open (tests/browser/final.mjs).

## Not verified here
- Real pen hardware, iPad Safari and Firefox: pointer handling was exercised with
  synthetic pen / touch pointer events in Chrome only.
- The Dockerfile and the Render / Railway instructions were written but not run.
