# MASTER PROMPT — Build "MathBoard": a real-time collaborative pen whiteboard for math teaching

## 1. Context and goal

You are a senior full-stack engineer. Build a complete, working web app that I will use in my actual classes, starting this week.

I run live math homework-help classes with my brother. We co-teach over Zoom. One of us shares the app window on Zoom while **both of us write on the same board at the same time from different computers**. Students only watch the Zoom share.

**We write almost everything by hand with a pen.** The pen experience is the whole product. It should match the inking tools in **Microsoft OneNote** (Draw tab) and **GoodNotes**, and add live collaboration.

What we use now and why it fails:
- **Zoom Whiteboard** lags. The other person only sees a stroke after the pen lifts, never while it's being drawn.
- **OneNote** has great, smooth ink, but collaboration is slow: the other person's writing takes about 10 seconds to appear.

### The three non-negotiables
1. **Ink as smooth as OneNote** with a pen tablet, stylus, Surface pen, iPad + Apple Pencil, or mouse. It should be pressure-sensitive with no visible lag under the pen.
2. **Live strokes.** The other person sees my ink appear point by point *while I'm drawing it* (target under 150 ms end to end on a normal connection), not when I lift the pen.
3. **Paste homework images instantly.** Pressing Ctrl/Cmd+V with a screenshot or copied image puts it on the board for both of us within a second or two.

### Out of scope — do NOT build these
- Handwriting recognition, ink-to-text, ink-to-math, typed or LaTeX equation editors.
- AI features.

Our handwriting stays as handwriting. A plain text box tool is the only typing tool needed.

### Quality bar
This must be a working product, not a prototype or demo:
- No TODOs, stubs, placeholder handlers, mock data, or "left as an exercise".
- Every button and menu item in the UI must work.
- If a feature can't be done well, say so clearly at the end rather than shipping a broken version.

### Our setup (optional — delete this block if unknown)
- My computer / OS: [e.g. Windows 11 laptop]
- My pen: [e.g. Wacom One / Surface Pen / iPad + Apple Pencil / mouse]
- My brother's computer and pen: [ ... ]

---

## 2. How to work

- Start in an empty directory and create the whole project yourself. Install dependencies, build it, run it, test it, and fix every error.
- First write `PLAN.md` covering architecture, data model, socket protocol and milestones. Then implement it.
- Work in milestones and get each one fully working before moving on:
  - **M1:** canvas engine, pen input and ink quality, live sync, persistence.
  - **M2:** the full pen toolkit — pen types, favorites, highlighter, erasers, lasso, undo, shapes, ink-to-shape, ruler.
  - **M3:** pages, images and paste, backgrounds, laser, insert space.
  - **M4:** graph and axes tools, P1 features, import/export, polish, tests, README.
- Priorities:
  - **P0** features must work flawlessly.
  - **P1** features should all be built too, but never trade P0 quality for P1 breadth. Pen feel and live sync matter more than anything else.
- This is a big task. Keep going until all of P0 and P1 are implemented and verified. Don't stop after scaffolding.
- If your environment can't run code, still output every file in full with no omissions.

---

## 3. Tech stack (use this unless something is truly impossible)

- **Single repo, single `package.json`**, TypeScript everywhere:
  - `client/` — Vite + React 18. React is for the UI chrome only: toolbars, panels, dialogs.
  - `server/` — Node 20+, Express, Socket.IO.
- **All drawing on HTML5 Canvas 2D.** No SVG/DOM element per stroke. Don't use tldraw, Excalidraw, Fabric.js, Konva or other whiteboard frameworks. We need direct control over ink feel, latency and tools.
- Libraries:
  - `perfect-freehand` — pressure-sensitive ink outlines.
  - `socket.io` / `socket.io-client` — real-time sync.
  - `mathjs` — parsing graph expressions only. Implicit multiplication like `2x` and `3(x+1)` must work.
  - `pdfjs-dist` — PDF import. `jspdf` — PDF export.
  - `zod` — server-side message validation. `nanoid` — IDs. `lucide-react` — icons.
  - `vitest` — tests.
- **Scripts:**
  - `npm run dev` runs Vite and the server together. The Vite proxy forwards `/socket.io` (with `ws: true`), `/api` and `/uploads` to the server.
  - `npm run build` builds the client and compiles the server.
  - `npm start` runs production, where **one Node process on `PORT` serves the built client, the API, uploads and WebSockets**.
  - `npm test` and `npm run typecheck` also need to exist.
- **Persistence (no database server):**
  - Each notebook is a JSON file in `DATA_DIR` (default `./data`). Saves are debounced (~1 s) and atomic (write a temp file, then rename).
  - Uploaded images go in `DATA_DIR/uploads/`.
  - Each client also caches the latest notebook snapshot in IndexedDB (see "Server-restart safety").
- **No paid services, no API keys, no user accounts.**

---

## 4. Rendering engine and ink quality (the most important section)

- **Infinite canvas** per page with world coordinates and a camera `{x, y, zoom}`. Zoom range is 10%–800%.
- **Stacked canvases**, and only the layer that changed gets redrawn:
  1. Background pattern (grid, lines, dots).
  2. Committed content: strokes, shapes, images, graphs, text, in z-order.
  3. Live layer: my in-progress stroke, remote in-progress strokes, selection handles, ruler, remote cursors and laser trails. Use `getContext('2d', { desynchronized: true })` where supported.
- **Everything renders on canvas**, including images and graphs, so ink can be drawn *on top of* anything.
- **High-DPI:** size the canvas backing stores by `devicePixelRatio`, and re-size on DPR or window change.
- **Input handling:**
  - Use Pointer Events only, with `touch-action: none` and `setPointerCapture`.
  - Read **`getCoalescedEvents()`** on every `pointermove` so fast strokes and small handwriting (exponents, subscripts, fractions) stay smooth and accurate.
  - Use `pressure` when `pointerType === 'pen'`; use perfect-freehand's simulated pressure for mouse.
  - Draw my own in-progress stroke on the very next animation frame. Local ink latency should be about one frame. No smoothing lag at the start of a stroke, no "catching up", and no missing first dot. A single tap must leave a dot (decimal points matter in math).
  - Tune the perfect-freehand settings per pen type (section 7) so normal handwriting looks clean and natural, like OneNote. Include a **"Stabilization" slider** (0–100, mapped to `streamline` / `smoothing`) in pen settings.
- **Committed strokes** are cached as `Path2D` (from the perfect-freehand outline) in world space, drawn with the camera transform, and culled by bounding box.
  - Target: **60 fps pan/zoom with 5,000 strokes and 10 large images on one page.**
  - During continuous pan/zoom, you may draw a transformed cached bitmap and re-render crisply when the motion stops.
  - Ink is vector, so it must stay crisp at every zoom level.
- **Live previews must match committed strokes exactly.** Remote previews use the same pen-type settings as committed strokes, so nothing "jumps" when a stroke is committed.
- **Pen hardware:**
  - The pen's **eraser end** (`buttons & 32`) erases temporarily with the current eraser mode.
  - **Holding the barrel button while dragging** (`buttons & 2` with pen) does a temporary lasso select, like Office.
  - **Palm rejection:** once a pen is seen, touch input never draws. One-finger touch pans, two fingers pinch-zoom and pan.
  - A setting "Draw with finger" exists for touch-only devices.
- **Mouse and trackpad:**
  - Left button draws.
  - Middle-drag or Space+drag pans.
  - Wheel scrolls vertically; Shift+wheel scrolls horizontally.
  - Ctrl/Cmd+wheel and trackpad pinch (which arrives as ctrl+wheel) zoom toward the cursor.
- Block the browser's own page zoom, text selection, context menu and touch callouts over the board.

---

## 5. Real-time sync

**Structure:** a *notebook* contains *pages*. Each notebook is a Socket.IO room. The server holds the authoritative state in memory and persists it to disk.

**Client → server messages**

| Message | Payload / notes |
|---|---|
| `join` | `{notebookId, userId, name, color, passcode?}` |
| `ops` | Batch of `{opId, pageId, kind: 'add'\|'update'\|'delete'\|'reorder', ...}` |
| `live:start` | `{strokeId, pageId, style}` — style includes pen type, color, size, opacity |
| `live:points` | `{strokeId, points}` — **batched once per animation frame**, coordinates rounded to 0.1 and pressure to 2 decimals |
| `live:end` | `{strokeId}` — immediately followed by an `add` op for the finished stroke with the same id. If the stroke was converted to a shape, ruler-snapped or straightened, the committed object replaces the preview. |
| `live:erase` | Partial-eraser preview, so the other person sees erasing happen live |
| `cursor` | `{pageId, x, y, tool}` at ≤30 Hz, sent with `volatile` |
| `laser` | `{pageId, points}` |
| `ruler` | `{pageId, visible, x, y, angle, kind}` — so others see my ruler or protractor |
| `viewport` | `{pageId, camera}` — used for follow mode |
| Page ops | add, rename, duplicate, delete, reorder, setBackground |

**Server → client messages:** a full snapshot on join, op broadcasts with an increasing server `seq`, the presence list (name, color, current page), and relayed live/cursor/laser/ruler/viewport events.

**Rules:**
- **Optimistic updates.** IDs are generated on the client (nanoid). Clients apply their own ops immediately and dedupe the server echo by `opId`.
- **Conflicts:** last writer wins per object, using server order. Two people drawing at the same moment must never block, overwrite or interrupt each other's strokes.
- **Abandoned strokes:** if a remote preview gets no `live:end` within 5 s, discard it.
- **Reconnects:**
  - Rely on Socket.IO auto-reconnect. On reconnect, re-join, receive a fresh snapshot, then re-send any unacknowledged local ops from a pending queue.
  - Show a connection pill: *Connected / Reconnecting… / Offline*.
- **Server-restart safety.** Free hosts can wipe disk. If the server's copy of a notebook is empty or older than the client's IndexedDB snapshot, prompt: *"Restore this board from this device?"* If the user confirms, upload the snapshot.
- **Validation:** validate every incoming message with zod. Drop malformed or oversized ones without crashing.

---

## 6. Data model (TypeScript, shared by client and server)

```ts
Notebook   { id, title, pages: Page[], updatedAt }
Page       { id, title, background: 'blank'|'grid'|'graph'|'lined'|'dots',
             objects: Record<string, BoardObject>, order: string[] }   // order = z-order
Base       { id, type, authorId, createdAt, locked?: boolean, rotation?: number }
Stroke     { type:'stroke', pen:'ballpoint'|'fountain'|'pencil'|'marker'|'highlighter',
             color, size, opacity, points:number[] /* x,y,pressure flat */, bbox }
Shape      { type:'shape', kind:'line'|'arrow'|'doubleArrow'|'rect'|'ellipse'|'triangle'|'polygon',
             points:number[] /* vertices or bounds */, color, size, dashed?, fill?: string|null, fillOpacity? }
Axes       { type:'axes', x,y,w,h, xMin,xMax,yMin,yMax, xStep,yStep, showNumbers, mode:'xy'|'numberLine' }
Image      { type:'image', src, x,y,w,h, naturalW, naturalH }
Text       { type:'text', text, x,y, fontSize, color }
Graph      { type:'graph', x,y,w,h, xMin,xMax,yMin,yMax, showGrid, showNumbers,
             expressions: { id, text, color, visible }[], sliders?: { name, min, max, step, value }[] }
Tape       { type:'tape', x,y,w,h, color, revealed: boolean }   // P1
```

**Colors:** the color "ink" (the default black) is a *semantic foreground* color. It renders black in light mode and white in dark mode, so a board looks right for both users even if one of them is in dark mode.

---

## 7. Features

### P0 — the pen toolkit (modeled on OneNote's Draw tab and GoodNotes; must be flawless)

1. **Pen types**, each with its own perfect-freehand tuning. Remote previews and committed strokes look identical.
   - **Ballpoint** (default): consistent width with light pressure variation. Clean for handwriting and numbers.
   - **Fountain**: strong pressure-to-width variation and tapered ends.
   - **Pencil**: grainy graphite texture (fill the outline with a precomputed noise pattern), and pressure affects opacity.
   - **Marker**: thick, flat, fully opaque.
2. **Pen favorites bar (like OneNote's pen gallery)**
   - The toolbar shows a row of saved pens. Each is a pen type + color + size, drawn as a pen icon in its color.
   - Default set: black ballpoint, blue ballpoint, red ballpoint, green ballpoint, a pencil, and a yellow highlighter.
   - Click a saved pen to use it. Click it again to open its settings popover:
     - Pen type.
     - Color: 16 swatches, a custom color picker and recent colors.
     - 5 thickness presets plus a fine slider, with a live preview squiggle.
     - Stabilization slider.
   - "+" adds a new pen (up to 15). Pens can be dragged to reorder and deleted.
   - Saved per user in localStorage. Keys 1–9 select favorites 1–9.
3. **Highlighter**
   - Wide, translucent ink drawn *beneath* regular ink, so highlighting over writing never covers it.
   - Its own colors (yellow, green, pink, blue, orange) and thicknesses.
   - **Hold Shift**, or enable "straight highlighter" in its settings, to snap to a straight line.
4. **Eraser** (settings popover, like GoodNotes):
   - **Stroke eraser** (default): touching a stroke or shape deletes it entirely.
   - **Partial (standard) eraser**: erases only what's under the circle, by splitting strokes. Other users see it live.
   - 3 eraser sizes, with a circle preview showing the eraser area.
   - **"Erase highlighter only"** toggle.
   - **Images, graphs, axes and text are never erasable** by the eraser, so the homework image can't be wiped by accident. Those are deleted through Select.
   - **Clear page** and **Clear my ink on this page**, both with a confirm step and both undoable.
5. **Lasso select**
   - Freeform lasso by default, plus a rectangle-select mode. Click-select and Shift multi-select also work.
   - Selected items can be:
     - Moved.
     - Resized with corner handles (aspect locked; free with edge handles).
     - **Rotated** with a rotate handle.
     - Deleted, duplicated, cut/copied/pasted within the app (Ctrl/Cmd+X/C/V/D).
     - Brought to front / sent to back.
     - **Recolored**, and given a **new thickness** (strokes and shapes).
     - Locked or unlocked.
   - Locked objects ignore drags, so you can ink freely over a locked homework image.
   - A small floating action bar near the selection shows these actions.
6. **Ink-to-shape (like OneNote)**
   - A toggle in the toolbar, on by default.
   - When it's on, a single-stroke hand-drawn shape converts to a clean shape: line, arrow (a line with a hand-drawn head), triangle, rectangle/square, other polygons, circle/ellipse.
   - The clean shape keeps the stroke's color and size.
   - **Be conservative.** If recognition confidence is low, keep the ink as drawn. Normal handwriting (digits like 0, letters like o or D, fraction bars, plus signs) must never be converted by accident. One Ctrl+Z undoes a conversion and restores the original ink.
7. **Draw-and-hold (like GoodNotes)**
   - With *any* pen, finishing a stroke and holding still for about 500 ms snaps it to a perfect straight line, or to the recognized shape.
   - It previews immediately, and keeping the pen down then lets you adjust the endpoint or size before lifting.
   - This works even when ink-to-shape is off.
8. **Ruler (like OneNote)**
   - Toggle an on-screen ruler with cm/mm-style tick marks and a live angle readout.
   - Moving it: drag to move. Rotating it: two-finger rotate on touch, Alt/Option+wheel on desktop, or drag its rotate knob. It snaps at 0°, 15°, 30°, 45°, 60° and 90°, and holding Shift rotates in 5° steps.
   - Any pen or highlighter stroke that starts near the ruler's edge **snaps to that edge** as a perfectly straight line.
   - Other users see my ruler (via the `ruler` event) so the Zoom audience can follow along.
9. **Shapes tool**
   - Line, arrow, double arrow, rectangle, ellipse/circle, triangle and right triangle.
   - Shift constrains to 15° angles, squares and circles.
   - Snaps to the grid when a grid background is on (toggleable).
   - Options for dashed lines, **fill color** and **fill opacity**.
   - Uses the current pen's color and size.
10. **Laser pointer** — a glowing trail that fades over about 1.5 s, shown in the user's color, visible to everyone, never saved. Also a "dot" mode: a single fading dot that follows the pen.
11. **Insert / remove space (like OneNote)** — drag a horizontal line down to push everything below it down and open up writing room, or drag up to close space. Vertical mode does the same horizontally. Synced and undoable.
12. **Undo / redo per user**
    - Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z or Ctrl+Y, plus toolbar buttons.
    - It only undoes *my own* actions (draw, erase, partial erase, move, resize, rotate, recolor, shape conversion, insert space, clear), using inverse ops that sync to everyone.
    - At least 200 steps of history per user per page.
13. **Text tool** — plain text boxes with font size and color, double-click to edit, rendered on canvas. Kept simple since we mostly write by hand.

### P0 — board, pages, images, collaboration

14. **Join flow and notebooks**
    - Landing screen: enter your name (remembered in localStorage), then create or join a notebook by code.
    - Shareable link `/b/<notebookId>`.
    - If the `APP_PASSCODE` env var is set, it's required to join. Check it on the socket handshake *and* on the upload endpoint, and remember it in localStorage after the first success.
    - Each user gets a distinct auto-assigned color.
15. **Presence**
    - Colored name chips of who's connected, and which page each person is on.
    - Remote cursors show as a small colored dot with a name label and the current tool icon, fading after 3 s idle.
16. **Pages sidebar (OneNote-style)**
    - Collapsible list of pages with add, rename, duplicate, delete (with confirm) and drag-to-reorder.
    - Every page is its own infinite canvas.
    - Users can be on different pages. All page changes sync live.
    - PageUp/PageDown switch pages.
17. **Images**
    - Three ways in: **Ctrl/Cmd+V paste** (screenshots, images copied from a browser or the Snipping Tool), **drag-and-drop**, and an **Insert image** button.
    - Placement: centered in view, scaled to about 60% of the viewport width.
    - Before upload, the client downsizes images larger than 2400 px on the longest side and re-encodes them (JPEG q0.9, or PNG if the image has transparency).
    - Upload: `POST /api/upload/:notebookId` (20 MB limit, MIME and magic-byte checked, path-traversal safe). It returns a URL under `/uploads/...`.
    - The image shows locally right away from an object URL while uploading, then syncs.
    - **Pasted images are auto-locked by default** (a setting can change this) so writing on top never moves them. Unlock them through Select.
    - If plain text is pasted instead, create a text box.
18. **Pan and zoom** — the input handling from section 4, plus zoom controls: −, a % readout (click to reset to 100%), +, and "fit to content".
19. **Page backgrounds** — blank, square grid, graph paper (minor and major lines), lined and dots. Set per page, synced, and scaled with zoom.
20. **Persistence** — everything survives refreshes, closing the tab and server restarts. A small "Saved" / "Saving…" indicator shows the state.
21. **Keyboard shortcuts**, plus a `?` overlay listing them all:

    | Key | Action |
    |---|---|
    | P | Pen (last used favorite) |
    | 1–9 | Pen favorites |
    | H | Highlighter |
    | E | Eraser (press again to toggle stroke/partial) |
    | V or S | Lasso select |
    | R | Ruler toggle |
    | Shift+R | Shapes |
    | L | Laser |
    | T | Text |
    | G | Graph |
    | [ / ] | Thickness |
    | Delete | Delete selection |
    | Ctrl/Cmd + Z / Shift+Z / C / X / V / D | Undo / Redo / Copy / Cut / Paste / Duplicate |
    | Ctrl/Cmd + 0 | Reset zoom |
    | PageUp / PageDown | Previous / next page |

### P0 — math tools

22. **Coordinate axes and number line**
    - Drag out a box to insert x–y axes with arrows, tick marks and numbers, or a number line.
    - A popover edits the range and step.
    - Ink can be drawn on top, and plotting points by hand should line up with the ticks when grid snap is on.
23. **Graphing calculator object** (Desmos-lite, rendered on the canvas). Insert a resizable graph panel. When it's selected, a side panel edits it:
    - Expressions, each with a color swatch, visibility toggle and inline error message. Supported forms:
      - `y = 2x^2 - 3x + 1`, `y = sin(x)`, `y=|x|`, `y = sqrt(x-2)`, `y = 1/x`, `y = tan(x)`, `y = ln(x)`, `y=e^x`
      - `f(x) = ...` definitions reused later (`y = f(x-1) + 2`)
      - `x = 3` vertical lines
      - points `(2, 3)`
      - constants such as `pi` and `e`
    - Typing friendliness: implicit multiplication (`2x`, `3(x+1)`, `2pi`), `^` for powers, `ln`/`log`, and `|x|` for absolute value.
    - **Correct plotting:** adaptive sampling, and break the path at asymptotes and domain gaps. `tan x` and `1/x` must not show vertical connecting lines; `sqrt` and `ln` simply stop where undefined. Bad input never crashes anything.
    - Window controls: xMin, xMax, yMin, yMax, plus "Standard (−10..10)" and "Zoom to fit" buttons. Grid and labeled axes with sensible tick spacing at any window.
    - "Interact" mode: drag to pan and wheel to zoom inside the graph.
    - The whole graph state syncs live, and pen ink can be drawn over the graph.

### P1 — build all of these too

24. **Protractor** — an on-screen semicircular protractor with degree marks that can be moved and rotated like the ruler. Strokes started at its center snap to the angle under the pen, and arcs drawn along its edge snap to the arc. Visible to the other user.
25. **Scribble to erase** (GoodNotes) — a toggle, **off by default** so math shading isn't affected. When it's on, a fast back-and-forth zigzag scribble over existing ink erases the ink underneath instead of drawing.
26. **Tape (GoodNotes)** — draw a colored tape strip over content, such as the answer to a question. Clicking the tape reveals or hides what's beneath, for everyone at once. Great for "try it first, then reveal".
27. **Ink replay (like OneNote)** — replay the current page's strokes in the order they were drawn, at an adjustable speed, with a scrubber. Useful for reviewing a solution step by step. View only — it doesn't change data.
28. **Follow mode** — click a collaborator's chip and your page and viewport follow theirs until you pan, draw or click again.
29. **Graph extras**
    - Inequalities like `y > 2x + 1` and `y <= x^2`, shaded and with dashed boundaries for strict inequalities.
    - **Auto sliders:** an unknown single letter in an expression (e.g. `y = a x^2 + b`) automatically gets a slider with editable min/max/step. Slider values sync live.
30. **PDF import** — choose a PDF, pick pages, and render each at 2× with pdf.js. Insert them as locked images, either stacked vertically on the current page or one per new page.
31. **Export**
    - Current page to PNG: content bounds plus padding, on a white background.
    - Whole notebook to PDF: one PDF page per board page.
    - Notebook to and from `.json` for backup and restore (including images).
32. **Focus / presentation mode** for Zoom sharing — hides the sidebar and shrinks the toolbar to a small floating bar with just the pen favorites, highlighter, eraser, lasso and undo. The board fills the window. Toggle with F or a button.
33. **Dark mode** — a dark board with semantic ink as described in section 6. Chosen per user and not synced.

---

## 8. UI and UX

- **Layout (modeled on OneNote's Draw tab, but cleaner):**
  - Top toolbar, left to right: undo/redo | lasso | eraser | **pen favorites bar** | highlighter | shapes | ink-to-shape toggle | ruler | laser | insert space | text | graph/axes | image.
  - Collapsible left pages sidebar.
  - Bottom-right zoom controls.
  - Top-right: presence chips, connection pill, save indicator, a **Share** button (copies the link) and a ☰ menu (import PDF, export, backgrounds, settings, shortcuts, dark mode).
  - A tool's settings popover opens when you click the already-selected tool, like OneNote and GoodNotes.
- Clean, modern and calm. Touch targets at least 40 px. Every tool button has a tooltip showing its shortcut.
- The pen cursor is a small dot in the current color and size. The eraser cursor is a circle showing the eraser area.
- Works well at **1280×720** (what Zoom shares), on large monitors and on **iPad Safari**.
- A React error boundary prevents white screens. Canvas errors are logged and never kill the app.

---

## 9. Non-functional requirements

- **Latency:** local ink ≈1 frame; remote ink visible while drawing in under 150 ms at 50 ms RTT.
- **Performance:** 60 fps pan and zoom at 5,000 strokes plus 10 images per page. The server handles at least 10 users per notebook.
- **Browsers:** latest Chrome, Edge, Firefox and Safari (macOS and iPadOS).
- **Security:**
  - Notebook IDs restricted to `[A-Za-z0-9_-]`.
  - Uploads validated and safe from path traversal.
  - Payload size limits on sockets and HTTP.
  - Passcode enforced when set.

---

## 10. Testing and verification (required before you say you're done)

1. `npm run typecheck` and `npm run build` pass with zero errors.
2. **Vitest unit tests:**
   - Op reducer (add, update, delete, reorder).
   - Undo/redo inverse ops, including partial erase, shape conversion and insert space.
   - Partial-eraser stroke splitting.
   - **Shape recognizer:**
     - Clean line, triangle, rectangle and circle inputs convert correctly.
     - Handwritten-like inputs ("0", "o", "D", "+", "=", "7", a short fraction bar) are left alone. A short fraction bar may become a straight line only if it's already nearly straight — it must never become another shape.
   - Ruler edge-snap math.
   - Graph parser and sampler: `2x^2`, `3(x+1)`, `f(x)` reuse, `x=3`, points, no connecting line across the `tan(x)` and `1/x` asymptotes, `sqrt(x)` domain gap, inequalities, invalid input.
   - Image downscale sizing math.
3. **Server integration test.** Start the real server and connect two socket.io clients to one notebook. Verify that:
   - Client B receives A's `live:points` batches **in order, before** A's `live:end`.
   - Committed ops persist to disk and appear in a brand-new client's snapshot after a server restart.
   - The upload endpoint stores the file and serves it, and rejects non-images and wrong passcodes.
   - A reconnecting client resyncs and re-sends pending ops.
4. **Manual check.** If you have browser tooling, open two windows side by side and test:
   - Live drawing in both directions, with each pen type.
   - Highlighter drawing under ink.
   - Both erasers, lasso move/rotate/recolor, ink-to-shape, draw-and-hold and ruler snapping.
   - Pasting an image, the graph, insert space, undo/redo, page switching and laser.
   - Reload persistence.

   Fix everything that fails.

---

## 11. Deliverables

1. The complete source code.
2. **README.md** covering:
   - **Quick start:** `npm install`, `npm run dev`, then open `http://localhost:5173` in two windows to see live sync. Production: `npm run build && npm start`.
   - **Environment variables:** `PORT`, `DATA_DIR`, `APP_PASSCODE`.
   - **Option A — easiest and free (recommended for us):** run it on my own computer and expose it with **Cloudflare Tunnel** (`cloudflared tunnel --url http://localhost:3000`), then send my brother the https link. Data stays on my disk. Note that the quick-tunnel URL changes each run, and include how to set up a named tunnel for a permanent URL.
   - **Option B — always-on hosting:** step-by-step guides for **Render** and **Railway**, plus a **Dockerfile**. Explain clearly that free tiers may sleep and may not keep files unless a persistent disk or volume is attached to `DATA_DIR`, and how the IndexedDB restore and JSON export act as backups.
   - **Teaching guide:**
     - How to share on Zoom: share the browser *window* and use Focus mode.
     - Pen tablet tips: Wacom/Windows Ink settings, Surface pen eraser and barrel button, iPad with Apple Pencil.
     - How to set up your pen favorites.
     - The full keyboard shortcuts table.
     - A typical class workflow: new page per question → paste the homework screenshot (auto-locked) → solve on top with pens and highlighter → use the ruler, shapes or graph when needed → tape over the answer and reveal it.
3. **Final message:** what was built, exactly how to run it, the test results, and any honest limitations or known issues.
