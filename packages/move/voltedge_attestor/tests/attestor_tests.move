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
