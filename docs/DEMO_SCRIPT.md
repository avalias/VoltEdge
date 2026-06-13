# VoltEdge — Demo Video Script (≤5:00, YouTube)

Format: screen recording of the terminal + terminal console, voiceover
(Val or TTS), no talking head. 1080p, dark theme throughout. Cursor
moves SLOWLY. Every number on screen is live.

---

**[0:00–0:25] Cold open — the problem.** (Surface tab, live)

> "DeepBook Predict is Sui's new prediction protocol: BTC binary options
> with 15-minute expiries, priced by an SVI volatility surface. It's an
> options market — so it deserves an options desk. This is VoltEdge:
> every number you'll see is live from Sui testnet, right now."

Action: hover the smile chart, tier chips 15m/1h/1d/1w, BTC ticker
ticking in the header, "px age 1s".

**[0:25–1:10] Proof tab — the trust moment.**

> "First, why you can trust our numbers. The protocol prices binaries
> with integer math on-chain. We re-implemented that pipeline — same
> Cody coefficients, same operation order, same truncation — and the
> terminal can prove it live."

Action: click RUN PROOF. Wait ~3s. Banner appears: "N/N fair EXACT ·
N/N spread EXACT · max diff 0 units".

> "One atomic read-only inspection per oracle: the chain's quotes and
> our mirror, side by side. Zero units of difference. Everything else
> in this product is built on that mirror."

**[1:10–1:55] No-Arb + Health — we found real things.**

> "The monitor checks Gatheral's butterfly condition, calendar
> monotonicity and parameter sanity on every SVI refit. And it catches
> real violations — the feed fits each expiry independently, so
> cross-tier calendar arbitrage appears live."

Action: No-Arb tab, point at a VIOLATION row, hover margin sparkline.

> "Same with operations: settlement is the first keeper push after
> expiry. Our forensics found settlements up to eight point seven hours
> late — and this histogram tracks the keeper live."

Action: Health tab, histogram, worst-ever table.

**[1:55–2:50] The research — sim report.** (cut to charts: calibration,
weekly edge; show research/sim_report.md scrolling briefly)

> "We reconstructed twenty-six hundred settled cycles and asked: is the
> feed honest? Answer: variance is calibrated, but the SHAPE is wrong —
> the real ten-minute distribution is leptokurtic. Over-peaked center,
> depleted shoulders, fat tails. A lognormal can't express that. So the
> ATM range is persistently underpriced: it hits forty-seven percent of
> the time but is priced at thirty-eight. That's plus seven point seven
> percent per dollar AFTER spread, t-stat seven and a half, stable
> across both halves of the sample. The methodology — settlement-delay
> filters, era segmentation, the launch-week feed bug we excluded — is
> all in the report."

**[2:50–3:50] The bot — live receipts.** (Ladder tab)

> "That research runs as an autonomous strategy: every fifteen-minute
> cycle it buys an ATM range plus two far wings as crash insurance —
> one transaction, journal-deduped, settlement swept permissionlessly.
> This is its real account."

Action: Ladder tab — equity curve, open positions, trade log; click a
digest → Suiscan tx opens; back.

> "Every trade has an on-chain receipt. The executed prices match our
> mirror's predictions to the sixth decimal. And we're also an LP in
> the vault we trade against — collecting everyone else's spread."

Show Vault tab MC fan for 5 seconds: "and this Monte-Carlo runs the
vault's reconstructed book through twenty thousand joint scenarios,
in your browser."

**[3:50–4:30] What this means for DeepBook.** (Surface replay scrub)

> "For traders: a desk. For LPs: honest risk. For the DeepBook team:
> an independent calibration audit of their feed — we've already found
> the staleness gate gap, the cross-tier arbitrage, the settlement
> delays, and the indexer's range-PnL blind spot. VoltEdge is the
> instrumentation layer Predict needs on mainnet day one."

**[4:30–5:00] Close.** (README on screen)

> "Three hundred fifty tests against independent references. A bit-exact
> mirror proven live. A strategy with a public track record. Built in
> nine days for Sui Overflow. VoltEdge — see the surface, trade the
> edge."

Links on end card: repo, live site, manager id.

---

## Recording checklist

- [ ] Bot has been running ≥24h (equity curve has texture)
- [ ] Clock skew fixed on the recording machine (or rely on built-in correction)
- [ ] Browser zoom 110%, 1920×1080, hide bookmarks bar
- [ ] Proof tab rehearsed (stale oracles can skip — fine, mention nothing)
- [ ] OBS: 60fps, mic check, room tone
- [ ] Cut to ≤4:55, export 1080p, upload unlisted → link in submission
