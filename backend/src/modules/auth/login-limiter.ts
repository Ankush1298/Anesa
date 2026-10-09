import { createHash } from 'node:crypto';

export interface LoginLimiterOptions {
  /** Failed attempts per client IP per window (any account). */
  maxPerIp?: number;
  /** Failed attempts per (client IP, account) per window. */
  maxPerIpAccount?: number;
  windowMs?: number;
  /** Hard cap on tracked keys; expired entries are swept first, then the oldest are evicted. */
  maxKeys?: number;
  now?: () => number;
}

interface Entry {
  count: number;
  resetAt: number;
}

/**
 * In-memory fixed-window limiter for POST /auth/login, in addition to the per-account lock in the
 * database. Keys never contain the raw e-mail (SHA-256), the decision never depends on whether the
 * account exists (no enumeration), and an attacker's IP can only burn its OWN (ip, account)
 * budget, so it cannot lock a victim out from the victim's own IP.
 * ponytail: single process only. For several backend instances move the counters to a shared store
 * (PostgreSQL/Redis); the interface (check / recordFailure / recordSuccess) stays the same.
 */
export class LoginRateLimiter {
  private readonly maxPerIp: number;
  private readonly maxPerIpAccount: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();

  constructor(o: LoginLimiterOptions = {}) {
    this.maxPerIp = o.maxPerIp ?? 20;
    this.maxPerIpAccount = o.maxPerIpAccount ?? 5;
    this.windowMs = o.windowMs ?? 15 * 60_000;
    this.maxKeys = o.maxKeys ?? 10_000;
    this.now = o.now ?? Date.now;
  }

  private static accountKey(ip: string, email: string): string {
    const h = createHash('sha256').update(email.trim().toLowerCase()).digest('base64url');
    return `a:${ip}:${h}`;
  }

  private live(key: string): Entry | undefined {
    const e = this.entries.get(key);
    if (e && e.resetAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return e;
  }

  /** Seconds the caller must wait, or 0 when the attempt may proceed. */
  check(ip: string, email: string): number {
    let wait = 0;
    for (const [key, max] of [
      [`i:${ip}`, this.maxPerIp],
      [LoginRateLimiter.accountKey(ip, email), this.maxPerIpAccount],
    ] as const) {
      const e = this.live(key);
      if (e && e.count >= max) wait = Math.max(wait, Math.ceil((e.resetAt - this.now()) / 1000));
    }
    return wait;
  }

  recordFailure(ip: string, email: string): void {
    for (const key of [`i:${ip}`, LoginRateLimiter.accountKey(ip, email)]) {
      const e = this.live(key);
      if (e) e.count += 1;
      else this.insert(key, { count: 1, resetAt: this.now() + this.windowMs });
    }
  }

  /** A success clears only the (ip, account) budget. The per-IP budget is deliberately not reset. */
  recordSuccess(ip: string, email: string): void {
    this.entries.delete(LoginRateLimiter.accountKey(ip, email));
  }

  get size(): number {
    return this.entries.size;
  }

  private insert(key: string, entry: Entry): void {
    if (this.entries.size >= this.maxKeys) {
      const t = this.now();
      for (const [k, e] of this.entries) if (e.resetAt <= t) this.entries.delete(k);
      // Map iterates in insertion order, so the first keys are the oldest.
      for (const k of this.entries.keys()) {
        if (this.entries.size < this.maxKeys) break;
        this.entries.delete(k);
      }
    }
    this.entries.set(key, entry);
  }
}
