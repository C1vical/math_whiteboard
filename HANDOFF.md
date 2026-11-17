# MathBoard handoff

This repository contains the work completed so far on MathBoard, a collaborative
math whiteboard. Continue development from this commit rather than starting over.

## Read first

1. [`mathboard-master-prompt.md`](./mathboard-master-prompt.md) — product requirements,
   constraints, priorities, and the intended tech stack.
2. [`PLAN.md`](./PLAN.md) — the current architecture, protocol, data model, and
   milestone outline.
3. `package.json` — available development commands and dependencies.

## Current state

- **Update (second session):** the client now has its entry point, landing screen, full UI
  chrome and styles, a README and a Dockerfile, and the app runs end to end. Everything in
  the master prompt's P0 and P1 lists is wired to the UI and was exercised in two browser
  sessions. See "Not verified here" at the end of `PLAN.md` for what still needs a real
  pen, an iPad, Firefox/Safari and a Docker host. The committed-layer rendering was
  reworked for performance (see "Rendering" in `PLAN.md`).
- The project is a TypeScript/Vite client with a Node/Express/Socket.IO server.
- Shared drawing, geometry, operation, recognition, ruler, graph, and image-sizing
  modules are under `shared/`.
- Client engine code is under `client/src/engine/`; UI code is under `client/src/ui/`.
- Server code is under `server/`.
- Unit and integration tests are under `tests/`.
- `node_modules/` is intentionally ignored; install dependencies with `npm install`
  if needed.
- The repository was published at
  <https://github.com/C1vical/math_whiteboard> on the `main` branch.

## First steps

From the repository root, run:

```bash
npm test
npm run typecheck
npm run build
```

Fix any failures before adding features. Then run the app with:

```bash
npm run dev
```

Verify the actual browser experience, especially pointer input, live collaboration,
paste/import behavior, and reconnect behavior. Do not assume that a feature is
finished just because a helper or protocol type exists.

## Recommended continuation order

1. Establish a working end-to-end single-user board: canvas mounting, pointer input,
   rendering, tool selection, and persistence.
2. Verify two browser sessions can join the same notebook and see live strokes,
   committed operations, presence, and reconnect recovery.
3. Complete the P0 pen experience from the master prompt before broadening the tool
   set: pressure, coalesced pointer events, touch/palm behavior, erasers, undo,
   selection, and smooth rendering.
4. Implement remaining milestones in the order documented in `PLAN.md`: pages and
   images, backgrounds and text, graph/axes tools, import/export, and polish.
5. Add focused tests for every bug fixed or behavior introduced, and keep
   `npm test`, `npm run typecheck`, and `npm run build` passing.

## Working guidelines

- Preserve the single-repo TypeScript architecture unless there is a compelling
  reason to change it.
- Keep shared behavior in `shared/` so client and server use the same data model and
  math.
- Validate all incoming socket data on the server with the existing schema approach.
- Keep drawing on Canvas 2D; do not introduce a third-party whiteboard framework.
- Avoid API keys, paid services, user accounts, or committing generated data.
- Update `PLAN.md` when the architecture or milestone status changes.
