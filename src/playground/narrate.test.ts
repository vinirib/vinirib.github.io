import { describe, expect, it } from 'vitest';
import { createWorld, seededRng, sendPayment, type Config } from './engine';
import { narrateAttempt, narrateSummary } from './narrate';

const config = (overrides: Partial<Config> = {}): Config => ({
  retry: 'exponential',
  jitter: false,
  maxAttempts: 2,
  idempotency: false,
  ...overrides,
});

describe('narration', () => {
  it('explains a double charge and points to the fix', () => {
    const world = createWorld();
    world.health.payA = 'slow';
    world.health.payB = 'slow';
    const c = config();
    const result = sendPayment(world, c, seededRng(1));

    expect(narrateAttempt(result.attempts[0], c, result)[0].text).toContain('has no idea the charge happened');
    expect(narrateAttempt(result.attempts[1], c, result)[0].text).toContain('Waited 200ms (exponential backoff)');
    const summary = narrateSummary(result, c);
    expect(summary.tone).toBe('bad');
    expect(summary.text).toContain('charged 2 times');
  });

  it('explains a replay from the idempotency store', () => {
    const world = createWorld();
    world.health.payA = 'slow';
    const c = config({ idempotency: true });
    const result = sendPayment(world, c, seededRng(2));

    expect(narrateAttempt(result.attempts[1], c, result).at(-1)?.text).toContain('found key pay-1 in the idempotency store');
    expect(narrateSummary(result, c).text).toContain('Charged exactly once');
  });

  it('explains a failure without retries', () => {
    const world = createWorld();
    world.health.gateway = 'down';
    const c = config({ retry: 'none' });
    const result = sendPayment(world, c, seededRng(3));

    expect(narrateAttempt(result.attempts[0], c, result)[0].text).toContain('503');
    expect(narrateSummary(result, c).text).toContain('no retry');
  });

  it('warns when the card was charged but the client saw a failure', () => {
    const world = createWorld();
    world.health.payA = 'slow';
    world.health.payB = 'down';
    const c = config({ maxAttempts: 1 });
    const result = sendPayment(world, c, seededRng(4));

    expect(result.succeeded).toBe(false);
    expect(narrateSummary(result, c).tone).toBe('warn');
  });
});
