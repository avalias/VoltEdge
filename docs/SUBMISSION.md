# DeepSurge Submission — VoltEdge

**Project name:** VoltEdge

**One-liner:** A quant terminal for DeepBook Predict — live volatility
surface, no-arbitrage monitoring, vault risk Monte-Carlo, and an
autonomous market-neutral strategy trading on-chain, all built on a
bit-exact mirror of the protocol's pricing pipeline.

**Track:** DeepBook (Predict)

## Description (for the submission form)

VoltEdge treats DeepBook Predict as what it really is — an options
market — and ships the quant infrastructure it needs on day one:

**Terminal** (read-only, zero setup): live SVI implied-volatility
surface across all expiry tiers with time-travel replay; a no-arbitrage
monitor verifying butterfly (Gatheral g(k) ≥ 0), calendar monotonicity
and parameter constraints on every SVI refit — it catches real
violations in the live feed (cross-tier calendar arbitrage, abandoned
oracles); an edge heatmap comparing the protocol's N(d2) quotes to
smile-consistent digital prices; a PLP vault dashboard running a
20,000-path Monte-Carlo on the vault's reconstructed strike book
in-browser; an oracle-health panel tracking keeper staleness and
settlement delays; and a live bot console with equity curve and a
Suiscan-linked trade log.

**Bit-exact pricing mirror:** we reimplemented the on-chain fixed-point
pipeline (ln/sqrt/exp/normal_cdf with Cody coefficients, sign-magnitude
i64, compute_nd2, the Bernoulli+utilization spread) in TypeScript with
BigInt — same constants, same operation order, same truncation. Verified
live: 48/48 quotes match the chain to **0 units**, and our first live
mint executed within 1e-6 of the mirror's prediction.

**Research (the "proper simulation result"):** a 2,620-cycle backtest on
indexed settlement history with full data forensics — we identified and
filtered keeper-outage settlements (up to 8.7h late) and the launch-week
feed mis-calibration, then measured the mature-era structure: the
realized 10-minute distribution is leptokurtic against the feed's
lognormal. The resulting **barbell strategy** (ATM range + far-wing
hedge) earns +7.7%/$1 after spread (t = 7.5, split-half stable) in
backtest; methodology, era controls, and honest limitations are in
`research/sim_report.md`.

**Autonomous executor:** enters every 15-minute cycle (one PTB: band
`mint_range` + wing `mint`s), sizes redeems from chain state via
devInspect (robust to external permissionless keepers), sweeps
settlements, and journals every decision. Running live on testnet with
real dUSDC; we also supply the PLP vault as an LP and run a goodwill
permissionless settlement keeper.

Everything is tested: 61 test definitions parametrizing ~283 runtime cases —
245 are golden-vector rows checked against independent routes (scipy CDF/PDF/
inverse, finite-difference SVI derivatives, call-spread-limit digitals).

## Links

- GitHub: https://github.com/avalias/VoltEdge
- Demo video: ≤5 min, recorded (voiced) — upload to YouTube, paste link
- Live site: https://avalias.github.io/VoltEdge/ (live, verified)
- Walrus Sites object (testnet, 45 epochs):
  `0xd8552738ac4e9f0da79d1730b9ef531e238634af3ead8c810207d5e6e0c695fd`
  (wal.app portal serves mainnet only; testnet sites need a self-hosted
  portal — the on-chain site object is the deployment proof)
- Deployment proof (Sui testnet):
  - **`voltedge_attestor` package `0xa5df8faa096b8ed9e88ea4d8cd7f639f5479d119520ea63f2e3a74ac13d70b8d`** (publish tx `PB2fbytuwhDBuGs4RippBvUkp3aLiSTtEeZuqN5ZwLU`)
  - on-chain `FairPriceAttested` event `Bps3xsnJRpusG6uMXZGCiK2imF752WxQe5hyTqj4K8Hq`
  - **upgraded package `0xdae37107a1c7d8bc62fe70586e55b88c11846c3d12e2c48807961b14d4041dcf`** (upgrade txs `Cashm4pJKXPkrXyLFnfAgy5J48ykyDcGQjiAUVT4vWCU` add `g(k)`, `G9YchsNJRS2APeQePPjoYChxiv2MothbNJMki5fyrith` add degenerate-slice guards) — adds the on-chain no-arb check (Gatheral `g(k)`)
  - on-chain `ArbitrageFlagged` event `86gxPiTH7vPaFbMhWy98m1xSmGB6WaLtwUsB4tYkhYZf`
  - PredictManager `0xe2ad1c2a75a5f4798a2ef38bdc8bc53a6084d03503cdb84baffd1f0c03861cc3`
  - first barbell mint `2Udm7NxHdnqettS5LaN3MVviis6jroDdxWbw5FxMHsip`
  - settlement sweep `2i49HrGQ6qVtTZxVQXb9KTQj1g5XKDXuTkBVJeJCNVWy`
  - PLP supply `9RJYTJRZ7FvtmVNKQP67Z34SwBFdU2sCVPe4zDzbmwrS`

## Form fields

- Logo: `docs/logo.png` (1024×1024)
- Deployment: Testnet
- Package ID (our deployed Move package):
  `0xa5df8faa096b8ed9e88ea4d8cd7f639f5479d119520ea63f2e3a74ac13d70b8d`
  — `voltedge_attestor`: re-derives the binary price N(d2) **on-chain** using
  the protocol's OWN public math primitives (`math::normal_cdf/ln/sqrt`, `i64`),
  an op-for-op transcription of the protocol's private `oracle::compute_nd2`, and
  emits a `FairPriceAttested` event. **Verified bit-exact (22/22, 0 units)**
  against our TS mirror on live oracles. The upgraded package
  `0xdae37107a1c7d8bc62fe70586e55b88c11846c3d12e2c48807961b14d4041dcf` adds an
  **on-chain no-arbitrage check** — Gatheral's butterfly density `g(k)`
  recomputed on-chain (the protocol stores SVI but never checks it for arb),
  emitting `ArbitrageFlagged`; **verified bit-exact (32/32, 0 units, signs match)**.
  Built on the official Predict package
  `0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138`.
