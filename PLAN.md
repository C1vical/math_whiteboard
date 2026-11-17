# MathBoard — plan

## Architecture

```
shared/   pure TypeScript used by client, server and tests
  types.ts      data model + socket protocol types
  ops.ts        op reducer, page-op reducer, inverse ops (undo)
  geometry.ts   bounds, hit-testing, lasso, object transforms
  ink.ts        perfect-freehand tuning per pen type (one source of truth for live + committed ink)
  erase.ts      partial-eraser stroke splitting
  recognize.ts  conservative shape recognizer + scribble detector
  ruler.ts      ruler / protractor snapping math
  graph.ts      expression parser (mathjs) + adaptive sampler
  space.ts      insert/remove-space op builder
  imageSize.ts  downscale sizing math
server/   Express + Socket.IO; one process serves client, API, uploads, websockets
  app.ts        createApp(): HTTP routes, socket handlers, presence
  store.ts      in-memory authoritative notebooks, debounced atomic JSON persistence
  schema.ts     zod validation for every incoming message
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

### Ink
`shared/ink.ts` maps (pen type, size, stabilization) → perfect-freehand options.
The local live stroke, remote previews and committed strokes all call it with
`last: true`, so they are pixel-identical and the tip never trails the pen.
Input points are rounded (0.1 px, pressure 0.01) at capture so what is sent is
exactly what is stored.

## Data model
As in the spec (section 6), with small additions:
- `Stroke.stab` (stabilization 0–100) and `Stroke.sim` (simulate pressure: mouse/touch)
  so every client renders the identical outline.
- `Shape.kind` rect/ellipse store bounds `[x1,y1,x2,y2]` + `rotation`; other kinds store vertices.
- Optional fields are cleared with `null` in update patches (JSON has no `undefined`).

## Socket protocol
Client → server: `join` (ack: snapshot), `ops`, `pageop`, `live:start`, `live:points`
(`reset` flag replaces the preview's points — used for straightened/held strokes),
`live:end`, `live:erase`, `cursor` (volatile), `laser`, `ruler`, `viewport`, `page`
(which page I am on), `restore` (upload a full snapshot).

Server → client: `ops {seq, ops, from, t}` to others and `ack {seq, opIds, t}` to the
sender; `pageop`; `presence`; `snapshot` (after restore); `saved`; relayed live events
tagged with `userId`.

Op kinds: `add`, `update` (shallow patch), `delete`, `reorder`, plus `move {ids,dx,dy}`
(an efficient translate used for moving selections and insert-space; commutative).

- Optimistic: clients apply their own ops immediately; pending ops are kept until acked.
- Last-writer-wins by server order: when a remote op arrives while I still have unacked
  updates to the same object, mine are re-applied on top (the server will order them later).
- Reconnect: re-join with the ids of pending ops, the server answers which were already
  applied, the client takes the fresh snapshot, re-applies and re-sends the rest.
- Server dedupes by `opId`.
- Restart safety: the client caches the notebook and image blobs in IndexedDB. If the
  server copy is empty or older, the user is asked to restore from the device.

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
- `TopRight.tsx` — presence chips (click to follow), connection / save status, Share, ☰ menu
- `Sidebar.tsx` — pages list (add, rename, duplicate, delete, drag to reorder)
- `SelectionBar.tsx` — floating actions for the selection
- `Inspector.tsx` — graph panel (expressions, sliders, window) and axes panel
- `Dialogs.tsx` — shortcuts, settings, clear confirms, device restore, backup restore, PDF import

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

## Not verified here
- Real pen hardware, iPad Safari and Firefox: pointer handling was exercised with
  synthetic pen / touch pointer events in Chrome only.
- The Dockerfile and the Render / Railway instructions were written but not run.
