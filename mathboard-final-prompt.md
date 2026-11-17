# PROMPT — Finish MathBoard: fix, harden, and add the last features

## 1. Context

You are working in an existing repository: **MathBoard**, a real-time collaborative pen whiteboard that my brother and I use to co-teach math homework-help classes over Zoom. One of us shares the browser window; both of us write on the same board at once from different computers. Students only watch the Zoom share.

The app already works end to end. Everything in `mathboard-master-prompt.md` (the original spec) is built, 77 unit and integration tests pass, and typecheck and build are clean. This session is the last one: when you finish, the project should be something we use in class without further development.

Read these before changing anything:

1. `mathboard-master-prompt.md` — the original requirements. Its tech stack, quality bar and out-of-scope list still apply.
2. `PLAN.md` — architecture, socket protocol, rendering strategy.
3. `README.md` — what users are told the app does.
4. The code itself: `shared/`, `server/`, `client/src/engine/`, `client/src/ui/`, `tests/`.

Then run `npm install`, `npm test`, `npm run typecheck` and `npm run build`, and start `npm run dev` to look at the app in a browser before you begin. Fix anything that is red first.

## 2. Ground rules

- **Do not regress the pen.** Ink feel, local latency and live remote strokes are the product. Do not restructure the ink pipeline, the three-canvas renderer or the dirty-rectangle logic unless a task below requires it. After any change near them, run `tests/browser/repaint.mjs` and `tests/browser/smoke.mjs`.
- **Keep the stack and architecture.** One repo, one `package.json`, TypeScript, Vite + React for chrome only, Canvas 2D for all drawing, Express + Socket.IO, JSON files on disk. No database, no accounts, no paid services, no API keys, no whiteboard frameworks.
- **Still out of scope:** handwriting recognition, ink-to-text, ink-to-math, LaTeX or equation editors, AI features.
- **Shared logic goes in `shared/`** so client, server and tests use the same code.
- **Every new or changed socket message, op or stored field** gets a zod schema in `server/schema.ts`, a type in `shared/types.ts`, and a test. Old notebook files must still load: new fields are optional with sensible defaults.
- **Everything that changes the board must sync live to the other user and survive a reload.** Object changes must be undoable through the existing per-user undo; where a task says something else, follow the task.
- **No stubs, TODOs or dead buttons.** If something cannot be done well, leave it out and say so in the final report.
- **Add a test for every bug fixed and every behaviour added.** Pure logic gets a vitest unit test; protocol changes get a case in `tests/server.test.ts`; UI flows get a check in `tests/browser/`.
- Work through Parts A to D in order. Finish and verify each part before starting the next. Part D is optional and only starts when A to C are complete and green.
- Commit at the end of each part on a new branch named `final`, with a message that says what changed. Do not push.

## 3. Part A — data safety and server hardening

These protect against losing a board. Do them first.

1. **One bad object must not blank a notebook.** `Store.load` in `server/store.ts` validates the whole file at once; on failure it copies the file to `.corrupt` and starts an empty notebook. Change it to salvage: validate page by page and object by object, drop only what fails, log what was dropped, and keep a timestamped copy of the original file whenever anything was dropped.
2. **Reject updates that produce an invalid object.** The `update` patch schema is not checked against the object's type, so a patch such as `points: []` on a shape passes validation and is saved, and the file then fails to load. On the server, validate the merged object with the `boardObject` schema after applying an `update`; if it fails, do not apply the op, and still acknowledge it so the client's queue drains. Also guard `move` so coordinates cannot leave the schema's numeric range.
3. **Back up before `restore`.** The `restore` handler in `server/app.ts` replaces the whole notebook with whatever a client sends. Before applying it, write the current notebook to a timestamped backup file next to it and keep the newest five per notebook.
4. **Evict idle rooms.** `Store.rooms` never shrinks, and joining any unknown id creates a room. When the last socket leaves a notebook and its save has flushed, remove it from memory. A join during eviction must not lose data. Never write a file for a notebook that was joined but never changed.
5. **Rate limits and quotas.** Limit `POST /api/passcode` and failed socket handshakes per IP so the passcode cannot be brute-forced. Limit uploads per IP per minute, and cap total upload bytes per notebook with a clear error message shown to the user. Implement this in-process, without a new service.
6. **Clean up orphaned uploads.** Image files are never deleted. Add a sweep, on startup and then daily, that removes files under `uploads/<notebookId>/` that no object in that notebook references and that are more than 24 hours old. Never delete a file for a notebook that failed to load.
7. **Save cost.** Each save stringifies the whole notebook, up to once a second while someone draws. Measure the event-loop stall with a notebook of 20 pages and 5,000 strokes per page. If a save blocks for more than about 30 ms, reduce it, for example with a longer maximum wait under continuous edits or one file per page. If you change the on-disk format, old files must still load. Put the measurement in the final report.

## 4. Part B — fixes and changes to existing features

Each item is something I found by reading the code. Confirm it in the running app, then fix it.

1. **Board names.** `Notebook.title` exists but cannot be seen or edited anywhere; only the PDF filename reads it. Add an editable title in the top bar that syncs live through a new validated op. Use it for the browser tab title and export filenames. Show it in the landing page's "Recent boards" list next to the code; keep the title in the localStorage recent list and refresh it whenever a board is opened.
2. **Dropped and pasted images pile up.** `placeImage` always centres an image in the view, so dropping several files stacks them exactly on top of each other, and a drop ignores where the cursor was. Place a dropped image at the drop point. When several arrive together, lay them out so none hides another. On paste, insert every image on the clipboard, not only the first.
3. **Copy and paste across tabs and boards.** The system clipboard only receives a token, so pasting board objects into another tab or another board shows "copied in another window". Put the serialised objects on the clipboard, validate them on paste with the same rules the server uses, cap the size, and make paste work across tabs and across boards, including images.
4. **Edit a shape after drawing it.** The selection bar can change colour and thickness only. Add dashed on/off, fill colour and fill opacity for selected shapes, matching the shape tool's popover. Slider drags collapse into one undo step, as thickness already does.
5. **Deleting a page must be recoverable.** The confirm dialog says deletion "cannot be undone", and no page operation is undoable. After a delete, show a toast with **Undo** for about ten seconds that restores the page with all its content at its old position for everyone. Keep the confirm dialog only for pages that have content.
6. **Change my name without leaving.** Settings tells me to leave the board to rename myself. Make the name editable in Settings; presence chips and my remote cursor label update live for everyone.
7. **Focus mode needs the laser.** The focus bar has pens, highlighter, eraser, lasso and undo. Add the laser pointer.
8. **Missing shortcuts.** Tape, axes, insert-space and protractor have none. Add keys that do not conflict with existing ones (suggested: K tape, A axes, I insert space, Shift+P protractor). Update the tooltips, the `?` overlay and the README table.
9. **Export options.** PDF export sizes each PDF page to its content, so pages come out in different sizes, some very small, and it always exports the whole notebook as a JPEG raster. Add a small export dialog:
   - Scope: this page or the whole notebook.
   - Paper: fit to content (today's behaviour), Letter, or A4, with the content fitted inside margins. Content much taller than one sheet is split across sheets instead of being shrunk until it is unreadable.
   - Tape: keep answers covered, or reveal everything (an answer-key copy).
   - Background: plain white, or include the page's grid, lines or dots.
   - Ink must stay sharp when zoomed in the PDF: draw strokes and shapes as vector paths, or raster at 300 dpi or more for the chosen paper.
   PNG export gets the same tape and background options.
10. **Toolbar at 1280×720.** That is the size Zoom shares. With 15 pen favourites, three collaborators connected and the sidebar open, check that nothing in the top bar overflows, wraps or is clipped. If it does, group buttons (for example ruler and protractor in one button, and graph, axes, tape and image in an "Insert" flyout) until it fits. Screenshot before and after.
11. **Follow the system theme on first visit.** Dark mode is a manual toggle only. When there is no saved setting, start from `prefers-color-scheme`.
12. **Installable on iPad.** The README recommends "Add to Home Screen", but there is no web app manifest. Add a manifest, icons and the Apple meta tags so it opens full-screen with a proper name and icon.
13. **Smaller first load.** The main bundle is about 1 MB, largely because `shared/graph.ts` builds mathjs with `create(all)` while using only parse and compile with its own function whitelist. Import only what is needed, or load the graph code on first use. Graph tests must still pass. Report bundle sizes before and after.
14. **Housekeeping.** Add a GitHub Actions workflow that runs `npm ci`, test, typecheck and build. Delete `HANDOFF.md`, which describes work that is already done. Bring `PLAN.md` and `README.md` up to date with everything in this prompt.

## 5. Part C — new features

Build all of these, in this order.

1. **Page thumbnails in the sidebar.** Each row shows a small live preview of its page. Render off the main path (idle time, debounced after edits, cached per page) so drawing never stutters; measure a frame trace while drawing on a 5,000-stroke page with the sidebar open. Keep the page number, title, presence dots and the menu.
2. **Bring everyone here.** Follow mode is pull-only. Add a button near the presence chips that brings every other editor to my page and view once, with a toast on their side such as "Alex brought you to page 3". It does not start a persistent follow, and it never interrupts a stroke in progress: wait until their pen lifts.
3. **Reset for the next class.** We reuse prepared pages across class sections. Add, in the ☰ menu and the eraser popover:
   - "Clear ink, keep everything else" for this page: removes strokes and shapes that are not locked; keeps images, graphs, axes, text and tape.
   - The same for the whole notebook, with a confirm that states how many pages are affected.
   - "Cover all tape again" for this page and for the notebook.
   The per-page actions are undoable. The notebook-wide actions write a server-side backup first, using the mechanism from Part A item 3.
4. **Shared countdown timer.** A small draggable timer on the board that both teachers and the Zoom audience see. Presets of 1, 2, 5 and 10 minutes plus a custom time; start, pause, reset and dismiss. State lives on the server per notebook, so a late joiner or a reconnecting client sees the correct remaining time. It is not saved to disk. It shows a clear visual finish and makes no sound by default. It stays visible in focus mode.
5. **Graph upgrades.** Keep the parser's whitelist approach; nothing typed by a collaborator may execute arbitrary mathjs functions.
   - **Degrees or radians** toggle per graph, applied to trig and inverse trig.
   - **Domain restrictions:** `y = x^2 {x > 0}` and `y = 2x + 1 {-1 <= x <= 3}`.
   - **Implicit relations:** `x^2 + y^2 = 25` and `x^2/9 + y^2/4 = 1`, drawn by contouring, with no stray segments and no crash on bad input.
   - **Points of interest:** with the graph selected, tapping a curve shows the coordinates at that point; x-intercepts, the y-intercept, turning points and intersections between visible curves are marked and show their coordinates on hover or tap. This is display only and adds nothing to the board.
   - **π tick labels:** an option to label the x-axis in multiples of π (π/2, π, 3π/2 and so on), for trig graphs.
   - **Slider play button** that animates a slider back and forth, synced live.
   - **Math keys:** a compact row above the expression input with `^ √ π ≤ ≥ |x| ( )`, for iPad, where these are hard to type.
   Extend `tests/graph.test.ts` for each of these.
6. **Axes upgrades.** In the axes panel: presets for four quadrants and first quadrant only; optional light grid lines inside the axes box; editable axis labels that default to x and y; the same π tick option as the graph.
7. **Crop images.** Homework screenshots usually need trimming. With one image selected, a Crop action shows crop handles; confirming stores a non-destructive crop rectangle on the image object. The original file is untouched and the crop can be reset. Rendering, hit-testing, selection bounds, export and duplication all respect the crop. It is undoable and synced.
8. **Touch undo gestures.** On touch devices, a two-finger tap undoes and a three-finger tap redoes, as in GoodNotes and Procreate. These must never fire during a pinch or pan, and never draw.
9. **Hold-for-laser.** Holding a key (suggest holding L for longer than about 250 ms) switches to the laser while it is held and returns to the previous tool on release. A quick press still switches tools as it does today.

## 6. Part D — optional, only when A to C are complete and verified

1. **View-only link.** A second share link for students to review a board after class. The server enforces it: sockets joined as viewers have every mutating message dropped, and they cannot upload. The view link must not reveal the edit code, so use an opaque id with a persisted mapping. Viewers can pan, zoom, switch pages, follow a teacher, use ink replay and export. They are shown as a count ("3 watching"), not as editor chips, and do not take an editor colour. The passcode still applies when set.
2. **Compass tool.** Beside the ruler and protractor: set a centre and radius, then draw arcs and full circles that snap to that radius. Visible to the other user like the ruler.
3. **More page backgrounds.** Isometric dots, polar grid and an adjustable grid size.

## 7. Verification, required before you say you are done

1. `npm test`, `npm run typecheck` and `npm run build` pass with zero errors and zero warnings you introduced.
2. All existing tests still pass unchanged, or were changed deliberately with the reason stated.
3. New tests exist for every item in Parts A, B and C, as described in the ground rules.
4. Run the production build (`npm run build && npm start`) and check in two browser windows, using your browser tooling:
   - every item in Parts B and C, in both directions between the two windows;
   - reload persistence, and an offline-then-reconnect cycle while drawing;
   - a server restart while both windows are open;
   - light and dark mode, and a 1280×720 window;
   - the original P0 flows from section 10 of the master prompt, to confirm nothing regressed.
5. Load a notebook file saved before your changes and confirm it opens intact.
6. Run all four scripts in `tests/browser/` and report their results.
7. If Docker is available, build and run the image and open a board in it. If it is not, say so.

## 8. Final report

End with a report that contains:

- What changed, grouped by part, one line per item, each marked done, partly done or not done.
- Test counts before and after, and the browser-script results.
- The measurements asked for above: save stall, bundle sizes, the frame trace with thumbnails.
- Anything you could not verify, stated plainly. Real pen hardware, iPad Safari, Firefox and Safari cannot be tested from your environment, so give me a short checklist of exactly what to try on a Wacom or Surface pen and on an iPad with Apple Pencil, covering the things most likely to differ there: pressure, palm rejection, eraser end, barrel button, the new touch gestures, and Add to Home Screen.
- Known limitations that remain, honestly listed.

Do not stop after planning or after Part A. Keep going until Parts A, B and C are implemented and verified.
