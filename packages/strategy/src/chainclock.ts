/**
 * Chain-clock calibration. Local machine clocks drift (we measured +39.6s
 * on the dev box with W32Time disabled); on-chain staleness checks use the
 * Sui Clock, so all freshness/window math must run in CHAIN time.
 *
 * Offset source: predict-server GET /status carries current_time_ms
 * (server wall clock, NTP-disciplined, within ~1s of chain time — far
 * inside the 30s staleness budget).
 */

export interface ChainClock {
  /** local Date.now() minus chain time; positive = local clock is fast */
  offsetMs: number;
  calibratedAt: number;
  now(): number;
}

export async function calibrateChainClock(indexerUrl: string): Promise<ChainClock> {
  const t0 = Date.now();
  const res = await fetch(`${indexerUrl}/status`);
  if (!res.ok) throw new Error(`/status -> ${res.status}`);
  const body = (await res.json()) as { current_time_ms?: number };
  const t1 = Date.now();
  if (typeof body.current_time_ms !== 'number') {
    throw new Error('/status missing current_time_ms');
  }
  // midpoint correction for request latency; integer ms (BigInt-safe)
  const offsetMs = Math.round(t0 + (t1 - t0) / 2 - body.current_time_ms);
  return {
    offsetMs,
    calibratedAt: t1,
    now: () => Date.now() - offsetMs,
  };
}
