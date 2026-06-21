# voltedge_attestor — on-chain attestor (fair price + no-arbitrage)

VoltEdge's defining strength is a **bit-exact mirror** of DeepBook Predict's
on-chain integer pricing pipeline (`packages/core/fixedpoint.ts`). This package
promotes that mirror **on-chain**: a Move module that re-derives quantities for a
live oracle and emits permanent, auditable events — the "oracle-of-the-oracle."

Two attestations:

1. **Fair price** — re-derive the binary UP price `N(d2)` and emit
   `FairPriceAttested`.
2. **No-arbitrage** — recompute Gatheral's butterfly density factor `g(k)`
   on-chain and emit `ArbitrageFlagged` when `g(k) < 0`. *The protocol stores the
   SVI surface but never checks it for static arbitrage; this is that watchdog,
   anchored on the chain.*

Both re-derive using the **protocol's own `public` math primitives**
(`deepbook_predict::math::{ln, sqrt, normal_cdf}`, `::i64`, `deepbook::math`).
The fair-price path is an op-for-op transcription of the protocol's **private**
`oracle::compute_nd2`; the `g(k)` path mirrors `fixedpoint.ts::gFunctionFixed`.
So each attestation is computed with the chain's own functions — structural
parity, not an assertion.

## Deployed (Sui testnet)

| | |
|---|---|
| **Package ID** (original) | `0xa5df8faa096b8ed9e88ea4d8cd7f639f5479d119520ea63f2e3a74ac13d70b8d` |
| **Package ID** (upgraded, adds `g(k)`) | `0x0e77ebf4667b4751dd0df2dbf9188576d5eaab278581ffaec176fbe5e438935a` |
| Publish tx | `PB2fbytuwhDBuGs4RippBvUkp3aLiSTtEeZuqN5ZwLU` |
| Upgrade tx | `Cashm4pJKXPkrXyLFnfAgy5J48ykyDcGQjiAUVT4vWCU` |
| UpgradeCap | `0xd7a7956a692882f679e08017575309c6e99205da50ef31eda15e40127a73aa36` |
| Example `FairPriceAttested` event | `Bps3xsnJRpusG6uMXZGCiK2imF752WxQe5hyTqj4K8Hq` |
| Example `ArbitrageFlagged` event | `21Ai22Nyc1meCxykNkRLjc2GHDV4hALYxqjB5EWkqf8s` |

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
on-chain g vs TS mirror: 32/32 EXACT, 32/32 sign-match (max |diff| 0 units)
VERDICT: the DEPLOYED on-chain no-arb check is BIT-EXACT vs the TS mirror.
```

(The snapshot must be atomic: the keeper pushes a new SVI every ~6.6 s, so a
non-atomic read shows races, not discrepancies.)

Move unit tests (`sui move test`): 8/8 — the `Φ(0) = 500_000_000` anchor, ATM
`N(d2) < 0.5`, strike-monotonicity, `EZeroForward`; plus `g(0) > 0` on a sane
ATM surface, `g(k) < 0` flagged on a steep-wing butterfly-arb slice, and the
`EZeroGVariance` abort.

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
