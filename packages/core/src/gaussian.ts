/**
 * Standard normal distribution primitives in full double precision.
 *
 * normCdf uses Cody's rational-approximation algorithm for erf/erfc
 * (W. J. Cody, "Rational Chebyshev approximation for the error function",
 * Math. Comp. 23 (1969)) — max relative error below 1e-15 across the
 * whole real line, which is what production option pricers use.
 * We validate against scipy.stats.norm golden vectors in tests.
 */

const SQRT2 = Math.SQRT2;
const INV_SQRT_2PI = 0.3989422804014326779399461;

/** Standard normal probability density. */
export function normPdf(x: number): number {
  return INV_SQRT_2PI * Math.exp(-0.5 * x * x);
}

// --- Cody erf/erfc ---------------------------------------------------------

// Coefficients for erf(x), |x| <= 0.46875
const A = [
  3.16112374387056560e0, 1.13864154151050156e2, 3.77485237685302021e2,
  3.20937758913846947e3, 1.85777706184603153e-1,
];
const B = [
  2.36012909523441209e1, 2.44024637934444173e2, 1.28261652607737228e3,
  2.84423683343917062e3,
];

// Coefficients for erfc(x), 0.46875 < x <= 4
const C = [
  5.64188496988670089e-1, 8.88314979438837594e0, 6.61191906371416295e1,
  2.98635138197400131e2, 8.81952221241769090e2, 1.71204761263407058e3,
  2.05107837782607147e3, 1.23033935479799725e3, 2.15311535474403846e-8,
];
const D = [
  1.57449261107098347e1, 1.17693950891312499e2, 5.37181101862009858e2,
  1.62138957456669019e3, 3.29079923573345963e3, 4.36261909014324716e3,
  3.43936767414372164e3, 1.23033935480374942e3,
];

// Coefficients for erfc(x), x > 4
const P = [
  3.05326634961232344e-1, 3.60344899949804439e-1, 1.25781726111229246e-1,
  1.60837851487422766e-2, 6.58749161529837803e-4, 1.63153871373020978e-2,
];
const Q = [
  2.56852019228982242e0, 1.87295284992346047e0, 5.27905102951428412e-1,
  6.05183413124413191e-2, 2.33520497626869185e-3,
];

function erfCore(x: number): number {
  // erf for |x| <= 0.46875
  const z = x * x;
  let num = A[4]! * z;
  let den = z;
  for (let i = 0; i < 3; i++) {
    num = (num + A[i]!) * z;
    den = (den + B[i]!) * z;
  }
  return (x * (num + A[3]!)) / (den + B[3]!);
}

function erfcMid(x: number): number {
  // erfc for 0.46875 < x <= 4
  let num = C[8]! * x;
  let den = x;
  for (let i = 0; i < 7; i++) {
    num = (num + C[i]!) * x;
    den = (den + D[i]!) * x;
  }
  const r = (num + C[7]!) / (den + D[7]!);
  const z = Math.trunc(x * 16) / 16;
  return Math.exp(-z * z) * Math.exp(-(x - z) * (x + z)) * r;
}

function erfcFar(x: number): number {
  // erfc for x > 4
  const z = 1 / (x * x);
  let num = P[5]! * z;
  let den = z;
  for (let i = 0; i < 4; i++) {
    num = (num + P[i]!) * z;
    den = (den + Q[i]!) * z;
  }
  let r = (z * (num + P[4]!)) / (den + Q[4]!);
  // Cody/CALERF: erfc(x) = exp(-x^2)/x * (1/sqrt(pi) - z*R(z)), 1/sqrt(pi) below
  r = (5.6418958354775628695e-1 - r) / x;
  const zz = Math.trunc(x * 16) / 16;
  return Math.exp(-zz * zz) * Math.exp(-(x - zz) * (x + zz)) * r;
}

/** Error function, |error| < 1e-15 relative. */
export function erf(x: number): number {
  const ax = Math.abs(x);
  if (ax <= 0.46875) return erfCore(x);
  let v: number;
  if (ax <= 4) v = erfcMid(ax);
  else v = ax < 26.5 ? erfcFar(ax) : 0;
  return x > 0 ? 1 - v : v - 1;
}

/** Complementary error function. */
export function erfc(x: number): number {
  const ax = Math.abs(x);
  if (ax <= 0.46875) return 1 - erfCore(x);
  const v = ax <= 4 ? erfcMid(ax) : ax < 26.5 ? erfcFar(ax) : 0;
  return x > 0 ? v : 2 - v;
}

/** Standard normal CDF: P(Z <= x). */
export function normCdf(x: number): number {
  return 0.5 * erfc(-x / SQRT2);
}

/**
 * Inverse standard normal CDF (Acklam's algorithm, refined with one
 * Halley step against normCdf — ~1e-15 accuracy). Used for quantile
 * bands in Monte-Carlo risk fan charts.
 */
export function normInv(p: number): number {
  if (!(p > 0 && p < 1)) {
    if (p === 0) return -Infinity;
    if (p === 1) return Infinity;
    return NaN;
  }
  // Acklam coefficients
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.383577518672690e2, -3.066479806614716e1, 2.506628277459239e0,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0,
    -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0,
    3.754408661907416e0,
  ];
  const pLow = 0.02425;
  let x: number;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x =
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  } else if (p <= 1 - pLow) {
    const q = p - 0.5;
    const r = q * q;
    x =
      ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
      (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x =
      -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  // One Halley refinement step
  const e = normCdf(x) - p;
  const u = e / normPdf(x);
  x = x - u / (1 + (x * u) / 2);
  return x;
}
