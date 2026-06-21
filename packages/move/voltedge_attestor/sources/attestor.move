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

#[test_only]
public fun checker_version(): u16 { CHECKER_VERSION }
