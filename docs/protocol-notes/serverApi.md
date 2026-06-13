# serverApi

## Summary
Mapped the DeepBook Predict indexer stack (crates predict-server / predict-schema / predict-indexer). predict-server is an axum 0.7 read-only HTTP API (28 GET routes incl. /, no POST, no websocket/SSE — axum built with only the "json" feature) over a Postgres DB populated by predict-indexer, plus live Sui fullnode reads (dev_inspect PTBs) for vault snapshots, manager balances, and position mark prices. predict-schema defines 21 diesel tables (one per Move event type + watermarks). All on-chain prices/percentages are fixed-point 1e9 (FLOAT_SCALING); SVI params rho/m are sign-magnitude (magnitude + *_negative bool). CORS is wide open (Any origin, GET/OPTIONS). Default per-route limit=100, no offset pagination — only time-window filters on /oracles/:id/prices.

## Facts
### crate layout
Three predict crates: predict-server (axum HTTP API, bin predict-server), predict-schema (diesel tables + embedded migrations, lib), predict-indexer (sui-indexer-alt-framework checkpoint pipeline, bin predict-indexer). Sibling crates server/schema/indexer are the non-predict DeepBook v3 ones. Move sources for the protocol are in packages/predict/sources/.
_src: C:/Users/tvoiv/Desktop/SuiOverflowVal/vendor/deepbookv3-predict/crates/_

### server config defaults
predict-server CLI/env args: server_port=9008, metrics_address=0.0.0.0:9184 (Prometheus), database_url=postgres://localhost:5432/predict_v2, rpc_url=https://fullnode.testnet.sui.io:443. Server binds 0.0.0.0:server_port. predict-indexer: metrics 0.0.0.0:9185, same DB default, remote store https://checkpoints.testnet.sui.io, optional --predict-package-id override.
_src: C:/Users/tvoiv/Desktop/SuiOverflowVal/vendor/deepbookv3-predict/crates/predict-server/src/main.rs_

### CORS
CorsLayer::new().allow_methods(AllowMethods::list(vec![Method::GET, Method::OPTIONS])).allow_headers(Any).allow_origin(Any) — any origin can poll from a browser; only GET/OPTIONS allowed (API is read-only anyway). Applied to every route.
_src: C:/Users/tvoiv/Desktop/SuiOverflowVal/vendor/deepbookv3-predict/crates/predict-server/src/server.rs (make_router, lines 165-218)_

### no websocket/SSE
Router registers only axum get() handlers; Cargo.toml uses axum = { version = "0.7", features = ["json"] } — no "ws" feature, no SSE imports anywhere in predict-server/src. Frontend must poll. Indexer 'streaming' args are checkpoint-ingestion only, not client-facing.
_src: C:/Users/tvoiv/Desktop/SuiOverflowVal/vendor/deepbookv3-predict/crates/predict-server/Cargo.toml_

### route: health
GET / and GET /health → 200 empty body (StatusCode::OK only, no JSON).
_src: C:/Users/tvoiv/Desktop/SuiOverflowVal/vendor/deepbookv3-predict/crates/predict-server/src/server.rs_

### route: GET /oracles
No params. Returns Vec<OracleInfo>: {predict_id: String, oracle_id: String, oracle_cap_id: String, underlying_asset: String, expiry: i64(ms), min_strike: i64, tick_size: i64, status: "created"|"active"|"settled", activated_at: i64|null, settlement_price: i64|null, settled_at: i64|null, created_checkpoint: i64}. Assembled by joining oracle_created with latest oracle_activated/oracle_settled per oracle_id. Ordered newest-created first.
_src: C:/Users/tvoiv/Desktop/SuiOverflowVal/vendor/deepbookv3-predict/crates/predict-server/src/server.rs (OracleInfo struct lines 269-283)_

### route: GET /oracles/:oracle_id/prices
Query: limit (i64, default 100), start_time (i64 ms, inclusive >=), end_time (i64 ms, inclusive <=) — both filter checkpoint_timestamp_ms. Returns Vec<OraclePricesUpdatedRow>: {event_digest, digest, sender, checkpoint, checkpoint_timestamp_ms, tx_index, event_index, package, oracle_id, spot: i64, forward: i64, onchain_timestamp: i64}. Ordered checkpoint_timestamp_ms DESC (newest first). spot/forward are 1e9 fixed-point underlying prices.
_src: C:/Users/tvoiv/Desktop/SuiOverflowVal/vendor/deepbookv3-predict/crates/predict-server/src/server.rs + reader.rs get_oracle_prices_

### route: GET /oracles/:oracle_id/prices/latest
No params. Returns single OraclePricesUpdatedRow (not array). 404 'Resource not found: oracle prices for {id}' if no price rows yet.
_src: C:/Users/tvoiv/Desktop/SuiOverflowVal/vendor/deepbookv3-predict/crates/predict-server/src/server.rs_

### route: GET /oracles/:oracle_id/svi and /svi/latest
/svi takes ?limit= (default 100), returns Vec<OracleSviUpdatedRow> newest-first; /svi/latest returns single row (404 if none). Row: {event_digest, digest, sender, checkpoint, checkpoint_timestamp_ms, tx_index, event_index, package, oracle_id, a: i64, b: i64, rho: i64 (magnitude), rho_negative: bool, m: i64 (magnitude), m_negative: bool, sigma: i64, onchain_timestamp: i64}. SVI total variance w(k)=a+b*(rho*(k-m)+sqrt((k-m)^2+sigma^2)); reconstruct signed: rho_f = (rho_negative?-1:1)*rho/1e9, m_f = (m_negative?-1:1)*m/1e9, a/1e9, b/1e9, sigma/1e9. This IS the SVI history endpoint for the surface viewer.
_src: C:/Users/tvoiv/Desktop/SuiOverflowVal/vendor/deepbookv3-predict/crates/predict-schema/src/models.rs (OracleSviUpdatedRow lines 64-84)_

### route: GET /oracles/:oracle_id/state
One-shot oracle dashboard fetch. Returns OracleStateResponse: {oracle: OracleInfo, latest_price: OraclePricesUpdatedRow|null, latest_svi: OracleSviUpdatedRow|null, ask_bounds: OracleAskBoundsSetRow|null}. 404 if oracle_id unknown (oracle_created missing).
_src: C:/Users/tvoiv/Desktop/SuiOverflowVal/vendor/deepbookv3-predict/crates/predict-server/src/server.rs (lines 315-321, 1534-1555)_

### route: GET /oracles/:oracle_id/ask-bounds
No params. Returns OracleAskBoundsSetRow|null: {event_digest, digest, sender, checkpoint, checkpoint_timestamp_ms, tx_index, event_index, package, predict_id, oracle_id, min_ask_price: i64, max_ask_price: i64} (1e9 scale). Implemented as UNION of set/cleared events ordered by event order; returns null when the latest event is a 'cleared'.
_src: C:/Users/tvoiv/Desktop/SuiOverflowVal/vendor/deepbookv3-predict/crates/predict-server/src/reader.rs get_latest_oracle_ask_bounds (lines 867-983)_

### route: GET /positions/minted and /positions/redeemed
Query: oracle_id?, trader?, manager_id?, limit? (default 100), newest first. /minted returns Vec<PositionMintedRow>: {event_digest, digest, sender, checkpoint, checkpoint_timestamp_ms, tx_index, event_index, package, predict_id, manager_id, trader, quote_asset, oracle_id, expiry, strike, is_up: bool, quantity: i64, cost: i64, ask_price: i64}. /redeemed returns Vec<PositionRedeemedRow>: same meta + {owner, executor, quote_asset, oracle_id, expiry, strike, is_up, quantity, payout: i64, bid_price: i64, is_settled: bool}. GOTCHA: on /redeemed the ?trader= query param filters the `owner` column.
_src: C:/Users/tvoiv/Desktop/SuiOverflowVal/vendor/deepbookv3-predict/crates/predict-server/src/server.rs (get_positions_minted/redeemed) + reader.rs_

### route: GET /ranges/minted and /ranges/redeemed
Same query params as positions (oracle_id, trader, manager_id, limit). RangeMintedRow: {meta..., predict_id, manager_id, trader, quote_asset, oracle_id, expiry, lower_strike: i64, higher_strike: i64, quantity, cost, ask_price}. RangeRedeemedRow: {meta..., predict_id, manager_id, trader, quote_asset, oracle_id, expiry, lower_strike, higher_strike, quantity, payout, bid_price, is_settled: bool}. Note: range redeemed filter field is `trader` (unlike position redeemed which is owner). These are the rows for the range-ladder strategy executor.
_src: C:/Users/tvoiv/Desktop/SuiOverflowVal/vendor/deepbookv3-predict/crates/predict-schema/src/models.rs (lines 174-221)_

### route: GET /trades/:oracle_id
Query: limit? (default 100). Merges position mints+redeems for the oracle, sorts desc by (checkpoint, tx_index, event_index), truncates to limit. Returns Vec<TradeEvent> serde-tagged: {"type":"mint", ...PositionMintedRow fields} | {"type":"redeem", ...PositionRedeemedRow fields} (serde tag="type", flattened row fields at top level). Range trades NOT included.
_src: C:/Users/tvoiv/Desktop/SuiOverflowVal/vendor/deepbookv3-predict/crates/predict-server/src/server.rs (TradeEvent enum lines 285-292, get_trades)_

### route: GET /lp/supplies and /lp/withdrawals
Query: supplier? (supplies), withdrawer? (withdrawals), limit? (default 100), newest first. SuppliedRow: {meta..., predict_id, supplier, quote_asset, amount: i64, shares_minted: i64}. WithdrawnRow: {meta..., predict_id, withdrawer, quote_asset, amount: i64, shares_burned: i64}. PLP share-flow history for the vault dashboard.
_src: C:/Users/tvoiv/Desktop/SuiOverflowVal/vendor/deepbookv3-predict/crates/predict-schema/src/models.rs (lines 225-259)_

### route: GET /managers
Query: owner? (address filter). Returns Vec<PredictManagerCreatedRow>: {event_digest, digest, sender, checkpoint, checkpoint_timestamp_ms, tx_index, event_index, package, manager_id, owner}. NO limit param and no internal cap — returns all managers.
_src: C:/Users/tvoiv/Desktop/SuiOverflowVal/vendor/deepbookv3-predict/crates/predict-server/src/reader.rs get_managers (lines 622-650)_

### route: GET /managers/:manager_id/positions and /ranges
No query params. /positions → {minted: Vec<PositionMintedRow>, redeemed: Vec<PositionRedeemedRow>}; /ranges → {minted: Vec<RangeMintedRow>, redeemed: Vec<RangeRedeemedRow>}. Both internally capped at 1000 rows each (hardcoded limit in get_positions_for_manager/get_ranges_for_manager), newest first.
_src: C:/Users/tvoiv/Desktop/SuiOverflowVal/vendor/deepbookv3-predict/crates/predict-server/src/reader.rs (lines 541-552, 652-663)_

### route: GET /managers/:manager_id/positions/summary
404 if manager unknown. Returns Vec<ManagerPositionSummaryRow>: {predict_id, manager_id, quote_asset, oracle_id, underlying_asset: String|null, expiry, strike, is_up, minted_quantity, redeemed_quantity, open_quantity, total_cost, total_payout, realized_pnl, unrealized_pnl, open_cost_basis, average_entry_price: i64|null, average_exit_price: i64|null, mark_price: i64|null, mark_value: i64|null, status: "awaiting_settlement"|"active"|"redeemable"|"lost"|"redeemed", first_minted_at, last_activity_at}. Sorted by status rank (awaiting_settlement=0, active=1, redeemable=2, lost=3, redeemed=4), then expiry, strike, up-before-down. avg prices = amount*1e9/quantity. Mark prices come from LIVE dev_inspect of predict::get_trade_amounts (result index 1 = redeem payout) per open position — slow-ish, hits fullnode.
_src: C:/Users/tvoiv/Desktop/SuiOverflowVal/vendor/deepbookv3-predict/crates/predict-server/src/server.rs (ManagerPositionSummaryRow lines 348-373, quote_position_marks lines 1278-1414)_

### route: GET /managers/:manager_id/summary
Returns ManagerSummaryResponse: {manager_id, owner, balances: [{quote_asset: String, balance: i64}], trading_balance: i64, open_exposure: i64, redeemable_value: i64, realized_pnl: i64, unrealized_pnl: i64, account_value: i64, open_positions: usize, awaiting_settlement_positions: usize}. Balances fetched live via dev_inspect PTB calling predict_manager::balance<QuoteAsset>(manager) for each enabled quote asset. account_value = trading_balance + sum(mark_value of open).
_src: C:/Users/tvoiv/Desktop/SuiOverflowVal/vendor/deepbookv3-predict/crates/predict-server/src/server.rs (lines 381-394, fetch_manager_balances 1220-1276)_

### route: GET /managers/:manager_id/pnl
Query: range? in {1D,1W,1M,3M,ALL} (case-insensitive, default/unknown→ALL). Returns ManagerPnlResponse: {manager_id, range: String (normalized uppercase), series_type: "realized_pnl", points: [{timestamp_ms, realized_pnl, cumulative_realized_pnl}], current_unrealized_pnl: i64, current_total_pnl: i64}. Points computed from FULL mint/redeem history (proportional cost-basis FIFO-pool), then window-filtered; cumulative includes pre-window history.
_src: C:/Users/tvoiv/Desktop/SuiOverflowVal/vendor/deepbookv3-predict/crates/predict-server/src/server.rs (ManagerPnlResponse 437-445, compute_realized_pnl_points 957-1027)_

### route: GET /predicts/:predict_id/quote-assets
Returns Vec<String> of enabled quote asset type names (latest enable/disable event per asset wins, computed via DISTINCT ON SQL). Type strings come from Move TypeName, e.g. no 0x prefix (server normalizes by prepending 0x when used in PTBs).
_src: C:/Users/tvoiv/Desktop/SuiOverflowVal/vendor/deepbookv3-predict/crates/predict-server/src/reader.rs get_enabled_quote_assets (lines 987-1028)_

### route: GET /predicts/:predict_id/state and GET /config
Both return ConfigResponse: {predict_id: String, pricing: object|null, risk: object|null, trading_paused: bool|null, quote_assets: [String]}. pricing = serialized PricingConfigUpdatedRow {event meta..., predict_id, base_spread, min_spread, utilization_multiplier, min_ask_price, max_ask_price} (all 1e9 scale); risk = RiskConfigUpdatedRow {..., max_total_exposure_pct} (1e9 scale, e.g. 80% default). /config uses the latest predict_created row's predict_id (404 'Resource not found: predict' if none); /predicts/:id/state takes the id from the path.
_src: C:/Users/tvoiv/Desktop/SuiOverflowVal/vendor/deepbookv3-predict/crates/predict-server/src/server.rs (ConfigResponse 306-313, get_predict_state 1770-1798, get_config 1931-1961)_

### route: GET /predicts/:predict_id/oracles
Returns Vec<OracleInfo> filtered to oracle_created rows whose predict_id matches; status joined against global activated/settled sets.
_src: C:/Users/tvoiv/Desktop/SuiOverflowVal/vendor/deepbookv3-predict/crates/predict-server/src/server.rs get_predict_oracles_

### route: GET /predicts/:predict_id/vault/summary (PLP risk dashboard)
Returns VaultSummaryResponse: {predict_id, quote_assets: [String], vault_balance: i64, vault_value: i64, total_mtm: i64, total_max_payout: i64, available_liquidity: i64, available_withdrawal: i64, plp_total_supply: i64, plp_share_price: f64, utilization: f64, max_payout_utilization: f64, net_deposits: i64, total_supplied: i64, total_withdrawn: i64}. LIVE on-chain snapshot: fetches Predict shared object via RPC and reads fields vault.balance, vault.total_mtm, vault.total_max_payout, treasury_cap.total_supply.value, withdrawal_limiter.{enabled,available,capacity,refill_rate_per_ms,last_updated_ms}, treasury_config.accepted_quotes.contents[].name. Derivations: available_liquidity=max(balance-total_max_payout,0); vault_value=max(balance-total_mtm,0); plp_share_price=vault_value/plp_total_supply (1.0 if supply 0); utilization=total_mtm/balance; max_payout_utilization=total_max_payout/balance; available_withdrawal=min(limiter_available_now refilled to capacity, available_liquidity). total_supplied/withdrawn/net_deposits from DB supplied/withdrawn tables.
_src: C:/Users/tvoiv/Desktop/SuiOverflowVal/vendor/deepbookv3-predict/crates/predict-server/src/server.rs (VaultSummaryResponse 396-413, fetch_predict_snapshot 1130-1218)_

### route: GET /predicts/:predict_id/vault/performance
Query: range? (1D/1W/1M/3M/ALL). Returns VaultPerformanceResponse: {predict_id, range, points: [{timestamp_ms: i64, share_price: f64, vault_value: i64, total_shares: i64}]}. Points replay supply/withdraw events chronologically (share_price per event = |amount_delta|/|shares_delta|) and append a final live-snapshot point at now. CAVEAT: vault_value in points only accumulates deposits/withdrawals (ignores PnL between events); only the last (snapshot) point is true NAV.
_src: C:/Users/tvoiv/Desktop/SuiOverflowVal/vendor/deepbookv3-predict/crates/predict-server/src/server.rs (build_vault_performance_points 887-955)_

### route: GET /status
Query: max_checkpoint_lag (default 100), max_time_lag_seconds (default 60). Returns JSON: {status: "OK"|"UNHEALTHY", latest_onchain_checkpoint, current_time_ms, earliest_checkpoint, max_lag_pipeline, max_checkpoint_lag, max_time_lag_seconds, pipelines: [{pipeline, checkpoint_hi_inclusive, timestamp_ms_hi_inclusive, epoch_hi_inclusive, checkpoint_lag, time_lag_ms, time_lag_seconds, latest_onchain_checkpoint, is_backfill}]}. Pipelines named like 'oracle_prices_updated'; '@backfill' suffix excluded from health calc. Good freshness probe before trading.
_src: C:/Users/tvoiv/Desktop/SuiOverflowVal/vendor/deepbookv3-predict/crates/predict-server/src/server.rs (build_status_payload 632-703)_

### scaling factors
FLOAT_SCALING = 1e9 everywhere: prices/probabilities (1_000_000_000 = 100%/$1 full payout), SVI params, spot/forward, strikes, spreads, exposure pct. predict-server PREDICT_PRICE_SCALE: i64 = 1_000_000_000 used to compute average/mark prices = amount*1e9/quantity. Move constants (packages/predict/sources/helper/constants.move): float_scaling!()=1_000_000_000; binary prices bounded so up_ask=min(up_price+spread, 1e9), dn_bid=1e9-up_ask (perfect complement = no-arb identity to check). Default protocol bounds: max exposure 80%, base spread 2%, min spread 0.5%, util multiplier 2x, min ask 1%, max ask 99% (all in 1e9 scale).
_src: C:/Users/tvoiv/Desktop/SuiOverflowVal/vendor/deepbookv3-predict/packages/predict/sources/helper/constants.move_

### predict-schema tables (21)
oracle_activated, oracle_settled, oracle_prices_updated, oracle_svi_updated, predict_created, oracle_created, position_minted, position_redeemed, range_minted, range_redeemed, supplied, withdrawn, trading_pause_updated, pricing_config_updated, risk_config_updated, oracle_ask_bounds_set, oracle_ask_bounds_cleared, quote_asset_enabled, quote_asset_disabled, predict_manager_created, watermarks(pipeline PK, epoch_hi_inclusive, checkpoint_hi_inclusive, tx_hi, timestamp_ms_hi_inclusive). Every event table shares meta columns: event_digest TEXT PK (= tx digest + event_index concatenated), digest, sender, checkpoint Int8, timestamp Timestamp (DB-insert time, NOT serialized in API), checkpoint_timestamp_ms Int8, tx_index Int8, event_index Int8, package TEXT. Inserts are ON CONFLICT DO NOTHING (idempotent).
_src: C:/Users/tvoiv/Desktop/SuiOverflowVal/vendor/deepbookv3-predict/crates/predict-schema/src/schema.rs_

### indexer event mapping
predict-indexer consumes 20 Move event types via BCS from checkpoints, one concurrent pipeline per table. Module::Name → table: oracle::OracleActivated→oracle_activated, oracle::OracleSettled→oracle_settled, oracle::OraclePricesUpdated→oracle_prices_updated, oracle::OracleSVIUpdated→oracle_svi_updated, registry::PredictCreated→predict_created, registry::OracleCreated→oracle_created, predict::PositionMinted→position_minted, predict::PositionRedeemed→position_redeemed, predict::RangeMinted→range_minted, predict::RangeRedeemed→range_redeemed, predict::TradingPauseUpdated, predict::PricingConfigUpdated, predict::RiskConfigUpdated, predict::OracleAskBoundsSet, predict::OracleAskBoundsCleared, predict::QuoteAssetEnabled, predict::QuoteAssetDisabled, predict::Supplied→supplied, predict::Withdrawn→withdrawn, predict_manager::PredictManagerCreated→predict_manager_created. SVI event: OracleSVIUpdated{oracle_id, a: u64, b: u64, rho: I64{magnitude,is_negative}, m: I64, sigma: u64, timestamp}.
_src: C:/Users/tvoiv/Desktop/SuiOverflowVal/vendor/deepbookv3-predict/crates/predict-indexer/src/models.rs + handlers.rs_

### indexer tx filter + testnet package
is_predict_tx accepts a tx if (a) any input object's type address is a configured predict package, (b) any event's type address matches, or (c) any MoveCall targets a configured package id. Testnet package (hardcoded default): 0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138 — use this for PTB targets too. OracleCreated rows get predict_id from the Predict shared object in tx inputs (fallback "0x0").
_src: C:/Users/tvoiv/Desktop/SuiOverflowVal/vendor/deepbookv3-predict/crates/predict-indexer/src/lib.rs (TESTNET_PREDICT_PACKAGES) + handlers.rs is_predict_tx_

### PTB market key encoding (for mint/redeem bot)
Server's own dev_inspect calls show the MarketKey BCS layout: struct {oracle_id: ObjectID, expiry: u64, strike: u64, direction: u8} with direction 0 = up, 1 = down (is_up→0). Mark/quote function: predict::get_trade_amounts(predict: &Predict shared imm, oracle: &Oracle shared imm, key: MarketKey pure, quantity: u64 pure, clock: &Clock 0x6 imm) — return value index 1 = redeem payout (u64). Manager balance: predict_manager::balance<QuoteAsset>(manager shared imm) → u64. Clock object 0x6 with initial_shared_version 1, immutable.
_src: C:/Users/tvoiv/Desktop/SuiOverflowVal/vendor/deepbookv3-predict/crates/predict-server/src/server.rs (MarketKeyCallArg 469-475, quote_position_marks)_

### pagination model
No cursor/offset pagination anywhere. Per-route ?limit= (default 100 via default_limit, NO upper cap — you can ask for limit=100000). Lists return newest-first by (checkpoint, tx_index, event_index) DESC except oracle prices/SVI which order by checkpoint_timestamp_ms DESC. Time-window filtering exists ONLY on /oracles/:id/prices (start_time/end_time on checkpoint_timestamp_ms). For full history of e.g. SVI you must use a big limit; for prices use start_time/end_time windows. /managers and the per-predict LP queries are unbounded; manager /positions and /ranges capped at 1000.
_src: C:/Users/tvoiv/Desktop/SuiOverflowVal/vendor/deepbookv3-predict/crates/predict-server/src/server.rs (PaginationParams 222-265, default_limit 479-481)_

### error format
Errors are PLAIN TEXT bodies, not JSON: 404 with 'Resource not found: {resource}', 500 with 'Database error: …' or 'Internal error: …'. Frontend must not assume JSON error envelopes. /oracles/:id/prices/latest and /svi/latest 404 when the oracle has no rows; /oracles/:id/state 404 only when oracle_created is missing.
_src: C:/Users/tvoiv/Desktop/SuiOverflowVal/vendor/deepbookv3-predict/crates/predict-server/src/error.rs_

### DB indexes relevant to polling
API-serving indexes exist for: oracle_created(predict_id, event order), oracle_prices_updated(oracle_id, checkpoint_timestamp_ms DESC,...), oracle_svi_updated(oracle_id, checkpoint_timestamp_ms DESC,...), position_minted/redeemed(manager_id, oracle_id, expiry, strike, is_up, event order), supplied/withdrawn(predict_id, time ASC), quote_asset_enabled/disabled(predict_id, event order). Queries filtered by trader/owner/supplier alone are unindexed full scans.
_src: C:/Users/tvoiv/Desktop/SuiOverflowVal/vendor/deepbookv3-predict/crates/predict-schema/migrations/2026-04-16-235000_oracle_predict_scope_and_api_indexes/up.sql_

### endpoints needing live RPC (latency caveat)
These hit the Sui fullnode (object fetch + dev_inspect) on every request, so they're slower and can fail with 500 if RPC flakes: /managers/:id/summary, /managers/:id/positions/summary, /managers/:id/pnl (uses position summaries), /predicts/:id/vault/summary, /predicts/:id/vault/performance, /status (latest checkpoint). Pure-DB fast endpoints: oracles/prices/svi/state/ask-bounds, positions, ranges, trades, lp, managers list, quote-assets, predict state, config.
_src: C:/Users/tvoiv/Desktop/SuiOverflowVal/vendor/deepbookv3-predict/crates/predict-server/src/server.rs_

### public deployment
Public indexer base URL (per task/team knowledge): https://predict-server.testnet.mystenlabs.com — GET /oracles confirmed working there; all routes in this map are served by the same binary (predict-server) so should be available, modulo deployed version. The /metrics Prometheus endpoint is on a separate port (9184) and not part of the HTTP API router.
_src: C:/Users/tvoiv/Desktop/SuiOverflowVal/vendor/deepbookv3-predict/crates/predict-server/src/server.rs run_server_

## Gotchas
- No websocket/SSE — poll. CORS is fully open (Any origin) but only GET/OPTIONS; you cannot proxy writes through this server.
- No cursor pagination and no max limit cap: SVI/positions history beyond 100 rows requires a large ?limit=; only /oracles/:id/prices supports time-window (start_time/end_time in ms on checkpoint_timestamp_ms, inclusive both ends).
- SVI rho and m are sign-magnitude (rho + rho_negative, m + m_negative), NOT two's-complement; all SVI params and prices are fixed-point 1e9 (FLOAT_SCALING). Forgetting the sign flags will silently corrupt the vol surface.
- On GET /positions/redeemed the ?trader= query param actually filters the `owner` column (PositionRedeemedRow has owner/executor, no trader field); on /ranges/redeemed it filters `trader`.
- Error responses are plain text strings (404 'Resource not found: ...', 500 'Internal error: ...'), not JSON — handle non-JSON bodies in the frontend fetch layer.
- /oracles/:id/prices/latest and /svi/latest return 404 (not empty/null) when the oracle has no data yet; /oracles/:id/ask-bounds returns JSON null when bounds were cleared or never set.
- Vault endpoints (/predicts/:id/vault/*) and manager summary/pnl endpoints do live fullnode object fetches + dev_inspect per request — they are slow and can 500 on RPC hiccups; don't poll them at high frequency. /trades and oracle/positions endpoints are pure-DB and cheap.
- vault/performance points' vault_value is deposits-minus-withdrawals replay only (no interim PnL); only the appended final snapshot point reflects true NAV — don't chart it as historical NAV.
- GET /trades/:oracle_id only interleaves position mints/redeems; range mints/redeems are excluded — fetch /ranges/minted?oracle_id= separately for ladder fills.
- Mint/redeem PTBs: MarketKey BCS = {oracle_id: ObjectID, expiry: u64, strike: u64, direction: u8} with direction 0=UP, 1=DOWN; testnet package 0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138; Clock = 0x6 shared immutable.
- Check GET /status (max_checkpoint_lag/max_time_lag_seconds params) before trading off indexed data — pipelines can lag the chain; '@backfill' pipelines are excluded from its health verdict.
- All u64 on-chain values are stored/served as i64 — fine for testnet magnitudes but JSON numbers near 2^53 would lose precision in JS; parse with BigInt-safe handling if strikes/amounts get large.