# voltedge_attestor — on-chain fair-price attestor

VoltEdge's defining strength is a **bit-exact mirror** of DeepBook Predict's
on-chain integer pricing pipeline (`packages/core/fixedpoint.ts`). This package
promotes that mirror **on-chain**: a ~90-line Move module that re-derives the
binary UP price `N(d2)` for a live oracle and emits a permanent, auditable
event — the "oracle-of-the-oracle."

It re-derives the price using the **protocol's own `public` math primitives**
(`deepbook_predict::math::{ln, sqrt, normal_cdf}`, `::i64`, `deepbook::math`),
as an op-for-op transcription of the protocol's **private** `oracle::compute_nd2`.
So the attestation is the chain's own price, recomputed with the chain's own
functions — structural parity, not an assertion.

## Deployed (Sui testnet)

| | |
|---|---|
| **Package ID** | `0xa5df8faa096b8ed9e88ea4d8cd7f639f5479d119520ea63f2e3a74ac13d70b8d` |
| Publish tx | `PB2fbytuwhDBuGs4RippBvUkp3aLiSTtEeZuqN5ZwLU` |
| UpgradeCap | `0xd7a7956a692882f679e08017575309c6e99205da50ef31eda15e40127a73aa36` |
| Example `FairPriceAttested` event | `Bps3xsnJRpusG6uMXZGCiK2imF752WxQe5hyTqj4K8Hq` |

## API (`module voltedge_attestor::attestor`)

- `attest_fair_price(oracle: &OracleSVI, strike: u64)` — re-derive `N(d2)` from
  the oracle's live SVI and emit `FairPriceAttested { oracle_id, strike, forward,
  fair_up, checker_version }`. Composable in a PTB (pure read, no mutation).
- `fair_up(oracle: &OracleSVI, strike: u64): u64` — same, returns the value
  (for `devInspect` / difftests, no event).
- `nd2_from_params(a, b, rho, m, sigma, forward, strike): u64` — the
  unit-testable pure core over raw SVI params.

## Verification — bit-exact against the TypeScript mirror

`packages/chain/scripts/difftest-attestor.ts` reads, **in one atomic
`devInspect` snapshot**, the on-chain `fair_up` for several strikes plus
`oracle::svi` + `oracle::forward_price`, then computes the TS mirror
(`computeNd2Fixed`) from that same snapshot:

```
on-chain attestor vs TS mirror: 22/22 EXACT (max diff 0 units)
VERDICT: the DEPLOYED Move attestor is BIT-EXACT vs the mirror (and thus the chain).
```

(The snapshot must be atomic: the keeper pushes a new SVI every ~6.6 s, so a
non-atomic read shows races, not discrepancies.)

Move unit tests (`sui move test`): 5/5, including the `Φ(0) = 500_000_000`
anchor, ATM `N(d2) < 0.5`, strike-monotonicity, and the `EZeroForward` abort.

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
sui client publish --gas-budget 500000000   # → Package ID above
```
