// In-process rate limiting. No external service: a small fixed-window counter per key.

export class RateLimiter {
  private hits = new Map<string, { n: number; resetAt: number }>();

  constructor(readonly limit: number, readonly windowMs: number, private now: () => number = Date.now) {}

  private entry(key: string) {
    const t = this.now();
    let e = this.hits.get(key);
    if (!e || t >= e.resetAt) {
      e = { n: 0, resetAt: t + this.windowMs };
      this.hits.set(key, e);
      if (this.hits.size > 5000) this.prune();
    }
    return e;
  }

  /** true when the key has used up its allowance for the current window */
  blocked(key: string): boolean {
    const e = this.hits.get(key);
    return !!e && this.now() < e.resetAt && e.n >= this.limit;
  }

  /** Counts one event. Returns false when the event itself is over the limit. */
  hit(key: string): boolean {
    const e = this.entry(key);
    e.n++;
    return e.n <= this.limit;
  }

  /** Seconds until the key may try again (at least 1). */
  retryAfter(key: string): number {
    const e = this.hits.get(key);
    return e ? Math.max(1, Math.ceil((e.resetAt - this.now()) / 1000)) : 1;
  }

  prune() {
    const t = this.now();
    for (const [k, e] of this.hits) if (t >= e.resetAt) this.hits.delete(k);
  }
}

const normalizeIp = (ip: string) => {
  let s = ip.trim().toLowerCase();
  if (s.startsWith('::ffff:') && s.includes('.')) s = s.slice(7); // IPv4 mapped into IPv6
  return s;
};

/** Loopback, private and link-local addresses: where a reverse proxy or tunnel on the same host / network sits. */
export function isLocalAddress(ip: string): boolean {
  const s = normalizeIp(ip);
  if (s === '::1' || s === 'localhost') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return /^f[cd][0-9a-f]{2}:/.test(s) || /^fe[89ab][0-9a-f]:/.test(s);
}

/**
 * The address to rate-limit by. `X-Forwarded-For` is only believed when the connection itself
 * comes from a local address (cloudflared, a platform proxy): a client that connects directly
 * cannot hide behind a made-up header. `trustProxy: false` never looks at the header.
 */
export function clientIp(remoteAddress: string | undefined, forwardedFor: string | string[] | undefined, trustProxy = true): string {
  let ip = normalizeIp(remoteAddress || 'unknown');
  if (!trustProxy || !forwardedFor || !isLocalAddress(ip)) return ip;
  const parts = (Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor).split(',').map((p) => normalizeIp(p)).filter(Boolean);
  // walk from the nearest hop outwards, stopping at the first address that is not one of ours
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].length > 64) break;
    ip = parts[i];
    if (!isLocalAddress(ip)) break;
  }
  return ip;
}
