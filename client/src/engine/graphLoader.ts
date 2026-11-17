// The graph renderer (and with it the expression parser) is loaded the first time a graph is
// needed, so the first load of the app stays small.
type GraphModule = typeof import('./graphRender');

let mod: GraphModule | null = null;
let loading: Promise<GraphModule> | null = null;
const listeners = new Set<() => void>();

export function loadGraph(): Promise<GraphModule> {
  if (!loading) {
    loading = import('./graphRender').then((m) => {
      mod = m;
      for (const l of listeners) l();
      return m;
    });
    loading.catch(() => { loading = null; }); // a failed download (offline) is retried next time
  }
  return loading;
}

/** The graph module if it is already loaded; otherwise starts loading it and returns null. */
export function graphModule(): GraphModule | null {
  if (!mod) void loadGraph().catch(() => {});
  return mod;
}

/** Called once the module has arrived (to repaint graphs that were shown as placeholders). */
export function onGraphLoaded(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
