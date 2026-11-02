import { describe, expect, it } from 'vitest';
import {
  backoffDelay,
  createWorld,
  isDegraded,
  overcharged,
  seededRng,
  sendPayment,
  type Config,
} from './engine';

const config = (overrides: Partial<Config> = {}): Config => ({
  retry: 'exponential',
  jitter: false,
  maxAttempts: 3,
  idempotency: false,
  ...overrides,
});

describe('healthy system', () => {
  it('charges once and alternates replicas', () => {
    const world = createWorld();
    const rng = seededRng(1);
    const first = sendPayment(world, config(), rng);
    const second = sendPayment(world, config(), rng);

    expect(first.succeeded).toBe(true);
    expect(first.attempts).toHaveLength(1);
    expect(first.charges).toBe(1);
    expect([first.attempts[0].replica, second.attempts[0].replica]).toEqual(['payA', 'payB']);
    expect(world.ledger).toHaveLength(2);
    expect(isDegraded(world)).toBe(false);
  });
});

describe('failures', () => {
  it('fails over to the healthy replica when one is down', () => {
    const world = createWorld();
    world.health.payA = 'down';
    const results = [1, 2, 3].map(() => sendPayment(world, config(), seededRng(2)));

    expect(results.every((r) => r.succeeded && r.attempts[0].replica === 'payB')).toBe(true);
    expect(isDegraded(world)).toBe(true);
  });

  it('retries up to max attempts and never charges during a total outage', () => {
    const world = createWorld();
    world.health.payA = 'down';
    world.health.payB = 'down';
    const result = sendPayment(world, config({ maxAttempts: 4 }), seededRng(3));

    expect(result.succeeded).toBe(false);
    expect(result.attempts.map((a) => a.outcome)).toEqual(['unavailable', 'unavailable', 'unavailable', 'unavailable']);
    expect(world.ledger).toHaveLength(0);
  });

  it('makes a single attempt when retries are disabled', () => {
    const world = createWorld();
    world.health.db = 'down';
    const result = sendPayment(world, config({ retry: 'none', maxAttempts: 5 }), seededRng(4));

    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].failedAt).toBe('db');
  });
});

describe('lost response', () => {
  it('charges twice without an idempotency key', () => {
    const world = createWorld();
    world.health.payA = 'slow';
    world.health.payB = 'slow';
    const result = sendPayment(world, config({ maxAttempts: 2 }), seededRng(5));

    expect(result.attempts.map((a) => a.outcome)).toEqual(['timeout', 'timeout']);
    expect(result.charges).toBe(2);
    expect(world.ledger.map((r) => r.duplicate)).toEqual([false, true]);
    expect(overcharged(world)).toBe(4200);
  });

  it('replays the stored result with an idempotency key', () => {
    const world = createWorld();
    world.health.payA = 'slow';
    const result = sendPayment(world, config({ idempotency: true }), seededRng(6));

    expect(result.attempts.map((a) => a.outcome)).toEqual(['timeout', 'replayed']);
    expect(result.succeeded).toBe(true);
    expect(result.charges).toBe(1);
    expect(overcharged(world)).toBe(0);
  });

  it('uses a different key per payment, so a second payment is still charged', () => {
    const world = createWorld();
    sendPayment(world, config({ idempotency: true }), seededRng(7));
    sendPayment(world, config({ idempotency: true }), seededRng(7));

    expect(world.ledger).toHaveLength(2);
    expect(overcharged(world)).toBe(0);
  });
});

describe('backoff', () => {
  it('is zero for the first attempt and for no retry policy', () => {
    const rng = seededRng(8);
    expect(backoffDelay(1, config(), rng)).toBe(0);
    expect(backoffDelay(3, config({ retry: 'none' }), rng)).toBe(0);
  });

  it('doubles without jitter and caps at the maximum', () => {
    const rng = seededRng(9);
    expect([2, 3, 4, 5].map((n) => backoffDelay(n, config(), rng))).toEqual([200, 400, 800, 1600]);
    expect(backoffDelay(10, config(), rng)).toBe(4000);
    expect(backoffDelay(4, config({ retry: 'fixed' }), rng)).toBe(500);
  });

  it('stays within [0, delay] with full jitter and varies between attempts', () => {
    const rng = seededRng(10);
    const delays = Array.from({ length: 50 }, () => backoffDelay(4, config({ jitter: true }), rng));

    expect(delays.every((d) => d >= 0 && d <= 800)).toBe(true);
    expect(new Set(delays).size).toBeGreaterThan(10);
  });

  it('is deterministic for the same seed', () => {
    const run = () => Array.from({ length: 5 }, (_, i) => backoffDelay(i + 2, config({ jitter: true }), rngA));
    let rngA = seededRng(11);
    const first = run();
    rngA = seededRng(11);
    expect(run()).toEqual(first);
  });
});
