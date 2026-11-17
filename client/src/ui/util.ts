import type { Engine, OpBody } from '../engine/Engine';

/** localStorage that never throws (private browsing, blocked storage…). */
export const ls = {
  get(key: string): string | null {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key: string, value: string) {
    try { localStorage.setItem(key, value); } catch { /* ignore */ }
  },
  del(key: string) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  },
};

/** Copies text to the system clipboard, with a fallback for non-secure origins (e.g. a LAN IP). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Opens the system file chooser. Resolves with [] when nothing was chosen. */
export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(input);
    let done = false;
    const finish = (files: File[]) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => finish(Array.from(input.files ?? [])));
    input.addEventListener('cancel', () => finish([]));
    input.click();
  });
}

/**
 * Turns a stream of small commits (dragging a slider, typing an expression) into
 * ONE undo step: the inverse of the first commit restores the state from before
 * the whole interaction.
 */
export class UndoGroup {
  private inverse: OpBody[] | null = null;
  constructor(private engine: Engine) {}
  apply(ops: OpBody[]) {
    const inv = this.engine.commit(ops, { undo: false });
    if (!this.inverse) this.inverse = inv;
  }
  end() {
    if (this.inverse?.length) this.engine.pushUndo(this.inverse);
    this.inverse = null;
  }
}

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export const initials = (name: string) => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2)).toUpperCase();
};
