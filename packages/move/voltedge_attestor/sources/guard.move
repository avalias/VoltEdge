// VoltEdge — on-chain slippage guard for DeepBook Predict.
//
// The protocol's `mint` / `mint_range` charge the CURRENT (post-trade) price
// with NO cost ceiling: an adverse SVI move between an off-chain signal and
// on-chain execution fills at whatever the surface implies (bounded only by the
// protocol's [1%, 99%] ask clamp). That is a real money-safety gap for any
// automated trader.
//
// `safe_mint` composes the protocol's OWN quote and mint ATOMICALLY: it reads
// `get_trade_amounts` in the SAME transaction — the exact SVI snapshot the mint
// will use, one block, no re-quote — asserts the cost is within the caller's
// `max_cost`, and only then mints. One tx, no snapshot race, no fill past
// `max_cost`. A drop-in safety wrapper the manager owner calls instead of
// `predict::mint` (ctx.sender() is preserved, so the owner-gate still holds).
module voltedge_attestor::guard;

use deepbook_predict::market_key::MarketKey;
use deepbook_predict::oracle::OracleSVI;
use deepbook_predict::predict::Predict;
use deepbook_predict::predict_manager::PredictManager;
use deepbook_predict::range_key::RangeKey;
use sui::clock::Clock;

/// Live cost exceeded the caller's `max_cost` — the SVI moved against us between
/// the off-chain signal and execution. Abort rather than overpay.
const ESlippage: u64 = 0;

/// Mint `quantity` of a binary leg only if its live cost ≤ `max_cost`.
public fun safe_mint<Quote>(
    predict: &mut Predict,
    manager: &mut PredictManager,
    oracle: &OracleSVI,
    key: MarketKey,
    quantity: u64,
    max_cost: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let (cost, _payout) = predict.get_trade_amounts(oracle, key, quantity, clock);
    assert!(cost <= max_cost, ESlippage);
    predict.mint<Quote>(manager, oracle, key, quantity, clock, ctx);
}

/// Mint `quantity` of a vertical range leg only if its live cost ≤ `max_cost`.
public fun safe_mint_range<Quote>(
    predict: &mut Predict,
    manager: &mut PredictManager,
    oracle: &OracleSVI,
    key: RangeKey,
    quantity: u64,
    max_cost: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let (cost, _payout) = predict.get_range_trade_amounts(oracle, key, quantity, clock);
    assert!(cost <= max_cost, ESlippage);
    predict.mint_range<Quote>(manager, oracle, key, quantity, clock, ctx);
}

/// Read-only live mint cost for a binary leg (for devInspect / UI preview, so a
/// caller can set a sane `max_cost`). The cost leg of `get_trade_amounts`.
public fun quote_mint_cost(
    predict: &Predict,
    oracle: &OracleSVI,
    key: MarketKey,
    quantity: u64,
    clock: &Clock,
): u64 {
    let (cost, _payout) = predict.get_trade_amounts(oracle, key, quantity, clock);
    cost
}

/// Read-only live mint cost for a range leg.
public fun quote_range_mint_cost(
    predict: &Predict,
    oracle: &OracleSVI,
    key: RangeKey,
    quantity: u64,
    clock: &Clock,
): u64 {
    let (cost, _payout) = predict.get_range_trade_amounts(oracle, key, quantity, clock);
    cost
}
