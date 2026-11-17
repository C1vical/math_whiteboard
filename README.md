# MathBoard

A real-time collaborative pen whiteboard for teaching math. Two (or more) people write on the
same board at the same time from different computers, and each sees the other's ink appear
**while it is being drawn**. Paste a homework screenshot, write on top of it, graph a function,
cover the answer with tape and reveal it.

- Pressure-sensitive ink (ballpoint, fountain, pencil, marker, highlighter) on an infinite canvas
- Live strokes, cursors, laser pointer, ruler and protractor shared with everyone on the board
- Pages, images (paste / drop / PDF import), text boxes, shapes, axes, a graphing calculator
- Per-user undo, lasso select, both kinds of eraser, ink-to-shape, draw-and-hold
- Named boards, PDF export on Letter / A4 with an answer-key option, installable on an iPad home screen
- No accounts, no database, no paid services: one Node process and a folder of JSON files

## Quick start

Requires Node 20 or newer.

```bash
npm install
npm run dev
```

Open <http://localhost:5173> in **two windows**, enter a name in each, create a board in one and
open the same link in the other. Draw in one window and watch it appear in the other.

Production (one process serves the app, the API, uploads and WebSockets):

```bash
npm run build
npm start          # http://localhost:3000
```

Other scripts: `npm test` (unit + server integration tests), `npm run typecheck`, `npm run perf:save`
(how long a save blocks the server with a 20-page, 100,000-stroke notebook). Browser checks are in
[tests/browser](./tests/browser/README.md). GitHub Actions runs tests, typecheck and build on every push.

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port the server listens on. |
| `DATA_DIR` | `./data` | Where notebooks and `uploads/` are stored (see *Your data on disk*). |
| `APP_PASSCODE` | *(unset)* | If set, everyone must enter this passcode to open any board or upload an image. It is remembered in the browser after the first success. |
| `UPLOAD_QUOTA_MB` | `500` | Most image storage one board may use. Above it, uploads are refused with a message saying so. |
| `TRUST_PROXY` | `true` | Rate limits count per visitor address. Behind cloudflared or a hosting proxy on the same machine / network the visitor's address comes from `X-Forwarded-For`; set `false` if nothing sits in front of the server. |

Anyone who has a board's link can open it, so set `APP_PASSCODE` whenever the server is reachable
from the internet. Wrong passcodes are limited to 10 per address every 5 minutes (on the start page,
the board connection and uploads together), so the passcode cannot be guessed by trying many.
Image uploads are limited to 120 per minute per address.

### Your data on disk

- Each board is `DATA_DIR/<code>.json` (its name and list of pages) plus one file per page in
  `DATA_DIR/<code>.pages/`. A save rewrites only the pages that changed. Boards saved by older
  versions (a single `<code>.json`) open as they are and are converted the first time they change.
- **Nothing is lost to one bad object.** If a file was damaged (by hand-editing, a full disk…),
  everything valid in it still opens; only the broken objects are left out, they are listed in the
  server log, and the original file is kept next to it as `<file>.corrupt-<date>`.
- **Backups before big changes.** Before *Restore from a backup* or *Restore from this device*
  replaces a board, and before the notebook-wide *Clear ink* / *Cover all tape*, the server writes
  `DATA_DIR/<code>.backup-<date>.json` (the newest five are kept per board). To go back to one,
  stop the server and copy it over `<code>.json`.
- Images live in `DATA_DIR/uploads/<code>/`. Images no board refers to any more (and none of its
  backups) are deleted after a day, on startup and then daily. A board that did not open cleanly is
  never swept.
- Boards nobody has open are dropped from memory after five minutes (once saved). Opening a link
  to a board that does not exist creates nothing on disk until something is drawn.

## Sharing it with your co-teacher

### Option A — run it on your own computer (easiest, free, recommended)

Your data stays on your disk; a tunnel gives your co-teacher an https link.

1. `npm run build && npm start` (set a passcode: `APP_PASSCODE=something npm start`;
   in PowerShell: `$env:APP_PASSCODE='something'; npm start`).
2. Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) and run

   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```

3. It prints a `https://<random-words>.trycloudflare.com` address. Open it, create a board, press
   **Share**, and send that link.

The quick-tunnel address **changes every time** you start `cloudflared`, and board links contain
the address — so after a restart, send the new address with the same `/b/<code>` ending. Your
boards are all still there.

For a permanent address you need a domain managed by Cloudflare (free plan is fine):

```bash
cloudflared tunnel login
cloudflared tunnel create mathboard
cloudflared tunnel route dns mathboard board.yourdomain.com
cloudflared tunnel run --url http://localhost:3000 mathboard
```

After that, `https://board.yourdomain.com` always reaches your computer while `npm start` and
`cloudflared tunnel run …` are running.

### Option B — always-on hosting

Any host that runs a long-lived Node process with WebSockets works. Two things to know first:

- **Free tiers sleep.** After a period with no visitors the server is stopped; the next visit takes
  up to a minute to wake it.
- **Free tiers usually do not keep files.** Unless a persistent disk / volume is attached and
  `DATA_DIR` points at it, every restart or redeploy starts with an empty `data` folder.

MathBoard is built to survive that: every browser keeps a copy of the boards it has open
(IndexedDB, images included). If the server comes back empty or with an older copy, the app asks
**"Restore this board from this device?"** and one click uploads everything again. For a second
safety net use **☰ → Back up notebook (.json)** after class; **Restore from a backup…** loads it
into any board.

**Render**

1. Push this repository to GitHub and create a *Web Service* from it.
2. Build command: `npm install --include=dev && npm run build` — Start command: `npm start`.
3. Environment: `APP_PASSCODE` = your passcode, `NODE_VERSION` = `22`.
4. To keep data across restarts add a *Disk* (paid plans), mount it at `/var/data`, and set
   `DATA_DIR=/var/data`. Without a disk, rely on the restore prompt and JSON backups.

**Railway**

1. *New project → Deploy from GitHub repo.* Railway detects Node and runs `npm run build` and
   `npm start`; `PORT` is provided automatically.
2. Variables: `APP_PASSCODE`, and `DATA_DIR=/data`.
3. Add a *Volume* mounted at `/data` so notebooks and uploads survive redeploys.
4. *Settings → Networking → Generate domain* for the public address.

**Docker**

```bash
docker build -t mathboard .
docker run -d -p 3000:3000 -v mathboard-data:/data -e APP_PASSCODE=something mathboard
```

The image stores everything in `/data`; keep that on a volume.

## Teaching guide

### Sharing on Zoom

- Share the **browser window** (not the whole screen), and press **F** for Focus mode: the sidebar
  and toolbar collapse into a small floating bar with your pens, highlighter, eraser, lasso and
  undo, so students see almost nothing but the board. Press F again (or Esc) to leave.
- The board works well at 1280×720, which is what Zoom shares.
- Only the person sharing needs to be visible to students; the other teacher's ink, cursor, laser
  and ruler all show up in the shared window as they happen.
- Click a collaborator's chip (top right) to **follow** them: your page and view track theirs until
  you pan, draw or click.
- Dark mode is per person. Black ("ink") shows as white on a dark board, so the board looks right
  for both of you whichever theme each uses.

### Pen tablets and styluses

- **Wacom and other tablets on Windows:** keep *Windows Ink* enabled in the tablet driver for your
  browser — that is what delivers pressure to web pages. If strokes have no pressure variation,
  that setting is the first thing to check. Use Chrome or Edge.
- **Surface Pen / other active pens:** flip the pen to use the **eraser end** — it erases with the
  current eraser mode without switching tools. Hold the **barrel button** while dragging to lasso;
  release and drag the selection to move it.
- **iPad + Apple Pencil (Safari):** the pencil draws, one finger pans, two fingers pinch-zoom. Once a
  pen has been used, fingers never draw (palm rejection).
- **Install it on the iPad:** in Safari tap **Share → Add to Home Screen**. It gets the MathBoard
  icon and opens full screen without Safari's bars, on the start page with your recent boards
  (each listed with its name). Chrome and Edge on a computer offer *Install* in the address bar too.
- **Touch only (no pen):** turn on **☰ → Settings → Draw with finger**. Two fingers still pan and
  zoom.
- **Mouse:** left button draws, middle-drag or Space+drag pans, the wheel scrolls, Shift+wheel
  scrolls sideways, Ctrl/Cmd+wheel (or a trackpad pinch) zooms toward the cursor.

### Setting up your pens

The row of pens in the toolbar is yours (saved in this browser). Click a pen to use it; **click it
again** to open its settings: type, colour (16 swatches, custom, recent), thickness (five presets
and a fine slider with a live preview) and stabilization. **+** adds a pen (up to 15); drag pens to
reorder them, or use the arrows and *Delete pen* in the popover. Keys **1–9** pick pens 1–9.
The same "click the selected tool again" rule opens the settings of the highlighter, eraser,
lasso, shapes, laser, insert-space, text, axes and tape tools.

Handy pen behaviours:

- **Draw and hold:** finish a stroke and keep the pen still for half a second — it snaps to a
  straight line (or the shape you drew). Keep the pen down to adjust the end point or size.
- **Ink to shape** (✨ in the toolbar, on by default) cleans up a single-stroke line, arrow,
  triangle, rectangle, polygon or circle. One Ctrl+Z gives you the original ink back.
- **Ruler / protractor:** strokes that start at the ruler's edge are perfectly straight. Rotate it
  with its knob, Alt+wheel, or two fingers; it snaps at 0°, 15°, 30°, 45°, 60°, 90°.
- **Highlighter** ink always goes underneath the writing. Hold Shift for a straight highlight.

### Keyboard shortcuts

Press **?** in the app for this list.

| Key | Action |
|---|---|
| P | Pen (last used favorite) |
| 1–9 | Pen favorites |
| H | Highlighter |
| E | Eraser (press again to switch stroke / partial) |
| V or S | Lasso select |
| R | Ruler on / off (re-opens the ruler or protractor, whichever was used last) |
| Shift+P | Protractor on / off |
| Shift+R | Shapes |
| L | Laser pointer |
| T | Text |
| G | Graph |
| A | Axes (press again to switch between x–y axes and a number line) |
| K | Tape |
| I | Insert / remove space |
| [ / ] | Thinner / thicker |
| F | Focus mode |
| Delete | Delete selection |
| Arrow keys | Nudge selection (Shift: bigger steps) |
| Ctrl/Cmd + Z | Undo |
| Ctrl/Cmd + Shift + Z, Ctrl + Y | Redo |
| Ctrl/Cmd + C / X / V | Copy / cut / paste (V also pastes screenshots and text) |
| Ctrl/Cmd + D | Duplicate |
| Ctrl/Cmd + A | Select everything that is not locked |
| Ctrl/Cmd + 0 | Reset zoom to 100% |
| Ctrl/Cmd + + / − | Zoom in / out |
| Space + drag, middle-drag | Pan |
| PageUp / PageDown | Previous / next page |
| Esc | Cancel, deselect, stop following, leave focus mode |
| ? | Shortcut list |

### A typical class

0. **Name the board** — click *Untitled* at the top right (e.g. "Algebra 2 — Period 3"). The name
   shows in the browser tab, in *Recent boards* on the start page and in exported file names.
1. **New page per question** — *Add page* in the sidebar (double-click a title to rename it).
   Deleted a page by mistake? Click **Undo** in the message that appears (about ten seconds).
2. **Paste the homework** — copy a screenshot (Snipping Tool, Cmd+Shift+4…) and press Ctrl/Cmd+V.
   It lands in the middle of the view for both of you and is **locked**, so writing on it never
   moves it. (To move or delete it: lasso tool → click it → unlock.)
3. **Solve on top** with your pens; highlight the important line.
4. **Ruler, shapes, axes or the graph** when a picture helps: drag out axes and plot by hand, or
   drag out a graph and type `y = 2x^2 - 3x + 1`. Unknown letters (`y = a x^2 + b`) become sliders.
5. **Tape over the answer** — draw a tape strip across it; click the tape to reveal it for
   everyone ("try it first, then we'll check").
6. Need more room in the middle of a solution? **Insert space** and drag down.
7. After class: **☰ → Export as PDF…** for the students — this page or the whole notebook, sized
   to the content or on Letter / A4 (tall pages continue on more sheets instead of shrinking), with
   the answers still covered or an answer-key copy, on white or on the page's grid. Ink stays sharp
   when the PDF is zoomed. **Back up notebook** for you, and **Replay this page's ink** to review a
   solution step by step.

Other handy things: **select → copy** (Ctrl/Cmd+C) and paste into another tab or another board —
images come along. Select a shape to change its dashes, fill colour and fill opacity. Change your
name in **☰ → Settings**; everyone sees it at once. Dark mode starts from your system setting.

## How it works (short version)

- `shared/` — data model, op reducer and inverse ops (undo), geometry, eraser splitting, shape
  recognition, ruler math, graph parser/sampler. Used by the client, the server and the tests.
- `server/` — Express + Socket.IO. Holds each notebook in memory, validates every message with
  zod, saves debounced and atomically to `DATA_DIR`.
- `client/src/engine/` — the canvas engine: three stacked canvases (background, committed ink,
  live layer), pointer input and tools, sync with an offline queue, IndexedDB safety copy.
- `client/src/ui/` — React chrome only (toolbar, panels, dialogs).

See [PLAN.md](./PLAN.md) for the architecture, protocol and rendering strategy.

## Known limitations

- Conflicts are last-writer-wins per object. Two people can always draw at once, but if both move
  or edit the *same* object in the same instant, the later change wins.
- Undo history is per browser tab and is not kept across a page reload.
- Copied board objects travel through the system clipboard as text (up to about 4 MB, e.g. a few
  thousand strokes); a larger selection still pastes within the same tab.
- In the PDF, ink and shapes are vector paths; images, text, graphs, axes and tape are embedded as
  pictures at print resolution (300 dpi or more, never above the image's own resolution).
- Anyone with a board link (and the passcode, if set) can edit — there are no view-only links.
  Students are expected to watch the Zoom share.
