#[test_only]
module voltedge_attestor::attestor_tests;

use deepbook_predict::i64;
use deepbook_predict::math as predict_math;
use voltedge_attestor::attestor;

const F: u64 = 1_000_000_000;

// SVI params for a sane ATM-ish surface (a=0.01, b=0.1, sigma=0.2, rho=m=0).
const A: u64 = 10_000_000;
const B: u64 = 100_000_000;
const SIG: u64 = 200_000_000;

/// Protocol CDF anchor: Φ(0) = 0.5 exactly (500_000_000 at 1e9 scale).
#[test]
fun phi_zero_is_half() {
    assert!(predict_math::normal_cdf(&i64::zero()) == 500_000_000);
}

/// ATM (strike == forward, rho=m=0) ⇒ d2 < 0 ⇒ 0 < N(d2) < 0.5.
#[test]
fun atm_up_below_half() {
    let fwd = 64_000 * F;
    let up = attestor::nd2_from_params(A, B, i64::zero(), i64::zero(), SIG, fwd, fwd);
    assert!(up > 0);
    assert!(up < 500_000_000);
}

/// Binary UP price N(d2) is non-increasing in strike.
#[test]
fun up_decreases_in_strike() {
    let fwd = 64_000 * F;
    let lo = attestor::nd2_from_params(A, B, i64::zero(), i64::zero(), SIG, fwd, 63_000 * F);
    let hi = attestor::nd2_from_params(A, B, i64::zero(), i64::zero(), SIG, fwd, 65_000 * F);
    assert!(hi <= lo);
}

/// Zero forward aborts with the mirrored EZeroForward code.
#[test, expected_failure(abort_code = voltedge_attestor::attestor::EZeroForward)]
fun zero_forward_aborts() {
    attestor::nd2_from_params(A, B, i64::zero(), i64::zero(), SIG, 0, 64_000 * F);
    abort 999
}

#[test]
fun checker_version_is_one() {
    assert!(attestor::checker_version() == 1);
}

/// A sane ATM surface has a strictly positive butterfly density: g(0) > 0.
#[test]
fun g_positive_on_sane_atm() {
    let g = attestor::g_from_params(A, B, i64::zero(), i64::zero(), SIG, i64::zero());
    assert!(!i64::is_negative(&g));
    assert!(i64::magnitude(&g) > 0);
}

/// A steep-wing slice (large b, extreme rho) admits butterfly arbitrage:
/// g(k) < 0 somewhere on the wing. Mirror of the TS arb-sign test; the
/// on-chain core must SEE the arb, not just the off-chain mirror.
#[test]
fun g_flags_butterfly_arb() {
    let a = 10_000; // 1e-5
    let b = 20_000_000; // 0.02
    let rho = i64::neg(&i64::from_u64(920_000_000)); // -0.92
    let m = i64::zero();
    let sigma = 4_000_000; // 0.004
    let ks = vector[20_000_000, 40_000_000, 60_000_000, 80_000_000, 100_000_000];
    let mut found = false;
    let mut idx = 0;
    while (idx < ks.length()) {
        let kmag = ks[idx];
        let kp = i64::from_u64(kmag);
        let kn = i64::neg(&i64::from_u64(kmag));
        if (i64::is_negative(&attestor::g_from_params(a, b, rho, m, sigma, kp))) found = true;
        if (i64::is_negative(&attestor::g_from_params(a, b, rho, m, sigma, kn))) found = true;
        idx = idx + 1;
    };
    assert!(found);
}

/// Zero variance in g aborts with the dedicated guard (a=b=0 ⇒ w=0).
#[test, expected_failure(abort_code = voltedge_attestor::attestor::EZeroGVariance)]
fun g_zero_variance_aborts() {
    attestor::g_from_params(0, 0, i64::zero(), i64::zero(), SIG, i64::zero());
    abort 999
}
