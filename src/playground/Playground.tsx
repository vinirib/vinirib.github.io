import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Database, KeyRound, Network, RotateCcw, Send, Server, Skull, Smartphone, Trophy } from 'lucide-preact';
import {
  createWorld,
  isDegraded,
  seededRng,
  sendPayment,
  type Attempt,
  type Config,
  type Health,
  type NodeId,
  type RetryPolicy,
} from './engine';
import { narrateAttempt, narrateSummary, type Line } from './narrate';
import './playground.css';

const MISSIONS = [
  { id: 'send', title: 'Send a payment', why: 'Press POST /payments. Watch the request travel client → gateway → replica → database and back.' },
  { id: 'failover', title: 'Kill a replica, send again', why: 'Click pay-b and choose Kill. The gateway routes around it. That is failover.' },
  { id: 'double', title: 'Lose a response', why: 'Pick the Lost response scenario and send. The charge works, the answer arrives late, the client retries and pays twice.' },
  { id: 'saved', title: 'Make the retry safe', why: 'Turn on Idempotency-Key and send again. The retry is recognized and replayed, not charged again.' },
] as const;
type MissionId = (typeof MISSIONS)[number]['id'];

type Pos = { x: number; y: number };
type Layout = 'wide' | 'tall';

const POSITIONS: Record<Layout, Record<NodeId, Pos>> = {
  wide: { client: { x: 8, y: 50 }, gateway: { x: 31, y: 50 }, payA: { x: 57, y: 22 }, payB: { x: 57, y: 78 }, db: { x: 86, y: 50 } },
  tall: { client: { x: 50, y: 9 }, gateway: { x: 50, y: 30 }, payA: { x: 24, y: 53 }, payB: { x: 76, y: 53 }, db: { x: 50, y: 76 } },
};

const EDGES: Array<[NodeId, NodeId]> = [
  ['client', 'gateway'],
  ['gateway', 'payA'],
  ['gateway', 'payB'],
  ['payA', 'db'],
  ['payB', 'db'],
];

const NODES: Array<{ id: NodeId; label: string; Icon: typeof Server }> = [
  { id: 'client', label: 'client', Icon: Smartphone },
  { id: 'gateway', label: 'gateway', Icon: Network },
  { id: 'payA', label: 'pay-a', Icon: Server },
  { id: 'payB', label: 'pay-b', Icon: Server },
  { id: 'db', label: 'ledger db', Icon: Database },
];

const SCENARIOS: Record<string, { label: string; health: Partial<Record<NodeId, Health>> }> = {
  free: { label: 'Free play', health: {} },
  replica: { label: 'Replica down', health: { payB: 'down' } },
  outage: { label: 'Total outage', health: { payA: 'down', payB: 'down' } },
  lost: { label: 'Lost response', health: { payA: 'slow', payB: 'slow' } },
  flaky: { label: 'Flaky database', health: { db: 'flaky' } },
};

const ACHIEVEMENTS = [
  { id: 'outage', title: 'First outage', desc: 'A request failed. Welcome to production.' },
  { id: 'failover', title: 'Failover', desc: 'Served traffic with a replica down.' },
  { id: 'double', title: 'Charged twice', desc: 'A lost response became a double charge.' },
  { id: 'saved', title: 'Saved by the key', desc: 'The idempotency key replayed instead of charging again.' },
  { id: 'recovered', title: 'Back to green', desc: 'Healed every node after an incident.' },
  { id: 'eleven', title: 'This one goes to 11', desc: 'Pushed the load to eleven.' },
] as const;
type AchievementId = (typeof ACHIEVEMENTS)[number]['id'];

const HEALTH_LABEL: Record<Health, string> = { up: 'healthy', down: 'down', slow: 'slow (2s)', flaky: 'flaky (50%)' };
const OUTCOME_LABEL: Record<Attempt['outcome'], string> = {
  ok: '201 created',
  replayed: '201 replayed',
  unavailable: '503 unavailable',
  error: '500 error',
  timeout: 'timeout',
};
const HOP_ANIM_MS = 420;
const MAX_IN_FLIGHT = 6;

interface TraceRow extends Attempt {
  key: string;
  requestId: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function loadAchievements(): AchievementId[] {
  try {
    return JSON.parse(localStorage.getItem('achievements') ?? '[]');
  } catch {
    return [];
  }
}

export default function Playground() {
  const world = useRef(createWorld());
  const rng = useRef(seededRng(Date.now() % 100000));
  const layer = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const inFlight = useRef(0);
  const degradedSince = useRef<number | null>(null);
  const reducedMotion = useRef(false);

  const [layout, setLayout] = useState<Layout>('wide');
  const [health, setHealth] = useState({ ...world.current.health });
  const [config, setConfig] = useState<Config>({ retry: 'exponential', jitter: true, maxAttempts: 3, idempotency: false });
  const [scenario, setScenario] = useState('free');
  const [trace, setTrace] = useState<TraceRow[]>([]);
  const [revealed, setRevealed] = useState<number[]>([]);
  const [stats, setStats] = useState({ sent: 0, succeeded: 0, failed: 0, retries: 0 });
  const [menu, setMenu] = useState<NodeId | null>(null);
  const [load, setLoad] = useState(0);
  const [visible, setVisible] = useState(false);
  const [unlocked, setUnlocked] = useState<AchievementId[]>([]);
  const [toast, setToast] = useState<(typeof ACHIEVEMENTS)[number] | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [story, setStory] = useState<{ requestId: number; lines: Line[] } | null>(null);
  const [missions, setMissions] = useState<MissionId[]>([]);
  const storyId = useRef(0);
  const complete = (id: MissionId) => setMissions((m) => (m.includes(id) ? m : [...m, id]));

  const configRef = useRef(config);
  configRef.current = config;

  useEffect(() => {
    setUnlocked(loadAchievements());
    reducedMotion.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const el = root.current;
    if (!el) return;
    const resize = new ResizeObserver(([entry]) => setLayout(entry.contentRect.width < 640 ? 'tall' : 'wide'));
    const seen = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { threshold: 0.15 });
    resize.observe(el);
    seen.observe(el);
    return () => {
      resize.disconnect();
      seen.disconnect();
    };
  }, []);

  const unlock = useCallback((id: AchievementId) => {
    setUnlocked((current) => {
      if (current.includes(id)) return current;
      const next = [...current, id];
      try {
        localStorage.setItem('achievements', JSON.stringify(next));
      } catch {}
      setToast(ACHIEVEMENTS.find((a) => a.id === id) ?? null);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const degraded = isDegraded(world.current);
    window.dispatchEvent(new CustomEvent('system:status', { detail: { degraded } }));
    if (degraded && degradedSince.current === null) degradedSince.current = Date.now();
    if (!degraded && degradedSince.current !== null) {
      if (unlocked.includes('outage')) unlock('recovered');
      degradedSince.current = null;
    }
  }, [health]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('system:load', { detail: { level: load } }));
    document.documentElement.dataset.mode = load === 11 ? 'heavy' : '';
    if (load === 11) unlock('eleven');
  }, [load]);

  const positions = POSITIONS[layout];

  const hop = useCallback(
    async (from: NodeId, to: NodeId, kind: string) => {
      const el = layer.current;
      if (!el || reducedMotion.current) return;
      const a = positions[from];
      const b = positions[to];
      const dot = document.createElement('span');
      dot.className = `dot dot-${kind}`;
      el.appendChild(dot);
      const animation = dot.animate(
        [
          { left: `${a.x}%`, top: `${a.y}%`, opacity: 1 },
          { left: `${b.x}%`, top: `${b.y}%`, opacity: kind === 'lost' ? 0 : 1 },
        ],
        { duration: kind === 'lost' ? HOP_ANIM_MS * 2 : HOP_ANIM_MS, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' },
      );
      await animation.finished.catch(() => undefined);
      dot.remove();
    },
    [positions],
  );

  const mark = useCallback(
    (at: NodeId, kind: 'fail' | 'key' | 'commit' | 'timeout') => {
      const el = layer.current;
      if (!el || reducedMotion.current) return;
      const p = positions[at];
      const marker = document.createElement('span');
      marker.className = `marker marker-${kind}`;
      marker.textContent = { fail: '✕', key: '⚿', commit: '+$', timeout: '⏱' }[kind];
      marker.style.left = `${p.x}%`;
      marker.style.top = `${p.y}%`;
      el.appendChild(marker);
      marker
        .animate([{ opacity: 0, transform: 'translate(-50%,-50%) scale(.6)' }, { opacity: 1, transform: 'translate(-50%,-160%) scale(1)', offset: 0.3 }, { opacity: 0, transform: 'translate(-50%,-220%) scale(1)' }], { duration: 1100, fill: 'forwards' })
        .finished.catch(() => undefined)
        .then(() => marker.remove());
    },
    [positions],
  );

  const playAttempt = useCallback(
    async (attempt: Attempt) => {
      const forward = attempt.number > 1 ? 'retry' : 'request';
      const rep = attempt.replica;
      if (attempt.failedAt === 'gateway' || rep === null) {
        await hop('client', 'gateway', forward);
        mark('gateway', 'fail');
        return;
      }
      await hop('client', 'gateway', forward);
      await hop('gateway', rep, forward);
      if (attempt.outcome === 'error' && attempt.failedAt === rep) {
        mark(rep, 'fail');
        return;
      }
      if (attempt.outcome === 'replayed') {
        mark(rep, 'key');
        await hop(rep, 'gateway', 'dedup');
        await hop('gateway', 'client', 'dedup');
        return;
      }
      await hop(rep, 'db', forward);
      if (attempt.failedAt === 'db') {
        mark('db', 'fail');
        return;
      }
      mark('db', 'commit');
      await hop('db', rep, 'response');
      if (attempt.outcome === 'timeout') {
        mark('client', 'timeout');
        await hop(rep, 'gateway', 'lost');
        return;
      }
      await hop(rep, 'gateway', 'response');
      await hop('gateway', 'client', 'response');
    },
    [hop, mark],
  );

  const send = useCallback(async () => {
    if (inFlight.current >= MAX_IN_FLIGHT) return;
    inFlight.current++;
    const w = world.current;
    const result = sendPayment(w, configRef.current, rng.current);
    const rows = w.ledger.filter((row) => row.requestId === result.requestId);
    let committed = 0;
    const cfg = configRef.current;
    storyId.current = result.requestId;
    const tell = (lines: Line[]) => {
      if (storyId.current !== result.requestId) return;
      setStory((s) => ({ requestId: result.requestId, lines: s?.requestId === result.requestId ? [...s.lines, ...lines] : lines }));
    };
    tell([{ tone: 'info', text: `Payment #${result.requestId}: the client sends POST /payments for $42.00${result.idempotencyKey ? ` with Idempotency-Key ${result.idempotencyKey}` : ' with no idempotency key'}.` }]);
    setStats((s) => ({ ...s, sent: s.sent + 1 }));
    complete('send');

    for (const attempt of result.attempts) {
      if (attempt.waitBeforeMs > 0) {
        setAnnouncement(`Attempt ${attempt.number - 1} failed, retrying in ${attempt.waitBeforeMs} milliseconds.`);
        await sleep(reducedMotion.current ? 0 : attempt.waitBeforeMs);
      }
      await playAttempt(attempt);
      if (attempt.committed) {
        const row = rows[committed++];
        if (row) {
          setRevealed((r) => [...r, row.txId]);
          if (row.duplicate) unlock('double');
        }
      }
      setTrace((t) => [{ ...attempt, key: `${result.requestId}-${attempt.number}`, requestId: result.requestId }, ...t].slice(0, 8));
      tell(narrateAttempt(attempt, cfg, result));
      if (attempt.number > 1) setStats((s) => ({ ...s, retries: s.retries + 1 }));
      if (attempt.outcome === 'replayed') {
        unlock('saved');
        complete('saved');
      }
    }

    tell([narrateSummary(result, cfg)]);
    setStats((s) => (result.succeeded ? { ...s, succeeded: s.succeeded + 1 } : { ...s, failed: s.failed + 1 }));
    if (result.charges > 1) complete('double');
    if (!result.succeeded) unlock('outage');
    if (result.succeeded && (w.health.payA === 'down' || w.health.payB === 'down')) {
      unlock('failover');
      complete('failover');
    }
    setAnnouncement(
      result.succeeded
        ? `Payment ${result.requestId} succeeded after ${result.attempts.length} attempt${result.attempts.length > 1 ? 's' : ''}, charged ${result.charges} time${result.charges === 1 ? '' : 's'}.`
        : `Payment ${result.requestId} failed after ${result.attempts.length} attempts.`,
    );
    inFlight.current--;
  }, [playAttempt, unlock]);

  useEffect(() => {
    if (!visible || load === 0) return;
    const timer = setInterval(send, Math.round(3000 / load));
    return () => clearInterval(timer);
  }, [visible, load, send]);

  const setNodeHealth = (id: NodeId, value: Health) => {
    world.current.health[id] = value;
    setHealth({ ...world.current.health });
    setMenu(null);
  };

  const [chaos, setChaos] = useState(false);

  useEffect(() => {
    const breakable: NodeId[] = ['gateway', 'payA', 'payB', 'db'];
    const killRandom = () => {
      const alive = breakable.filter((id) => world.current.health[id] === 'up');
      if (alive.length === 0) {
        for (const id of breakable) world.current.health[id] = 'up';
      } else {
        world.current.health[alive[Math.floor(rng.current() * alive.length)]] = 'down';
      }
      setHealth({ ...world.current.health });
    };
    const onChaos = (event: Event) => setChaos((event as CustomEvent<{ on: boolean }>).detail.on);
    window.addEventListener('playground:kill-random', killRandom);
    window.addEventListener('playground:chaos', onChaos);
    let timer: ReturnType<typeof setInterval> | undefined;
    if (chaos) timer = setInterval(killRandom, 5000);
    return () => {
      window.removeEventListener('playground:kill-random', killRandom);
      window.removeEventListener('playground:chaos', onChaos);
      if (timer) clearInterval(timer);
    };
  }, [chaos]);

  const applyScenario = (name: string) => {
    setScenario(name);
    const preset = SCENARIOS[name].health;
    for (const id of Object.keys(world.current.health) as NodeId[]) world.current.health[id] = preset[id] ?? 'up';
    setHealth({ ...world.current.health });
  };

  const reset = () => {
    world.current = createWorld();
    setHealth({ ...world.current.health });
    setScenario('free');
    setTrace([]);
    setRevealed([]);
    setStats({ sent: 0, succeeded: 0, failed: 0, retries: 0 });
    setLoad(0);
    setStory(null);
  };

  const ledger = useMemo(
    () => world.current.ledger.filter((row) => revealed.includes(row.txId)).slice(-6).reverse(),
    [revealed],
  );
  const overchargedCents = useMemo(
    () => world.current.ledger.filter((row) => row.duplicate && revealed.includes(row.txId)).reduce((sum, row) => sum + row.amountCents, 0),
    [revealed],
  );

  const onNodeKey = (event: KeyboardEvent, id: NodeId) => {
    if (id === 'client') return;
    if (event.key === 'k' || event.key === 'K') setNodeHealth(id, 'down');
    if (event.key === 'h' || event.key === 'H') setNodeHealth(id, 'up');
    if (event.key === 'Escape') setMenu(null);
  };

  return (
    <div class="pg" ref={root}>
      <div class="pg-main">
        <div class="pg-canvas" role="group" aria-label="Payment system topology. Select a node to break it.">
          {(['wide', 'tall'] as Layout[]).map((variant) => (
            <svg class={`pg-edges pg-edges-${variant}`} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" key={variant}>
              {EDGES.map(([from, to]) => {
                const broken = health[from] === 'down' || health[to] === 'down';
                const p = POSITIONS[variant];
                return (
                  <line
                    key={`${from}-${to}`}
                    x1={p[from].x}
                    y1={p[from].y}
                    x2={p[to].x}
                    y2={p[to].y}
                    class={broken ? 'edge edge-broken' : 'edge'}
                    vector-effect="non-scaling-stroke"
                  />
                );
              })}
            </svg>
          ))}
          <div class="pg-layer" ref={layer} aria-hidden="true" />
          <ul class="legend" aria-label="Legend">
            <li><span class="lg lg-request" />request</li>
            <li><span class="lg lg-retry" />retry</li>
            <li><span class="lg lg-response" />response</li>
            <li><span class="lg lg-dedup" />replayed by key</li>
            <li><span class="lg-text">+$</span>charge written</li>
            <li><span class="lg-text lg-fail">✕</span>failed</li>
          </ul>
          {NODES.map(({ id, label, Icon }) => (
            <div
              class="node-wrap"
              style={{
                '--xw': `${POSITIONS.wide[id].x}%`,
                '--yw': `${POSITIONS.wide[id].y}%`,
                '--xt': `${POSITIONS.tall[id].x}%`,
                '--yt': `${POSITIONS.tall[id].y}%`,
              }}
              key={id}
            >
              <button
                type="button"
                class={`node node-${health[id]}`}
                disabled={id === 'client'}
                aria-label={`${label}, ${HEALTH_LABEL[health[id]]}${id === 'client' ? '' : '. Press K to kill, H to heal, Enter for options'}`}
                aria-expanded={id === 'client' ? undefined : menu === id}
                onClick={() => setMenu(menu === id ? null : id)}
                onKeyDown={(event) => onNodeKey(event as unknown as KeyboardEvent, id)}
              >
                {health[id] === 'down' ? <Skull size={20} strokeWidth={1.5} /> : <Icon size={20} strokeWidth={1.5} />}
                <span class="node-label">{label}</span>
                {health[id] !== 'up' && <span class="node-state">{health[id] === 'down' ? '503' : health[id]}</span>}
              </button>
              {menu === id && (
                <div class="node-menu" role="menu">
                  <button role="menuitem" type="button" onClick={() => setNodeHealth(id, 'down')}>Kill</button>
                  <button role="menuitem" type="button" onClick={() => setNodeHealth(id, 'slow')}>Slow (2s)</button>
                  <button role="menuitem" type="button" onClick={() => setNodeHealth(id, 'flaky')}>Flaky (50%)</button>
                  <button role="menuitem" type="button" onClick={() => setNodeHealth(id, 'up')}>Heal</button>
                </div>
              )}
            </div>
          ))}
        </div>

        <aside class="pg-panel" aria-label="Simulation controls">
          <label class="field">
            <span class="field-label">Scenario</span>
            <select value={scenario} onChange={(e) => applyScenario((e.target as HTMLSelectElement).value)}>
              {Object.entries(SCENARIOS).map(([value, s]) => (
                <option value={value} key={value}>{s.label}</option>
              ))}
            </select>
            <span class="help">Presets that break the system for you.</span>
          </label>

          <div class="field">
            <span class="field-label" id="retry-label">Retry policy</span>
            <div class="segmented" role="radiogroup" aria-labelledby="retry-label">
              {(['none', 'fixed', 'exponential'] as RetryPolicy[]).map((policy) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={config.retry === policy}
                  class={config.retry === policy ? 'seg seg-on' : 'seg'}
                  onClick={() => setConfig({ ...config, retry: policy })}
                  key={policy}
                >
                  {policy === 'exponential' ? 'exp' : policy}
                </button>
              ))}
            </div>
            <span class="help">What the client does when a call fails. Exponential waits 200, 400, 800ms...</span>
          </div>

          <label class="toggle">
            <input type="checkbox" checked={config.jitter} disabled={config.retry === 'none'} onChange={() => setConfig({ ...config, jitter: !config.jitter })} />
            <span>Jitter</span>
            <span class="help help-inline">random wait, so retries do not hit at the same time</span>
          </label>

          <div class="field field-row">
            <span class="field-label">Max attempts</span>
            <div class="stepper">
              <button type="button" aria-label="Fewer attempts" onClick={() => setConfig({ ...config, maxAttempts: Math.max(1, config.maxAttempts - 1) })}>−</button>
              <output aria-live="polite">{config.maxAttempts}</output>
              <button type="button" aria-label="More attempts" onClick={() => setConfig({ ...config, maxAttempts: Math.min(5, config.maxAttempts + 1) })}>+</button>
            </div>
          </div>

          <label class="toggle toggle-key">
            <input type="checkbox" checked={config.idempotency} onChange={() => setConfig({ ...config, idempotency: !config.idempotency })} />
            <span>
              <KeyRound size={14} strokeWidth={1.5} /> Idempotency-Key
            </span>
          </label>
          <span class="help help-key">A unique id sent with the payment. The server stores it, so a retry of the same payment is answered from the store instead of charging again.</span>

          <button type="button" class="btn btn-primary pg-send" onClick={send}>
            <Send size={16} strokeWidth={1.5} /> POST /payments <span class="pg-amount">$42</span>
          </button>

          <label class="field">
            <span class="field-label">
              Load <strong class={load === 11 ? 'eleven' : ''}>{load}</strong>
              <span class="hint">{load === 11 ? 'this one goes to eleven' : load === 0 ? 'off' : `${load} req / 3s`}</span>
            </span>
            <input type="range" min={0} max={11} step={1} value={load} onInput={(e) => setLoad(Number((e.target as HTMLInputElement).value))} aria-label="Automatic traffic load, 0 to 11" />
          </label>

          <button type="button" class="btn pg-reset" onClick={reset}>
            <RotateCcw size={14} strokeWidth={1.5} /> Reset
          </button>
        </aside>
      </div>

      <div class="pg-guide">
        <div class="strip missions">
          <div class="strip-head">
            <span class="eyebrow">Missions</span>
            <span class="counters">{missions.length}/{MISSIONS.length} done</span>
          </div>
          <ol>
            {MISSIONS.map((m, i) => {
              const done = missions.includes(m.id);
              const next = !done && MISSIONS.findIndex((x) => !missions.includes(x.id)) === i;
              return (
                <li key={m.id} class={done ? 'mission done' : next ? 'mission next' : 'mission'}>
                  <span class="mission-mark" aria-hidden="true">{done ? '✓' : i + 1}</span>
                  <div>
                    <strong>{m.title}</strong>
                    {(next || done) && <p>{m.why}</p>}
                  </div>
                  <span class="sr-only">{done ? 'done' : next ? 'next' : 'locked'}</span>
                </li>
              );
            })}
          </ol>
        </div>
        <div class="strip story" aria-live="polite">
          <div class="strip-head">
            <span class="eyebrow">What just happened</span>
            {story && <span class="counters">payment #{story.requestId}</span>}
          </div>
          {story ? (
            <ol class="story-lines">
              {story.lines.map((line, i) => (
                <li key={i} class={`story-line tone-${line.tone}`}>{line.text}</li>
              ))}
            </ol>
          ) : (
            <p class="empty">Each step of your next payment is explained here, in plain English.</p>
          )}
        </div>
      </div>

      <div class="pg-strips">
        <div class="strip">
          <div class="strip-head">
            <span class="eyebrow">Trace</span>
            <span class="counters">
              sent {stats.sent} · ok {stats.succeeded} · failed {stats.failed} · retries {stats.retries}
            </span>
          </div>
          {trace.length === 0 ? (
            <p class="empty">Send a payment, then kill something.</p>
          ) : (
            <ol class="trace">
              {trace.map((row) => (
                <li key={row.key} class={`trace-row out-${row.outcome}`}>
                  <span class="trace-id">#{row.requestId}.{row.number}</span>
                  <span class="trace-bars">
                    {row.waitBeforeMs > 0 && <span class="bar bar-wait" style={{ width: `${Math.min(45, row.waitBeforeMs / 40)}%` }} title={`backoff ${row.waitBeforeMs}ms`} />}
                    <span class="bar bar-attempt" style={{ width: `${Math.max(6, row.durationMs / 25)}%` }} />
                  </span>
                  <span class="trace-meta">
                    {row.waitBeforeMs > 0 && <span class="wait">wait {row.waitBeforeMs}ms · </span>}
                    {row.replica ? (row.replica === 'payA' ? 'pay-a' : 'pay-b') : 'gateway'} · {OUTCOME_LABEL[row.outcome]}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>

        <div class="strip">
          <div class="strip-head">
            <span class="eyebrow">Ledger</span>
            <span class={overchargedCents > 0 ? 'overcharged overcharged-bad' : 'overcharged'}>charged twice: {money(overchargedCents)}</span>
          </div>
          {ledger.length === 0 ? (
            <p class="empty">No charges yet.</p>
          ) : (
            <ol class="ledger">
              {ledger.map((row) => (
                <li key={row.txId} class={row.duplicate ? 'ledger-row dup' : 'ledger-row'}>
                  <span>tx {row.txId}</span>
                  <span>payment #{row.requestId}</span>
                  <span>{money(row.amountCents)}</span>
                  <span class="ledger-tag">{row.duplicate ? 'DUPLICATE' : '✓'}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>

      <div class="pg-achievements" aria-label="Achievements">
        <Trophy size={14} strokeWidth={1.5} />
        <span>
          Achievements {unlocked.length}/{ACHIEVEMENTS.length}
        </span>
        <ul>
          {ACHIEVEMENTS.map((a) => (
            <li key={a.id} class={unlocked.includes(a.id) ? 'ach ach-on' : 'ach'} title={unlocked.includes(a.id) ? `${a.title}: ${a.desc}` : 'Locked'}>
              {unlocked.includes(a.id) ? a.title : '???'}
            </li>
          ))}
        </ul>
      </div>

      {toast && (
        <div class="toast" role="status">
          <Trophy size={16} strokeWidth={1.5} />
          <div>
            <strong>{toast.title}</strong>
            <span>{toast.desc}</span>
          </div>
        </div>
      )}
      <p class="sr-only" aria-live="polite">{announcement}</p>
    </div>
  );
}
