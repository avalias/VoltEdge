// VoltEdge — on-chain fair-price attestor.
//
// Independently re-derives the DeepBook Predict binary UP price N(d2) for an
// (oracle, strike) directly from the live on-chain SVI, using the PROTOCOL'S
// OWN public math primitives (`deepbook_predict::math::{ln,sqrt,normal_cdf}`,
// `deepbook::math::{div,mul}`, `deepbook_predict::i64`). It is the on-chain
// twin of @voltedge/core `fixedpoint.ts::computeNd2Fixed`, and an op-for-op
// transcription of the protocol's PRIVATE `oracle::compute_nd2` — so the
// emitted price is the chain's own price, re-derived with the chain's own
// functions. Pure read; never mutates protocol state.
module voltedge_attestor::attestor;

use deepbook::math;
use deepbook_predict::i64::{Self, I64};
use deepbook_predict::math as predict_math;
use deepbook_predict::oracle::{Self, OracleSVI, SVIParams};
use sui::event;

/// FLOAT_SCALING — 1e9 fixed-point, identical to
/// `deepbook_predict::constants::float_scaling!()` (used as the sqrt precision).
const FLOAT_SCALING: u64 = 1_000_000_000;

const CHECKER_VERSION: u16 = 1;

// Mirror the preconditions (and abort codes) of `oracle::compute_nd2`.
const EZeroForward: u64 = 3;
const ECannotBeNegative: u64 = 4;
const EZeroVariance: u64 = 5;

/// Emitted when this module independently re-derives the binary UP price
/// N(d2) for (oracle, strike) from the live on-chain SVI. The permanent,
/// auditable on-chain record that VoltEdge's analytics reproduce the
/// protocol's integer pricing pipeline exactly.
public struct FairPriceAttested has copy, drop {
    oracle_id: ID,
    strike: u64, // 1e9 fixed
    forward: u64, // 1e9 fixed
    fair_up: u64, // N(d2), 1e9 fixed — recomputed here, on-chain
    checker_version: u16,
}

/// Re-derive N(d2) for `strike` from the oracle's live SVI and emit it.
/// Composable (returns nothing, takes a shared `&OracleSVI`): call it in a PTB
/// right after the off-chain Proof tab shows N/N at 0 units.
public fun attest_fair_price(oracle: &OracleSVI, strike: u64) {
    let fair_up = compute_nd2_oracle(oracle, strike);
    event::emit(FairPriceAttested {
        oracle_id: oracle.id(),
        strike,
        forward: oracle.forward_price(),
        fair_up,
        checker_version: CHECKER_VERSION,
    });
}

/// Read-only form for devInspect / cross-language difftests: the re-derived
/// N(d2) without emitting an event. This is the value the off-chain mirror
/// (`computeNd2Fixed`) must match to the unit.
public fun fair_up(oracle: &OracleSVI, strike: u64): u64 {
    compute_nd2_oracle(oracle, strike)
}

/// Pure form over raw SVI params (no oracle object) — the unit-testable core.
/// `a,b,sigma` are u64 (1e9); `rho,m` are signed `I64` (sign-magnitude).
public fun nd2_from_params(
    a: u64,
    b: u64,
    rho: I64,
    m: I64,
    sigma: u64,
    forward: u64,
    strike: u64,
): u64 {
    assert!(forward > 0, EZeroForward);

    // k = ln(strike / forward)
    let k = predict_math::ln(math::div(strike, forward));
    let k_minus_m = i64::sub(&k, &m);
    let k_minus_m_squared = i64::square_scaled(&k_minus_m);
    let sigma_squared = math::mul(sigma, sigma);
    let sq = predict_math::sqrt(k_minus_m_squared + sigma_squared, FLOAT_SCALING);
    let sq_i64 = i64::from_u64(sq);

    // w(k) = a + b * (rho * (k - m) + sqrt((k - m)^2 + sigma^2))
    let rho_km = i64::mul_scaled(&rho, &k_minus_m);
    let inner = i64::add(&rho_km, &sq_i64);
    assert!(!i64::is_negative(&inner), ECannotBeNegative);
    let total_var = a + math::mul(b, i64::magnitude(&inner));
    assert!(total_var > 0, EZeroVariance);

    // d2 = -((k + total_var/2) / sqrt(total_var)); return N(d2).
    let sqrt_var = predict_math::sqrt(total_var, FLOAT_SCALING);
    let sqrt_var_i64 = i64::from_u64(sqrt_var);
    let half_var_i64 = i64::from_u64(total_var / 2);
    let d2_numerator = i64::add(&k, &half_var_i64);
    let d2 = i64::div_scaled(&d2_numerator, &sqrt_var_i64);
    let d2 = i64::neg(&d2);

    predict_math::normal_cdf(&d2)
}

/// Read the oracle's getters and feed the pure core.
fun compute_nd2_oracle(oracle: &OracleSVI, strike: u64): u64 {
    let svi: SVIParams = oracle.svi();
    nd2_from_params(
        svi.svi_a(),
        svi.svi_b(),
        svi.svi_rho(),
        svi.svi_m(),
        svi.svi_sigma(),
        oracle.forward_price(),
        strike,
    )
}

// === On-chain no-arbitrage: Gatheral g(k) ===
//
// g(k) = (1 - k*w'/(2w))^2 - (w'^2/4)*(1/w + 1/4) + w''/2
//
// The risk-neutral density is proportional to g(k); g(k) < 0 means the live
// SVI slice admits static (butterfly) arbitrage at log-moneyness k. The
// protocol stores SVI params but never computes g on-chain — this is
// VoltEdge's no-arb watchdog, anchored on-chain, an op-for-op transcription of
// @voltedge/core `fixedpoint.ts::gFunctionFixed` over the protocol's own math.

const EZeroGVariance: u64 = 6;
// Degenerate slice: a derivative denominator (sqrt(s) or s^1.5) is zero, i.e.
// sigma -> 0 with the strike at the money. Named here so the leaf division
// never leaks a raw VM div-by-zero (cf. the protocol's move.md guard rule).
const EDegenerateSlice: u64 = 7;
// Calendar attestation guards: the two oracles must share an underlying and be
// ordered near.expiry < far.expiry for the variance-monotonicity check to mean
// anything.
const ECrossUnderlying: u64 = 8;
const EExpiryOrder: u64 = 9;

/// Emitted when g(k) is computed on-chain for (oracle, strike). `g_negative`
/// true means the slice admits butterfly arbitrage at that strike — a
/// permanent, auditable on-chain record from VoltEdge's no-arb monitor.
public struct ArbitrageFlagged has copy, drop {
    oracle_id: ID,
    strike: u64, // 1e9 fixed
    k_magnitude: u64, // |ln(strike/forward)|, 1e9 fixed
    k_negative: bool,
    g_magnitude: u64, // |g(k)|, 1e9 fixed
    g_negative: bool, // true => butterfly arbitrage present
    checker_version: u16,
}

/// Compute g(k) for `strike` (k = ln(strike/forward)) from the live SVI and
/// emit ArbitrageFlagged with the sign. Composable in a PTB.
public fun attest_no_arb(oracle: &OracleSVI, strike: u64) {
    assert!(oracle.forward_price() > 0, EZeroForward);
    let k = predict_math::ln(math::div(strike, oracle.forward_price()));
    let g = g_for_strike(oracle, strike);
    event::emit(ArbitrageFlagged {
        oracle_id: oracle.id(),
        strike,
        k_magnitude: i64::magnitude(&k),
        k_negative: i64::is_negative(&k),
        g_magnitude: i64::magnitude(&g),
        g_negative: i64::is_negative(&g),
        checker_version: CHECKER_VERSION,
    });
}

/// Read-only g(k) for `strike` (no event) — the value the off-chain mirror
/// (`gFunctionFixed`) must match. For devInspect / cross-language difftests.
public fun g_for_strike(oracle: &OracleSVI, strike: u64): I64 {
    assert!(oracle.forward_price() > 0, EZeroForward);
    let k = predict_math::ln(math::div(strike, oracle.forward_price()));
    let svi: SVIParams = oracle.svi();
    g_from_params(svi.svi_a(), svi.svi_b(), svi.svi_rho(), svi.svi_m(), svi.svi_sigma(), k)
}

/// Pure core: Gatheral g(k) over raw SVI params and signed log-moneyness `k`.
/// Op-for-op mirror of `fixedpoint.ts::gFunctionFixed`.
public fun g_from_params(a: u64, b: u64, rho: I64, m: I64, sigma: u64, k: I64): I64 {
    let w = total_variance(a, b, rho, m, sigma, k);
    assert!(w > 0, EZeroGVariance);
    let w1 = total_variance_prime(b, rho, m, sigma, k);
    let w2 = total_variance_prime2(b, m, sigma, k);

    // term1 = 1 - k*w'/(2w)
    let k_w1 = i64::mul_scaled(&k, &w1);
    let two_w = i64::from_u64(2 * w);
    let k_w1_over_2w = i64::div_scaled(&k_w1, &two_w);
    let one = i64::from_u64(FLOAT_SCALING);
    let term1 = i64::sub(&one, &k_w1_over_2w);
    let term1_squared = i64::from_u64(i64::square_scaled(&term1));

    // term2 = (w'^2 / 4) * (1/w + 1/4)
    let w1_squared = i64::square_scaled(&w1);
    let recip_plus_quarter = math::div(FLOAT_SCALING, w) + FLOAT_SCALING / 4;
    let term2 = math::mul(w1_squared / 4, recip_plus_quarter);

    // term3 = w'' / 2
    let term3 = w2 / 2;

    let g = i64::sub(&term1_squared, &i64::from_u64(term2));
    i64::add(&g, &i64::from_u64(term3))
}

/// sqrt((k - m)^2 + sigma^2), reused across w, w', w''.
fun svi_root(m: I64, sigma: u64, k: I64): u64 {
    let km = i64::sub(&k, &m);
    let km_squared = i64::square_scaled(&km);
    let sigma_squared = math::mul(sigma, sigma);
    predict_math::sqrt(km_squared + sigma_squared, FLOAT_SCALING)
}

/// w(k) = a + b*(rho*(k-m) + sqrt((k-m)^2 + sigma^2)). Non-negative.
fun total_variance(a: u64, b: u64, rho: I64, m: I64, sigma: u64, k: I64): u64 {
    let km = i64::sub(&k, &m);
    let root = svi_root(m, sigma, k);
    let rho_km = i64::mul_scaled(&rho, &km);
    let inner = i64::add(&rho_km, &i64::from_u64(root));
    assert!(!i64::is_negative(&inner), ECannotBeNegative);
    a + math::mul(b, i64::magnitude(&inner))
}

/// w'(k) = b*(rho + (k-m)/sqrt((k-m)^2 + sigma^2)). Signed.
fun total_variance_prime(b: u64, rho: I64, m: I64, sigma: u64, k: I64): I64 {
    let km = i64::sub(&k, &m);
    let root = svi_root(m, sigma, k);
    assert!(root > 0, EDegenerateSlice);
    let km_over_root = i64::div_scaled(&km, &i64::from_u64(root));
    let inner = i64::add(&rho, &km_over_root);
    i64::mul_scaled(&i64::from_u64(b), &inner)
}

/// w''(k) = b*sigma^2 / (km^2 + sigma^2)^1.5. Non-negative.
fun total_variance_prime2(b: u64, m: I64, sigma: u64, k: I64): u64 {
    let km = i64::sub(&k, &m);
    let km_squared = i64::square_scaled(&km);
    let sigma_squared = math::mul(sigma, sigma);
    let s = km_squared + sigma_squared;
    let root = predict_math::sqrt(s, FLOAT_SCALING);
    let s_to_the_15 = math::mul(s, root);
    assert!(s_to_the_15 > 0, EDegenerateSlice);
    let numerator = math::mul(b, sigma_squared);
    math::div(numerator, s_to_the_15)
}

// === On-chain no-arbitrage: calendar monotonicity ===
//
// Total implied variance must be non-decreasing in expiry at every fixed
// log-moneyness: w_near(k) <= w_far(k) for T_near < T_far (driftless moneyness,
// fine for sub-hour BTC). w_near(k) > w_far(k) is a CALENDAR arbitrage — the
// second no-arb dimension, the sibling of the butterfly g(k) check. VoltEdge
// already catches this off-chain on the live feed (see FINDINGS); this anchors
// it on-chain too. Spread = w_near(k) - w_far(k); positive => arbitrage.

/// Emitted when the calendar (across-expiry) variance monotonicity is checked
/// on-chain for two same-underlying oracles. `arb` true means w_near > w_far at
/// the evaluated log-moneyness — a calendar arbitrage.
public struct CalendarArbFlagged has copy, drop {
    near_id: ID,
    far_id: ID,
    strike: u64, // 1e9 fixed; defines k = ln(strike / near_forward)
    k_magnitude: u64,
    k_negative: bool,
    w_near: u64, // total variance at k, near expiry (1e9 fixed)
    w_far: u64, // total variance at k, far expiry (1e9 fixed)
    spread_magnitude: u64, // |w_near - w_far|
    spread_negative: bool, // false & nonzero => calendar arbitrage
    arb: bool, // w_near > w_far
    checker_version: u16,
}

/// Compute the calendar spread for `strike` (k = ln(strike/near_forward)) and
/// emit CalendarArbFlagged with the sign. Composable in a PTB.
public fun attest_calendar(near: &OracleSVI, far: &OracleSVI, strike: u64) {
    let (k, w_near, w_far) = calendar_eval(near, far, strike);
    let spread = i64::sub(&i64::from_u64(w_near), &i64::from_u64(w_far));
    event::emit(CalendarArbFlagged {
        near_id: near.id(),
        far_id: far.id(),
        strike,
        k_magnitude: i64::magnitude(&k),
        k_negative: i64::is_negative(&k),
        w_near,
        w_far,
        spread_magnitude: i64::magnitude(&spread),
        spread_negative: i64::is_negative(&spread),
        arb: !i64::is_negative(&spread) && i64::magnitude(&spread) > 0,
        checker_version: CHECKER_VERSION,
    });
}

/// Read-only calendar spread w_near(k) - w_far(k) (no event) — the value the
/// off-chain mirror must match. For devInspect / cross-language difftests.
public fun calendar_spread(near: &OracleSVI, far: &OracleSVI, strike: u64): I64 {
    let (_, w_near, w_far) = calendar_eval(near, far, strike);
    i64::sub(&i64::from_u64(w_near), &i64::from_u64(w_far))
}

/// Pure core: w_near(k) - w_far(k) over two raw SVI param sets and a signed
/// log-moneyness `k`. Op-for-op mirror of `totalVarianceFixed(near,k) -
/// totalVarianceFixed(far,k)`.
public fun calendar_spread_from_params(
    a_near: u64,
    b_near: u64,
    rho_near: I64,
    m_near: I64,
    sigma_near: u64,
    a_far: u64,
    b_far: u64,
    rho_far: I64,
    m_far: I64,
    sigma_far: u64,
    k: I64,
): I64 {
    let w_near = total_variance(a_near, b_near, rho_near, m_near, sigma_near, k);
    let w_far = total_variance(a_far, b_far, rho_far, m_far, sigma_far, k);
    i64::sub(&i64::from_u64(w_near), &i64::from_u64(w_far))
}

/// Read both oracles, enforce same-underlying + near.expiry < far.expiry, and
/// return (k, w_near, w_far) at k = ln(strike / near_forward).
fun calendar_eval(near: &OracleSVI, far: &OracleSVI, strike: u64): (I64, u64, u64) {
    assert!(near.underlying_asset() == far.underlying_asset(), ECrossUnderlying);
    assert!(near.expiry() < far.expiry(), EExpiryOrder);
    assert!(near.forward_price() > 0, EZeroForward);
    let k = predict_math::ln(math::div(strike, near.forward_price()));
    let sn: SVIParams = near.svi();
    let sf: SVIParams = far.svi();
    let w_near = total_variance(sn.svi_a(), sn.svi_b(), sn.svi_rho(), sn.svi_m(), sn.svi_sigma(), k);
    let w_far = total_variance(sf.svi_a(), sf.svi_b(), sf.svi_rho(), sf.svi_m(), sf.svi_sigma(), k);
    (k, w_near, w_far)
}

#[test_only]
public fun checker_version(): u16 { CHECKER_VERSION }
