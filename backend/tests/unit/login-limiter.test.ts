import { describe, expect, it } from 'vitest';
import { LoginRateLimiter } from '../../src/modules/auth/login-limiter.js';

const clock = () => {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};
const fail = (l: LoginRateLimiter, ip: string, email: string, n: number) => {
  for (let i = 0; i < n; i++) l.recordFailure(ip, email);
};

describe('LoginRateLimiter', () => {
  it('blocks an (ip, account) pair after 5 failures, not before, with a bounded Retry-After', () => {
    const c = clock();
    const l = new LoginRateLimiter({ now: c.now });
    fail(l, '1.1.1.1', 'v@x.edu', 4);
    expect(l.check('1.1.1.1', 'v@x.edu')).toBe(0);
    fail(l, '1.1.1.1', 'v@x.edu', 1);
    const wait = l.check('1.1.1.1', 'v@x.edu');
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(15 * 60);
  });

  it("an attacker's failures never block the victim from another IP, and other accounts from the attacker's IP stay usable", () => {
    const l = new LoginRateLimiter({ now: clock().now });
    fail(l, '6.6.6.6', 'victim@x.edu', 50);
    expect(l.check('2.2.2.2', 'victim@x.edu')).toBe(0); // victim, own IP
    expect(l.check('6.6.6.6', 'someone@x.edu')).toBeGreaterThan(0); // per-IP cap (20) was exceeded by the burst
    const l2 = new LoginRateLimiter({ now: clock().now });
    fail(l2, '6.6.6.6', 'victim@x.edu', 5);
    expect(l2.check('6.6.6.6', 'victim@x.edu')).toBeGreaterThan(0);
    expect(l2.check('6.6.6.6', 'other@x.edu')).toBe(0); // only the pair is blocked at 5
  });

  it('blocks a whole IP after 20 failures across accounts (password spraying)', () => {
    const l = new LoginRateLimiter({ now: clock().now });
    for (let i = 0; i < 20; i++) l.recordFailure('7.7.7.7', `user${i}@x.edu`);
    expect(l.check('7.7.7.7', 'fresh@x.edu')).toBeGreaterThan(0);
    expect(l.check('8.8.8.8', 'fresh@x.edu')).toBe(0);
  });

  it('expires after the window and then allows a legitimate attempt', () => {
    const c = clock();
    const l = new LoginRateLimiter({ now: c.now });
    fail(l, '1.1.1.1', 'v@x.edu', 5);
    c.advance(15 * 60_000 - 1);
    expect(l.check('1.1.1.1', 'v@x.edu')).toBeGreaterThan(0);
    c.advance(2);
    expect(l.check('1.1.1.1', 'v@x.edu')).toBe(0);
    fail(l, '1.1.1.1', 'v@x.edu', 1); // a fresh window starts at 1, not 6
    expect(l.check('1.1.1.1', 'v@x.edu')).toBe(0);
  });

  it('a success clears the pair budget but not the per-IP budget', () => {
    const l = new LoginRateLimiter({ now: clock().now });
    fail(l, '1.1.1.1', 'v@x.edu', 4);
    l.recordSuccess('1.1.1.1', 'v@x.edu');
    fail(l, '1.1.1.1', 'v@x.edu', 4);
    expect(l.check('1.1.1.1', 'v@x.edu')).toBe(0); // pair reset
    const l2 = new LoginRateLimiter({ now: clock().now });
    for (let i = 0; i < 19; i++) l2.recordFailure('1.1.1.1', `u${i}@x.edu`);
    l2.recordSuccess('1.1.1.1', 'me@x.edu'); // an attacker's own valid login must not wipe the IP budget
    l2.recordFailure('1.1.1.1', 'u99@x.edu');
    expect(l2.check('1.1.1.1', 'x@x.edu')).toBeGreaterThan(0);
  });

  it('is identical for existing and nonexistent accounts and is case/space-insensitive on e-mail', () => {
    const l = new LoginRateLimiter({ now: clock().now });
    fail(l, '1.1.1.1', ' Real@X.edu ', 5);
    fail(l, '1.1.1.1', 'ghost@x.edu', 5);
    expect(l.check('1.1.1.1', 'real@x.edu')).toBe(l.check('1.1.1.1', 'GHOST@x.edu'));
    expect(l.check('1.1.1.1', 'real@x.edu')).toBeGreaterThan(0);
  });

  it('never stores raw e-mail addresses', () => {
    const l = new LoginRateLimiter({ now: clock().now });
    fail(l, '1.1.1.1', 'secret.person@x.edu', 1);
    expect(
      JSON.stringify([...(l as unknown as { entries: Map<string, unknown> }).entries.keys()]),
    ).not.toContain('secret.person');
  });

  it('bounds memory: never exceeds maxKeys, sweeps expired entries first, evicts oldest otherwise', () => {
    const c = clock();
    const l = new LoginRateLimiter({ now: c.now, maxKeys: 50 });
    for (let i = 0; i < 1000; i++)
      l.recordFailure(`10.0.${Math.floor(i / 250)}.${i % 250}`, `u${i}@x.edu`);
    expect(l.size).toBeLessThanOrEqual(50);
    c.advance(16 * 60_000);
    l.recordFailure('9.9.9.9', 'new@x.edu');
    expect(l.size).toBeLessThanOrEqual(3); // everything expired was swept
  });
});
