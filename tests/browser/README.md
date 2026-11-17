# Browser checks

End-to-end scripts that drive real browser windows. They are not part of `npm test`
(which needs no browser); run them by hand after changing the engine or the UI.

```bash
npm install --no-save playwright-core   # drives an installed Chrome; nothing is downloaded
npm run build && npm start              # in another terminal (port 3000)

node tests/browser/smoke.mjs            # live sync basics, two browsers
node tests/browser/features.mjs         # every tool, menu and export
node tests/browser/repaint.mjs          # incremental repaint == full repaint (try DPR=1.5 and DPR=2)
node tests/browser/resilience.mjs       # starts its own server on :3412 from dist/
```

- `BASE` — address of the running app (default `http://localhost:3000`).
- `BROWSER_CHANNEL` — `chrome` (default) or `msedge`.
- `SHOTS` — where screenshots go (default: a `mathboard-shots` folder in the temp directory).

Each script prints `OK` / `FAIL` per step and the browser console errors it collected.
The frame times printed by `resilience.mjs` come from a headless browser; treat them as
relative numbers.
