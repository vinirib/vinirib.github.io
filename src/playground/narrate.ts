import type { Attempt, Config, PaymentResult } from './engine';

export type Tone = 'info' | 'good' | 'warn' | 'bad';

export interface Line {
  tone: Tone;
  text: string;
}

const replicaName = (replica: Attempt['replica']) => (replica === 'payB' ? 'pay-b' : 'pay-a');

function backoffText(attempt: Attempt, config: Config): string {
  const policy = config.retry === 'fixed' ? 'fixed delay' : 'exponential backoff';
  const jitter = config.jitter ? ' with jitter' : '';
  return `Waited ${attempt.waitBeforeMs}ms (${policy}${jitter}) before retrying, so the struggling service gets room to breathe.`;
}

export function narrateAttempt(attempt: Attempt, config: Config, result: PaymentResult): Line[] {
  const lines: Line[] = [];
  const label = `Attempt ${attempt.number}:`;
  if (attempt.waitBeforeMs > 0) lines.push({ tone: 'info', text: backoffText(attempt, config) });

  switch (attempt.outcome) {
    case 'ok':
      lines.push({
        tone: attempt.number > 1 && result.charges > 1 ? 'bad' : 'good',
        text: `${label} ${replicaName(attempt.replica)} wrote the charge to the ledger and answered 201 in time.`,
      });
      break;
    case 'replayed':
      lines.push({
        tone: 'good',
        text: `${label} ${replicaName(attempt.replica)} found key ${result.idempotencyKey} in the idempotency store. It returned the stored result instead of charging again.`,
      });
      break;
    case 'timeout':
      lines.push({
        tone: 'warn',
        text: `${label} ${replicaName(attempt.replica)} charged the card, but answered too slowly. The client gave up after 1s and has no idea the charge happened.`,
      });
      break;
    case 'unavailable':
      lines.push({
        tone: 'bad',
        text:
          attempt.replica === null && attempt.failedAt === 'gateway'
            ? `${label} the gateway answered 503. Either it is down, or no payment replica is healthy. Nothing was charged.`
            : `${label} the gateway answered 503. Nothing was charged.`,
      });
      break;
    case 'error':
      lines.push({
        tone: 'bad',
        text:
          attempt.failedAt === 'db'
            ? `${label} the ledger database failed, so ${replicaName(attempt.replica)} answered 500. Nothing was charged.`
            : `${label} ${replicaName(attempt.replica)} crashed mid-request and answered 500. Nothing was charged.`,
      });
      break;
  }
  return lines;
}

export function narrateSummary(result: PaymentResult, config: Config): Line {
  const tries = `${result.attempts.length} attempt${result.attempts.length > 1 ? 's' : ''}`;
  if (result.charges > 1) {
    return {
      tone: 'bad',
      text: `Customer charged ${result.charges} times for one payment. Retries without an idempotency key turn a lost response into a double charge. Turn on Idempotency-Key and try again.`,
    };
  }
  if (result.succeeded && result.attempts.some((a) => a.outcome === 'replayed')) {
    return { tone: 'good', text: `Charged exactly once after ${tries}. Safe retries need an idempotency key.` };
  }
  if (result.succeeded) {
    return { tone: 'good', text: `Payment succeeded after ${tries}, charged once.` };
  }
  if (config.retry === 'none') {
    return { tone: 'bad', text: 'Payment failed and there was no retry. A short blip became a failed checkout.' };
  }
  if (result.charges === 1) {
    return {
      tone: 'warn',
      text: `The client thinks the payment failed, but the card was charged. Only an idempotency key lets a later retry find out what happened.`,
    };
  }
  return { tone: 'bad', text: `Payment failed after ${tries}. Retries cannot fix an outage, they only help with short failures.` };
}
