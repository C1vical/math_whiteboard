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
  src/ui/       toolbar, popovers, pages sidebar, selection bar, graph panel, dialogs
tests/    vitest unit tests + real-server integration test
```

### Rendering
Three stacked canvases: background pattern → committed content → live layer
(`desynchronized: true`). Committed strokes are cached as `Path2D` (perfect-freehand
outline, world space), culled by bounding box, drawn through the camera transform.
New strokes are appended to the committed layer without a full redraw. If a full
redraw costs more than ~7 ms, pan/zoom moves the cached bitmap with a CSS transform
and re-renders crisply on a throttle and when motion stops.

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

## Milestones
- M1 canvas engine, pen input, ink, live sync, persistence
- M2 pen types, favorites, highlighter, erasers, lasso, undo, shapes, ink-to-shape, hold, ruler
- M3 pages, images/paste, backgrounds, laser, insert space, text
- M4 axes, graph, protractor, scribble erase, tape, replay, follow, PDF import, export,
  focus mode, dark mode, tests, README
