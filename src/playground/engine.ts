export type NodeId = 'client' | 'gateway' | 'payA' | 'payB' | 'db';
export type Health = 'up' | 'down' | 'slow' | 'flaky';
export type RetryPolicy = 'none' | 'fixed' | 'exponential';
export type Outcome = 'ok' | 'replayed' | 'unavailable' | 'error' | 'timeout';

export interface Config {
  retry: RetryPolicy;
  jitter: boolean;
  maxAttempts: number;
  idempotency: boolean;
}

export interface Attempt {
  number: number;
  replica: 'payA' | 'payB' | null;
  outcome: Outcome;
  failedAt: NodeId | null;
  committed: boolean;
  waitBeforeMs: number;
  durationMs: number;
}

export interface LedgerRow {
  txId: number;
  requestId: number;
  amountCents: number;
  duplicate: boolean;
}

export interface PaymentResult {
  requestId: number;
  idempotencyKey: string | null;
  attempts: Attempt[];
  succeeded: boolean;
  charges: number;
}

export interface World {
  health: Record<NodeId, Health>;
  ledger: LedgerRow[];
  idempotencyStore: Record<string, number>;
  roundRobin: number;
  nextTxId: number;
  nextRequestId: number;
}

export type Rng = () => number;

export const HOP_MS = 120;
export const CLIENT_TIMEOUT_MS = 1000;
export const FIXED_DELAY_MS = 500;
export const BASE_DELAY_MS = 200;
export const MAX_DELAY_MS = 4000;

export function createWorld(): World {
  return {
    health: { client: 'up', gateway: 'up', payA: 'up', payB: 'up', db: 'up' },
    ledger: [],
    idempotencyStore: {},
    roundRobin: 0,
    nextTxId: 1041,
    nextRequestId: 1,
  };
}

// mulberry32: small, fast and deterministic, so the simulation is reproducible in tests
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Delay before attempt `attempt` (2 is the first retry). Full jitter: random value in [0, delay]. */
export function backoffDelay(attempt: number, config: Config, rng: Rng): number {
  if (attempt <= 1 || config.retry === 'none') return 0;
  const raw =
    config.retry === 'fixed'
      ? FIXED_DELAY_MS
      : Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 2));
  return config.jitter ? Math.round(rng() * raw) : raw;
}

function pickReplica(world: World): 'payA' | 'payB' | null {
  const order: Array<'payA' | 'payB'> = world.roundRobin % 2 === 0 ? ['payA', 'payB'] : ['payB', 'payA'];
  world.roundRobin++;
  // the gateway health check only knows a replica is down, it cannot see slow or flaky ones
  return order.find((r) => world.health[r] !== 'down') ?? null;
}

function failsRandomly(health: Health, rng: Rng): boolean {
  return health === 'flaky' && rng() < 0.5;
}

function runAttempt(
  world: World,
  number: number,
  key: string | null,
  requestId: number,
  amountCents: number,
  rng: Rng,
): Omit<Attempt, 'waitBeforeMs'> {
  const fail = (failedAt: NodeId, outcome: Outcome, hops: number, replica: Attempt['replica'] = null) => ({
    number,
    replica,
    outcome,
    failedAt,
    committed: false,
    durationMs: hops * HOP_MS,
  });

  const gw = world.health.gateway;
  if (gw === 'down' || failsRandomly(gw, rng)) return fail('gateway', 'unavailable', 1);

  const replica = pickReplica(world);
  if (replica === null) return fail('gateway', 'unavailable', 2);

  const svc = world.health[replica];
  if (failsRandomly(svc, rng)) return fail(replica, 'error', 2, replica);

  if (key !== null && key in world.idempotencyStore) {
    return { number, replica, outcome: 'replayed', failedAt: null, committed: false, durationMs: 4 * HOP_MS };
  }

  const db = world.health.db;
  if (db === 'down' || failsRandomly(db, rng)) return fail('db', 'error', 4, replica);

  const alreadyCharged = world.ledger.some((row) => row.requestId === requestId);
  world.ledger.push({ txId: world.nextTxId++, requestId, amountCents, duplicate: alreadyCharged });
  if (key !== null) world.idempotencyStore[key] = requestId;

  const slow = svc === 'slow' || gw === 'slow' || db === 'slow';
  if (slow) {
    // the charge is committed, but the response arrives after the client gave up: the classic double charge setup
    return { number, replica, outcome: 'timeout', failedAt: replica, committed: true, durationMs: CLIENT_TIMEOUT_MS };
  }
  return { number, replica, outcome: 'ok', failedAt: null, committed: true, durationMs: 6 * HOP_MS };
}

export function sendPayment(world: World, config: Config, rng: Rng, amountCents = 4200): PaymentResult {
  const requestId = world.nextRequestId++;
  const key = config.idempotency ? `pay-${requestId}` : null;
  const maxAttempts = config.retry === 'none' ? 1 : Math.max(1, Math.min(5, config.maxAttempts));
  const attempts: Attempt[] = [];

  for (let n = 1; n <= maxAttempts; n++) {
    const waitBeforeMs = backoffDelay(n, config, rng);
    const attempt = { ...runAttempt(world, n, key, requestId, amountCents, rng), waitBeforeMs };
    attempts.push(attempt);
    if (attempt.outcome === 'ok' || attempt.outcome === 'replayed') break;
  }

  const last = attempts[attempts.length - 1];
  return {
    requestId,
    idempotencyKey: key,
    attempts,
    succeeded: last.outcome === 'ok' || last.outcome === 'replayed',
    charges: world.ledger.filter((row) => row.requestId === requestId).length,
  };
}

export function overcharged(world: World): number {
  return world.ledger.filter((row) => row.duplicate).reduce((sum, row) => sum + row.amountCents, 0);
}

export function isDegraded(world: World): boolean {
  return (Object.keys(world.health) as NodeId[]).some((id) => world.health[id] !== 'up');
}
