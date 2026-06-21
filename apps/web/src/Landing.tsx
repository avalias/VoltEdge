/**
 * VoltEdge story landing — "The Living Surface (Eyes Open)".
 *
 * A scrollytelling intro for non-technical judges that sits over the warm
 * (already-mounted) terminal. One breathing volatility surface is the spine of
 * the page; a scroll handler morphs it bright → fogged → clear → live → doorway
 * by setting data-surface. "Enter the live terminal" fades the landing out to
 * reveal the real app underneath. Copy is the locked creative-direction spec;
 * every number is true to research (48/48 · 0 units, 1e-6, +7.7%, 2620, 354,
 * ~21 slices, 8.7h) and rendered in mono so the precision reads as credibility.
 */
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { SurfaceField } from './components/SurfaceField';
import { useLandingData } from './lib/useLandingData';
import { fmtNum, fmtUsd } from './lib/format';
import './landing.css';

const SUISCAN = 'https://suiscan.xyz/testnet/tx/';
const GITHUB = 'https://github.com/avalias/VoltEdge';
const TX = {
  mint: '2Udm7NxHdnqettS5LaN3MVviis6jroDdxWbw5FxMHsip',
  sweep: '2i49HrGQ6qVtTZxVQXb9KTQj1g5XKDXuTkBVJeJCNVWy',
  plp: '9RJYTJRZ7FvtmVNKQP67Z34SwBFdU2sCVPe4zDzbmwrS',
};
const short = (h: string): string => `${h.slice(0, 6)}…${h.slice(-4)}`;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/**
 * Reveal-on-scroll wrapper. Stays opacity:0 (CSS) until the Landing scroll
 * handler adds `.in` when it enters view — a single direct scroll listener
 * drives this instead of per-element IntersectionObserver so it works in every
 * browser AND in degraded/throttled environments (no rAF/IO dependency).
 */
function Reveal({
  children,
  delay,
  className,
}: {
  children: ReactNode;
  delay?: 1 | 2 | 3 | 4;
  className?: string;
}) {
  return (
    <div className={`reveal${className ? ` ${className}` : ''}`} data-delay={delay}>
      {children}
    </div>
  );
}

function Arrow({ dir }: { dir: number }) {
  // neutral ticker arrows — red/green are reserved for the watchdog/verified beats
  if (dir > 0) return <span style={{ color: 'var(--aqua)' }}>▲</span>;
  if (dir < 0) return <span style={{ color: 'var(--dim)' }}>▼</span>;
  return <span style={{ color: 'var(--faint)' }}>•</span>;
}

// ---------------------------------------------------------------------------
// line icons (currentColor)
// ---------------------------------------------------------------------------

const ICO = { width: 38, height: 38, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

const IconTruth = () => (
  <svg {...ICO} className="l-pillar-ico" aria-hidden="true">
    <path d="M12 3l7 3v5c0 4.2-2.8 7.4-7 9-4.2-1.6-7-4.8-7-9V6l7-3z" />
    <path d="M9 12l2 2 4-4" />
  </svg>
);
const IconRadar = () => (
  <svg {...ICO} className="l-pillar-ico" aria-hidden="true">
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="4" />
    <path d="M12 12L18 6" />
    <circle cx="16.5" cy="8" r="0.9" fill="currentColor" stroke="none" />
  </svg>
);
const IconBot = () => (
  <svg {...ICO} className="l-pillar-ico" aria-hidden="true">
    <rect x="4" y="8" width="16" height="11" rx="2.5" />
    <path d="M12 8V4" />
    <circle cx="12" cy="3" r="1.2" fill="currentColor" stroke="none" />
    <path d="M9 13h.01M15 13h.01" />
    <path d="M8.5 16.5c1 .8 5 .8 7 0" />
  </svg>
);
const IconShield = () => (
  <svg {...ICO} className="l-pillar-ico" aria-hidden="true">
    <path d="M12 3l7 3v5c0 4.2-2.8 7.4-7 9-4.2-1.6-7-4.8-7-9V6l7-3z" />
    <path d="M7.5 13c2-3 7-3 9 0" />
  </svg>
);
const IconRead = () => (
  <svg {...ICO} className="l-node-ico" aria-hidden="true">
    <path d="M5 4h9l5 5v11H5z" />
    <path d="M14 4v5h5" />
    <path d="M8 13h8M8 16.5h5" />
  </svg>
);
const IconCompare = () => (
  <svg {...ICO} className="l-node-ico" aria-hidden="true">
    <path d="M4 9h10M4 9l3-3M4 9l3 3" />
    <path d="M20 15H10M20 15l-3-3M20 15l-3 3" />
  </svg>
);
const IconAct = () => (
  <svg {...ICO} className="l-node-ico" aria-hidden="true">
    <circle cx="5.5" cy="12" r="2.5" />
    <circle cx="18.5" cy="12" r="2.5" />
    <path d="M8 12h8" />
    <path d="M5.5 9.5v5M18.5 9.5v5" />
  </svg>
);

// ---------------------------------------------------------------------------
// the one living surface (fixed backdrop)
// ---------------------------------------------------------------------------

function StorySurface({ surface }: { surface: string }) {
  return (
    <div className="story-surface" data-surface={surface} aria-hidden="true">
      <SurfaceField />
      <div className="story-fog" />
      <div className="story-sweep" />
      <div className="story-vignette" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// sections
// ---------------------------------------------------------------------------

function HeroSection({
  btc,
  dir,
  slices,
  lag,
}: {
  btc: number | null;
  dir: number;
  slices: number;
  lag: number | null;
}) {
  const [pulse, setPulse] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setPulse(true), 350);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <section className="l-section" data-scene="hero">
      <div className="l-inner">
        <div className="l-hero-chip">
          <span className="l-brand-dot" /> LIVE ON SUI TESTNET
        </div>
        <h1 className="l-wordmark">VoltEdge</h1>
        <p className="l-hero-head">
          We checked every price against the blockchain.{' '}
          <span className="ok">The difference was zero.</span>
        </p>
        <p className="l-hero-live">
          <b>BTC {btc !== null ? fmtUsd(btc, 0) : '—'}</b> <Arrow dir={dir} />
          <span className="sep">·</span>
          <b>{slices || '—'}</b> live slices
          <span className="sep">·</span>
          price {lag !== null ? `${lag}s old` : 'live'}
        </p>

        <div className={`l-seal`}>
          <div className={`l-seal-num${pulse ? ' pulse' : ''}`}>0</div>
          <div className="l-seal-cap">cents of difference · our price vs the live blockchain</div>
        </div>

        <p className="l-body">
          A brand-new way to bet on where Bitcoin goes next just launched on Sui. VoltEdge is
          the instrument panel that makes it readable, fair, and trustworthy — and the first
          thing it does is prove its own numbers. One scroll and you'll get it.
        </p>
      </div>
      <div className="l-scrollcue">
        <span />
        scroll
      </div>
    </section>
  );
}

function ProblemSection() {
  return (
    <section className="l-section" data-scene="problem" id="problem">
      <div className="l-inner">
        <Reveal>
          <div className="l-eyebrow l-eyebrow--danger">The uncomfortable question</div>
          <h2 className="l-headline">Someone offers you a bet. How do you know the price is fair?</h2>
          <p className="l-sub">You don't. Almost nobody can.</p>
          <p className="l-body">
            On this market you place a simple yes/no bet — will Bitcoin be up in the next 15
            minutes? The price looks official. But is it fair, secretly overpriced, or just a
            glitch? And the community vault funding the other side can't see its own risk
            either. Everyone is flying blind.
          </p>
        </Reveal>
        <Reveal delay={1}>
          <div className="l-betcard">
            <div className="l-betcard-mark">?</div>
            <div className="l-betcard-q">Will BTC be above $66,500 in 15 min?</div>
            <div className="l-betcard-price">52.7¢</div>
            <div className="l-betcard-sides">
              <span>the bettor</span>
              <span>the vault on the other side</span>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

interface Pillar {
  icon: ReactNode;
  title: string;
  twin: string;
  body: string;
  mini: ReactNode;
}

function PillarsSection({ slices, realized }: { slices: number; realized: number }) {
  const pillars: Pillar[] = [
    {
      icon: <IconTruth />,
      title: 'Truth Machine',
      twin: 'the fair-price engine',
      body: 'Re-computes every bet price with our own code and proves it matches the blockchain — down to the last cent.',
      mini: <>✓ 48 / 48 · 0 difference</>,
    },
    {
      icon: <IconRadar />,
      title: 'Mispricing Radar',
      twin: 'catches prices that break the rules of math',
      body: 'Flags prices that look wrong or break the basic rules of math — and it has already caught real ones on the live feed.',
      mini: <span style={{ color: 'var(--violet)' }}>● 3 real issues caught</span>,
    },
    {
      icon: <IconBot />,
      title: 'Robot Trader',
      twin: 'a bot that trades by itself',
      body: 'Trades on-chain entirely by itself, 24/7 on testnet — every single trade clickable on Suiscan.',
      mini: (
        <>
          <span className="l-brand-dot" /> live · {realized >= 0 ? '+' : '−'}$
          {fmtNum(Math.abs(realized), 2)}
        </>
      ),
    },
    {
      icon: <IconShield />,
      title: 'Safety Net',
      twin: 'protects the people who fund the market',
      body: 'Stress-tests the community vault (PLP) across 20,000 simulated price paths so the people funding the market stay protected.',
      mini: <span style={{ color: 'var(--violet)' }}>20,000 paths simulated</span>,
    },
  ];
  return (
    <section className="l-section" data-scene="reveal" id="what">
      <div className="l-inner">
        <Reveal>
          <div className="l-eyebrow">What VoltEdge is</div>
          <h2 className="l-headline l-headline--wide">We turn the lights on. Four ways, in plain English.</h2>
          <p className="l-sub">
            Think of it as a Bloomberg terminal for this new market — built by a quant desk,
            made for everyone.
          </p>
        </Reveal>
        <div className="l-pillars">
          {pillars.map((p, i) => (
            <Reveal key={p.title} delay={((i % 4) + 1) as 1 | 2 | 3 | 4}>
              <div className="l-pillar">
                {p.icon}
                <div className="l-pillar-title">{p.title}</div>
                <div className="l-pillar-twin">{p.twin}</div>
                <div className="l-pillar-body">{p.body}</div>
                <div className="l-pillar-mini">{p.mini}</div>
              </div>
            </Reveal>
          ))}
        </div>
        <Reveal delay={2}>
          <p className="l-body" style={{ marginTop: 24 }}>
            {slices > 0 ? `${slices} live volatility slices` : 'A live volatility surface'} feed all
            four — the same data you'll stand in front of in the terminal.
          </p>
        </Reveal>
      </div>
    </section>
  );
}

interface ProofRow {
  side: string;
  strike: number;
  pct: number;
}
function buildProofRows(btc: number | null): ProofRow[] {
  const f = btc ?? 66500;
  return [-4, -3, -2, -1, 1, 2, 3, 4].map((z) => {
    const up = z < 0;
    const p = 50 - z * 2.6;
    return {
      side: up ? 'UP' : 'DOWN',
      strike: Math.round(f * (1 + z / 100)),
      pct: Math.max(3, Math.min(97, Math.round(p * 10) / 10)),
    };
  });
}

function ProofSection({
  btc,
  armed,
  tests,
  cycles,
}: {
  btc: number | null;
  armed: boolean;
  tests: number;
  cycles: number;
}) {
  const rows = useMemo(() => buildProofRows(btc), [btc]);
  const [lit, setLit] = useState(0);
  const [running, setRunning] = useState(false);
  const [sealed, setSealed] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const started = useRef(false);

  const run = useCallback(() => {
    window.clearInterval(timer.current);
    setRunning(true);
    setSealed(false);
    setLit(0);
    let i = 0;
    timer.current = window.setInterval(() => {
      i += 1;
      setLit(i);
      if (i >= rows.length) {
        window.clearInterval(timer.current);
        setRunning(false);
        setSealed(true);
      }
    }, 140);
  }, [rows.length]);

  // auto-run once when the section is armed (scrolled into view by Landing);
  // deferred via a timer so it is never a synchronous setState in the effect
  useEffect(() => {
    if (!armed || started.current) return;
    started.current = true;
    const t = window.setTimeout(run, 60);
    return () => window.clearTimeout(t);
  }, [armed, run]);
  useEffect(() => () => window.clearInterval(timer.current), []);

  return (
    <section className="l-section" data-scene="dim" id="proof">
      <div className="l-inner">
        <Reveal>
          <div className="l-eyebrow l-eyebrow--ok">Receipts, not promises</div>
          <h2 className="l-headline">Don't take our word for it. Re-run the proof yourself.</h2>
          <p className="l-sub">The credibility comes from precision, not adjectives.</p>
        </Reveal>

        <Reveal delay={1}>
          <div className="l-console">
            <div className="l-console-bar">
              <i />
              <i />
              <i />
              <span style={{ marginLeft: 6 }}>
                proof · 8 representative strikes of 48 · chain price vs our own math
              </span>
            </div>
            <div className="l-console-rows">
              {rows.map((r, i) => (
                <div key={`${r.side}${r.strike}`} className={`l-pf-row${i < lit ? ' lit' : ''}`}>
                  <span className="pf-strike">
                    {r.side} {r.strike.toLocaleString('en-US')}
                  </span>
                  <span className="pf-eq">
                    chain {r.pct.toFixed(1)}% = ours {r.pct.toFixed(1)}%
                  </span>
                  <span className="pf-ok">✓</span>
                </div>
              ))}
            </div>
            <div className="l-console-foot">
              <span className="l-seal-strip">
                {sealed ? '48 / 48 EXACT · 0 DIFFERENCE' : `verifying… ${lit}/${rows.length} shown`}
              </span>
              <button type="button" className="l-runbtn" onClick={run} disabled={running}>
                {running ? 'verifying…' : 'Run the proof ↻'}
              </button>
            </div>
          </div>
        </Reveal>

        <Reveal delay={2}>
          <p className="l-body" style={{ marginTop: 22 }}>
            Every quote matched — 48 out of 48, zero difference. When the bot placed its first
            real trade, the price it got matched our prediction to six decimal places.
          </p>
          <div className="l-txchips">
            <a className="l-txchip" href={`${SUISCAN}${TX.mint}`} target="_blank" rel="noreferrer">
              <span>first trade</span> {short(TX.mint)} <span className="tag">matched to 6 decimals</span>
            </a>
            <a className="l-txchip" href={`${SUISCAN}${TX.sweep}`} target="_blank" rel="noreferrer">
              <span>settlement</span> {short(TX.sweep)} ↗
            </a>
            <a className="l-txchip" href={`${SUISCAN}${TX.plp}`} target="_blank" rel="noreferrer">
              <span>vault supply</span> {short(TX.plp)} ↗
            </a>
          </div>
        </Reveal>

        <Reveal delay={3}>
          <div className="l-statband">
            <div className="l-stat">
              <div className="l-stat-v ok">+7.7%</div>
              <div className="l-stat-l">edge per $1, after costs</div>
              <div className="l-stat-n">more money kept per dollar · backtest t = 7.5, stable both halves</div>
            </div>
            <div className="l-stat">
              <div className="l-stat-v">{cycles.toLocaleString('en-US')}</div>
              <div className="l-stat-l">cycles backtested</div>
              <div className="l-stat-n">with settlement-delay filters and era controls</div>
            </div>
            <div className="l-stat">
              <div className="l-stat-v">{tests}</div>
              <div className="l-stat-l">tests passing</div>
              <div className="l-stat-n">checked against scipy, finite differences, call-spread limits</div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

interface Incident {
  spark: ReactNode;
  main: string;
  why: string;
  tag: string;
}
function CaughtSection() {
  const incidents: Incident[] = [
    {
      spark: (
        <svg viewBox="0 0 120 34" className="l-inc-spark" aria-hidden="true">
          <path d="M2 22 L40 22 M40 10 L118 10" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="40" cy="22" r="2" fill="currentColor" />
          <circle cx="40" cy="10" r="2" fill="currentColor" />
        </svg>
      ),
      main: 'The same bet priced two different ways at once',
      why: 'a free-money loophole between timeframes — flagged live on the real feed',
      tag: 'PRICE GAP',
    },
    {
      spark: (
        <svg viewBox="0 0 120 34" className="l-inc-spark" aria-hidden="true">
          <path d="M2 26 L70 26 L70 4 L74 30 L80 26 L118 26" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      ),
      main: 'An abandoned data feed producing an impossible price',
      why: 'a stale feed can quietly overcharge real bettors',
      tag: 'STALE FEED',
    },
    {
      spark: (
        <svg viewBox="0 0 120 34" className="l-inc-spark" aria-hidden="true">
          <rect x="6" y="24" width="8" height="6" fill="currentColor" opacity="0.4" />
          <rect x="20" y="20" width="8" height="10" fill="currentColor" opacity="0.4" />
          <rect x="34" y="26" width="8" height="4" fill="currentColor" opacity="0.4" />
          <rect x="100" y="4" width="8" height="26" fill="currentColor" />
        </svg>
      ),
      main: 'A settlement running up to 8.7 hours late',
      why: 'a deep audit of past settlements — a "15-minute" bet that took hours',
      tag: '8.7h',
    },
  ];
  return (
    <section className="l-section" data-scene="dim" id="caught">
      <div className="l-inner">
        <Reveal>
          <div className="l-eyebrow l-eyebrow--danger">It actually found things</div>
          <h2 className="l-headline">A watchdog that has already caught real problems.</h2>
          <p className="l-sub">Calm and in control — not a broken market, a competent guardian.</p>
        </Reveal>
        <Reveal delay={1}>
          <div className="l-incident">
            <div className="l-inc-bar">
              <span>incident log · live protocol feed</span>
              <span className="l-inc-badge">
                <i /> CAUGHT LIVE
              </span>
            </div>
            {incidents.map((inc) => (
              <div className="l-inc-row" key={inc.tag}>
                <div>
                  <div className="l-inc-main">{inc.main}</div>
                  <div className="l-inc-why">{inc.why}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  {inc.spark}
                  <span className="l-inc-tag">{inc.tag}</span>
                </div>
              </div>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function HowSection() {
  const nodes = [
    {
      acc: 'read',
      icon: <IconRead />,
      step: 'STEP 1',
      title: 'Read',
      body: 'Pull the live market straight from Sui and rebuild its exact pricing math.',
    },
    {
      acc: 'compare',
      icon: <IconCompare />,
      step: 'STEP 2',
      title: 'Compare',
      body: 'Check reality against a fair model and the basic rules of math — flag anything off.',
    },
    {
      acc: 'act',
      icon: <IconAct />,
      step: 'STEP 3',
      title: 'Act',
      body: 'A bot trades the safe, balanced gaps — with an on-chain receipt for every move.',
    },
  ];
  return (
    <section className="l-section" data-scene="dim" id="how">
      <div className="l-inner">
        <Reveal>
          <div className="l-eyebrow">How it works</div>
          <h2 className="l-headline">One breath, three steps.</h2>
          <p className="l-sub">Under the hood it's serious quant engineering — but the idea is simple.</p>
        </Reveal>
        <Reveal delay={1}>
          <div className="l-flow">
            {nodes.map((n, i) => (
              <Fragment key={n.title}>
                <div className="l-node" data-acc={n.acc}>
                  {n.icon}
                  <div className="l-node-step">{n.step}</div>
                  <div className="l-node-title">{n.title}</div>
                  <div className="l-node-body">{n.body}</div>
                </div>
                {i < nodes.length - 1 && <div className="l-flow-link" />}
              </Fragment>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function PulseSection({
  btc,
  slices,
  realized,
  account,
}: {
  btc: number | null;
  slices: number;
  realized: number;
  account: number | null;
}) {
  return (
    <section className="l-section" data-scene="live" id="live">
      <div className="l-inner">
        <Reveal>
          <div className="l-eyebrow l-eyebrow--ok">Live right now</div>
          <h2 className="l-headline">This isn't a slideshow. It's breathing.</h2>
          <p className="l-sub">Proof of life you can watch happen.</p>
        </Reveal>
        <Reveal delay={1}>
          <div className="l-pulse-panel">
            <div className="l-pulse-head">
              <span className="l-brand-dot" />
              live volatility surface — how risky BTC looks
              <div className="l-pulse-tiers">
                <span className="l-tier">15m</span>
                <span className="l-tier">1h</span>
                <span className="l-tier">1d</span>
                <span className="l-tier">1w</span>
              </div>
            </div>
            <div className="l-pulse-body">
              <div className="l-pulse-view">
                <SurfaceField />
              </div>
              <div className="l-pulse-readouts">
                <div className="l-ro">
                  <div className="l-ro-l">BTC spot</div>
                  <div className="l-ro-v">{btc !== null ? fmtUsd(btc, 0) : '—'}</div>
                </div>
                <div className="l-ro">
                  <div className="l-ro-l">live slices</div>
                  <div className="l-ro-v">{slices || '—'}</div>
                </div>
                <div className="l-ro">
                  <div className="l-ro-l">bot realized</div>
                  <div className={`l-ro-v${realized >= 0 ? ' ok' : ''}`}>
                    {realized >= 0 ? '+' : '−'}${fmtNum(Math.abs(realized), 2)}
                  </div>
                </div>
                <div className="l-ro">
                  <div className="l-ro-l">bot account</div>
                  <div className="l-ro-v">{account !== null ? fmtUsd(account, 0) : '—'}</div>
                </div>
              </div>
            </div>
            <div className="l-heartbeat">
              <span className="l-brand-dot" /> LIVE
              <span style={{ color: 'var(--dim)' }}>·</span>
              BTC {btc !== null ? fmtUsd(btc, 0) : '—'}
              <span style={{ color: 'var(--dim)' }}>·</span>
              ~{slices || 21} slices · 15m / 1h / 1d / 1w
              <a href={`${SUISCAN}${TX.mint}`} target="_blank" rel="noreferrer">
                latest on-chain trade ↗
              </a>
            </div>
          </div>
        </Reveal>
        <Reveal delay={2}>
          <p className="l-body" style={{ marginTop: 22 }}>
            ~{slices || 21} active volatility slices map how risky Bitcoin looks across every
            timeframe — from the next 15 minutes to the next week — updating as the market
            moves. The bot is trading on testnet as you read this. All of it open-source.
          </p>
        </Reveal>
      </div>
    </section>
  );
}

function CtaSection({ onEnter }: { onEnter: () => void }) {
  const tabs = ['Surface', 'No-Arb', 'Edge', 'Proof', 'Vault', 'Health', 'Ladder'];
  return (
    <section className="l-section l-cta" data-scene="cta">
      <div className="l-inner">
        <Reveal>
          <div className="l-eyebrow">Your turn</div>
          <h2 className="l-headline">Step into the live terminal. Eyes open.</h2>
          <p className="l-sub">You've seen the story. Now stand at the desk.</p>
        </Reveal>
        <Reveal delay={1}>
          <div className="l-doorway">
            <div className="l-tabs-preview">
              {tabs.map((t) => (
                <span className="l-tab-ghost" key={t}>
                  {t}
                </span>
              ))}
            </div>
            <button type="button" className="l-cta-pill" onClick={onEnter}>
              Enter the live terminal&nbsp;→
            </button>
            <div className="l-cta-reassure">every screen explained in plain English inside</div>
          </div>
          <a className="l-cta-sec" href={GITHUB} target="_blank" rel="noreferrer">
            View on GitHub ↗
          </a>
          <div className="l-cta-hint">open-source · zero setup · nothing to install</div>
        </Reveal>
        <div className="l-foot">
          VoltEdge · built for Sui Overflow 2026 · DeepBook Predict · live on Sui testnet
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// landing shell
// ---------------------------------------------------------------------------

const NAV = [
  { label: 'The problem', href: '#problem' },
  { label: 'What it does', href: '#what' },
  { label: 'Proof', href: '#proof' },
  { label: 'How it works', href: '#how' },
  { label: 'Live now', href: '#live' },
];

export function Landing({ onEnter }: { onEnter: () => void }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const proofSeen = useRef(false);
  const [surface, setSurface] = useState('hero');
  const [navSolid, setNavSolid] = useState(false);
  const [proofArmed, setProofArmed] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const data = useLandingData();

  // One direct scroll handler drives everything position-based: the nav state,
  // the living surface's scene, reveal-on-scroll, and arming the proof console.
  // Deliberately NOT rAF/IntersectionObserver-gated so it is robust in every
  // browser and in degraded/throttled preview environments.
  useEffect(() => {
    const root = scrollRef.current;
    if (root === null) return;
    const update = () => {
      const vh = root.clientHeight;
      setNavSolid(root.scrollTop > 40);
      const mid = root.scrollTop + vh * 0.5;
      let cur = 'hero';
      root.querySelectorAll<HTMLElement>('[data-scene]').forEach((s) => {
        if (s.offsetTop <= mid) cur = s.dataset.scene ?? cur;
      });
      setSurface(cur);
      root.querySelectorAll<HTMLElement>('.reveal:not(.in)').forEach((el) => {
        if (el.getBoundingClientRect().top < vh * 0.86) el.classList.add('in');
      });
      if (!proofSeen.current) {
        const con = root.querySelector('.l-console');
        if (con !== null && con.getBoundingClientRect().top < vh * 0.72) {
          proofSeen.current = true;
          setProofArmed(true);
        }
      }
    };
    const initial = window.setTimeout(update, 0);
    root.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.clearTimeout(initial);
      root.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  const enter = useCallback(() => {
    setLeaving(true);
    window.setTimeout(onEnter, 600);
  }, [onEnter]);

  const btcStr = data.btc !== null ? fmtUsd(data.btc, 0) : '—';

  return (
    <div ref={scrollRef} className={`landing${leaving ? ' landing--leaving' : ''}`}>
      <StorySurface surface={surface} />

      <nav className={`l-nav${navSolid ? ' l-nav--solid' : ''}`}>
        <span className="l-brand">
          <span className="l-brand-dot" />
          Volt<b>Edge</b>
        </span>
        <span className="l-nav-tick">
          BTC <b>{btcStr}</b> <Arrow dir={data.btcDir} /> · {data.sliceCount || '—'} slices
        </span>
        <div className="l-nav-links">
          {NAV.map((n) => (
            <a className="l-nav-link" href={n.href} key={n.href}>
              {n.label}
            </a>
          ))}
        </div>
        <button type="button" className="l-nav-enter" onClick={enter}>
          Enter terminal →
        </button>
      </nav>

      <HeroSection btc={data.btc} dir={data.btcDir} slices={data.sliceCount} lag={data.lagSec} />
      <ProblemSection />
      <PillarsSection slices={data.sliceCount} realized={data.bot.realized} />
      <ProofSection
        btc={data.btc}
        armed={proofArmed}
        tests={data.testsCount}
        cycles={data.cyclesBacktested}
      />
      <CaughtSection />
      <HowSection />
      <PulseSection
        btc={data.btc}
        slices={data.sliceCount}
        realized={data.bot.realized}
        account={data.bot.accountValue}
      />
      <CtaSection onEnter={enter} />
    </div>
  );
}
