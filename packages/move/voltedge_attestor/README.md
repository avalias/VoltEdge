# voltedge_attestor — on-chain attestor (fair price + no-arbitrage)

VoltEdge's defining strength is a **bit-exact mirror** of DeepBook Predict's
on-chain integer pricing pipeline (`packages/core/fixedpoint.ts`). This package
promotes that mirror **on-chain**: a Move module that re-derives quantities for a
live oracle and emits permanent, auditable events — the "oracle-of-the-oracle."

Three attestations:

1. **Fair price** — re-derive the binary UP price `N(d2)` and emit
   `FairPriceAttested`.
2. **No-arbitrage, butterfly** — recompute Gatheral's butterfly density factor
   `g(k)` on-chain and emit `ArbitrageFlagged` when `g(k) < 0`.
3. **No-arbitrage, calendar** — recompute the across-expiry variance spread
   `w_near(k) − w_far(k)` for two same-underlying oracles and emit
   `CalendarArbFlagged` when `w_near > w_far` (variance must not decrease with
   expiry). *The protocol stores the SVI surface but never checks it for
   arbitrage in either dimension; this is that watchdog, anchored on the chain.*

All re-derive using the **protocol's own `public` math primitives**
(`deepbook_predict::math::{ln, sqrt, normal_cdf}`, `::i64`, `deepbook::math`).
The fair-price path is an op-for-op transcription of the protocol's **private**
`oracle::compute_nd2`; the `g(k)` path mirrors `fixedpoint.ts::gFunctionFixed`;
the calendar path mirrors `totalVarianceFixed(near,k) − totalVarianceFixed(far,k)`.
So each attestation is computed with the chain's own functions — structural
parity, not an assertion.

Beyond the read-only attestations, the package ships an **on-chain slippage
guard** (`module voltedge_attestor::guard`). The protocol's `mint` / `mint_range`
charge the current (post-trade) price with **no cost ceiling**, so an adverse SVI
move between an off-chain signal and execution fills at whatever the surface
implies. `safe_mint` composes the protocol's **own** quote and mint
**atomically** — it reads `get_trade_amounts` in the same transaction the mint
uses, `assert!(cost <= max_cost, ESlippage)`, and only then mints. One tx, no
snapshot race, no fill past `max_cost`. Demonstrated live via devInspect (see
below): mints within the ceiling, reverts one unit past it.

## Deployed (Sui testnet)

| | |
|---|---|
| **Package ID** (original) | `0xa5df8faa096b8ed9e88ea4d8cd7f639f5479d119520ea63f2e3a74ac13d70b8d` |
| **Package ID** (latest — attestations + `guard`) | `0x802e7c37debb860fe7902f2003ba8431741da3fbc36c8725cb63eb50be8840f0` |
| Publish tx | `PB2fbytuwhDBuGs4RippBvUkp3aLiSTtEeZuqN5ZwLU` |
| Upgrade tx (add `g(k)`) | `Cashm4pJKXPkrXyLFnfAgy5J48ykyDcGQjiAUVT4vWCU` |
| Upgrade tx (degenerate-slice guards) | `G9YchsNJRS2APeQePPjoYChxiv2MothbNJMki5fyrith` |
| Upgrade tx (add calendar check) | `21qKxiC3J9QNRKUu3kJ9kcWEgCSzkcwQZrR8CGRf7jBW` |
| Upgrade tx (add `guard` / `safe_mint`) | `MyGZyX55SL4MM2vMisZxtpQ1UnJhSWcGHFe9Gg3oGs8` |
| UpgradeCap | `0xd7a7956a692882f679e08017575309c6e99205da50ef31eda15e40127a73aa36` |
| Example `FairPriceAttested` event | `Bps3xsnJRpusG6uMXZGCiK2imF752WxQe5hyTqj4K8Hq` |
| Example `ArbitrageFlagged` event | `86gxPiTH7vPaFbMhWy98m1xSmGB6WaLtwUsB4tYkhYZf` |
| Example `CalendarArbFlagged` event | `Giup5YF1RNKJ3fW4VkGbzwPnp46ihaZUB2ZYjQgxJw3S` |

## API (`module voltedge_attestor::attestor`)

**Fair price**
- `attest_fair_price(oracle: &OracleSVI, strike: u64)` — re-derive `N(d2)` from
  the oracle's live SVI and emit `FairPriceAttested { oracle_id, strike, forward,
  fair_up, checker_version }`. Composable in a PTB (pure read, no mutation).
- `fair_up(oracle: &OracleSVI, strike: u64): u64` — same, returns the value
  (for `devInspect` / difftests, no event).
- `nd2_from_params(a, b, rho, m, sigma, forward, strike): u64` — the
  unit-testable pure core over raw SVI params.

**No-arbitrage**
- `attest_no_arb(oracle: &OracleSVI, strike: u64)` — compute `g(k)` at
  `k = ln(strike/forward)` and emit `ArbitrageFlagged { oracle_id, strike,
  k_magnitude, k_negative, g_magnitude, g_negative, checker_version }`.
  `g_negative == true` ⇒ butterfly arbitrage at that strike.
- `g_for_strike(oracle: &OracleSVI, strike: u64): I64` — same, returns signed
  `g(k)` (for `devInspect` / difftests, no event).
- `g_from_params(a, b, rho, m, sigma, k): I64` — the pure core; op-for-op mirror
  of `fixedpoint.ts::gFunctionFixed`. `g(k) = (1 − k·w'/2w)² − (w'²/4)(1/w+1/4) +
  w''/2`, with `w, w', w''` the SVI total variance and its first two derivatives.

**No-arbitrage, calendar**
- `attest_calendar(near: &OracleSVI, far: &OracleSVI, strike: u64)` — compute
  `w_near(k) − w_far(k)` at `k = ln(strike/near_forward)` and emit
  `CalendarArbFlagged { near_id, far_id, strike, k_*, w_near, w_far, spread_*,
  arb, checker_version }`. Guards same-underlying + `near.expiry < far.expiry`
  (read from the oracles' getters); `arb == true` ⇒ `w_near > w_far`.
- `calendar_spread(near, far, strike): I64` — same, returns the signed spread
  (for `devInspect` / difftests, no event).
- `calendar_spread_from_params(near_params…, far_params…, k): I64` — pure core,
  mirrors `totalVarianceFixed(near,k) − totalVarianceFixed(far,k)`.

## API (`module voltedge_attestor::guard`)

- `safe_mint<Quote>(predict, manager, oracle, key: MarketKey, quantity, max_cost,
  clock, ctx)` — quote the live cost via `get_trade_amounts`, `assert!(cost <=
  max_cost, ESlippage)`, then `predict::mint`. Atomic; `ctx.sender()` is
  preserved so the protocol's owner-gate still applies.
- `safe_mint_range<Quote>(…, max_cost, …)` — same for a vertical range leg.
- `quote_mint_cost(predict, oracle, key, quantity, clock): u64` /
  `quote_range_mint_cost(…)` — read-only live cost, so a caller can set `max_cost`.

## Verification — bit-exact against the TypeScript mirror

`packages/chain/scripts/difftest-attestor.ts` reads, **in one atomic
`devInspect` snapshot**, the on-chain `fair_up` for several strikes plus
`oracle::svi` + `oracle::forward_price`, then computes the TS mirror
(`computeNd2Fixed`) from that same snapshot:

```
on-chain attestor vs TS mirror: 22/22 EXACT (max diff 0 units)
VERDICT: the DEPLOYED Move attestor is BIT-EXACT vs the mirror (and thus the chain).
```

`packages/chain/scripts/difftest-noarb.ts` does the same for `g(k)` against
`gFunctionFixed`, comparing both magnitude and sign over a wide strike fan:

```
on-chain g vs TS mirror: 46/46 EXACT, 46/46 sign-match (max |diff| 0 units)
VERDICT: the DEPLOYED on-chain no-arb check is BIT-EXACT vs the TS mirror.
```

`packages/chain/scripts/difftest-calendar.ts` does the same for the calendar
spread against `totalVarianceFixed(near) − totalVarianceFixed(far)`, over
same-underlying near→far oracle pairs:

```
on-chain spread vs TS mirror: 28/28 EXACT, 28/28 sign-match (max |diff| 0 units)
VERDICT: the DEPLOYED on-chain calendar check is BIT-EXACT vs the TS mirror.
```

(The snapshot must be atomic: the keeper pushes a new SVI every ~6.6 s, so a
non-atomic read shows races, not discrepancies. Per-run strike counts vary with
the number of live oracles; the 0-unit invariant does not.)

`packages/chain/scripts/guard-demo.ts` proves the `safe_mint` slippage guard on
a live oracle via devInspect (dry-run — no position is created, the live track
record is untouched):

```
live mint cost (get_trade_amounts) = $5.1302
safe_mint(max_cost = cost + $1.00)  -> success ✓ mints
safe_mint(max_cost = cost − 1 unit) -> failure ✓ ESlippage abort
safe_mint(max_cost = $0.000001)     -> failure ✓ ESlippage abort
VERDICT: safe_mint mints within the ceiling and reverts past it — no fill above max_cost.
```

Move unit tests (`sui move test`): 12/12 — the `Φ(0) = 500_000_000` anchor, ATM
`N(d2) < 0.5`, strike-monotonicity, `EZeroForward`; `g(0) > 0` on a sane ATM
surface, `g(k) < 0` flagged on a steep-wing butterfly-arb slice, the
`EZeroGVariance` abort, two degenerate-slice guards (`EDegenerateSlice`:
tiny-σ ATM where the `s^1.5` denominator underflows, and σ=0 ATM where the
derivative divides by a zero root — named guards, never a raw VM div-by-zero);
plus calendar healthy (`w_near < w_far`) and calendar-arb (`w_near > w_far`)
sign cases.

## Build & deploy

The package links against the **already-deployed** protocol. Build it alongside
the protocol sources (`deepbook`, `deepbook_predict`, `token`); for publish, the
dependency packages are pinned to their on-chain testnet addresses so only this
module is published (the protocol is linked, not re-published):

- `deepbook_predict` published-at `0xf5ea2b37…5138`
- `deepbook` address `0xfb28c4…6982` / published-at `0x74cd56…77c8` (upgraded)
- `token` `0x36dbef…58a8`

(these were read from the live Predict package's on-chain linkage table)

```bash
sui move build
sui move test --gas-limit 100000000000
sui client publish --gas-budget 500000000   # → original Package ID
# the no-arb upgrade was a compatible (additive) upgrade:
sui client upgrade -c <UpgradeCap> --gas-budget 300000000   # → upgraded Package ID
```
