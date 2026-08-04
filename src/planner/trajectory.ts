/**
 * Health-factor trajectory projection.
 *
 * Fits a least-squares line to the most recent HF samples (exact bigint
 * arithmetic — HF values are 1e18-scaled and slopes can be tiny negatives, so
 * we keep the slope as a rational num/den instead of truncating early):
 *
 *   slope = (n·Σty − Σt·Σy) / (n·Σt² − (Σt)²)          [HF-1e18 units / second]
 *
 * with t in whole seconds relative to the first fitted sample (keeps the
 * products small) and y the 1e18 HF (clamped at HF_CAP so a "no debt"
 * type(uint256).max sample cannot poison the fit).
 *
 *   projected             = current + slope · horizonSeconds   (clamped ≥ 0)
 *   secondsToLiquidation  = (current − 1e18) / (−slope)        (Infinity if slope ≥ 0)
 *
 * BigInt division truncates toward zero; by dividing (current−1e18)·den by
 * (−num) in one step we avoid losing the sub-unit slope precision.
 */

import type { AccountHealth, HfTrajectory } from "../types.js";

const WAD = 10n ** 18n;
const MAX_UINT256 = (1n << 256n) - 1n;
/** HF values above this (e.g. type(uint256).max for a debt-free account) are clamped for the fit. */
const HF_CAP = 100n * WAD;
/** Fit at most this many of the most recent samples. */
const MAX_FIT_SAMPLES = 20;

export interface HfSample {
  /** Unix epoch **milliseconds** (Date.now()). */
  ts: number;
  health: AccountHealth;
}

/**
 * Project the HF `horizonSeconds` ahead from a linear drift fit of the last
 * `MAX_FIT_SAMPLES` samples. Samples may be passed in any order; `ts` must be
 * epoch milliseconds.
 */
export function projectHf(samples: HfSample[], horizonSeconds: number): HfTrajectory {
  if (samples.length === 0) throw new Error("projectHf: need at least one sample");
  if (!Number.isFinite(horizonSeconds) || horizonSeconds < 0) {
    throw new Error("projectHf: horizonSeconds must be a non-negative finite number");
  }

  const ordered = [...samples].sort((a, b) => a.ts - b.ts);
  const fitted = ordered.slice(-MAX_FIT_SAMPLES);
  const current = fitted[fitted.length - 1]!.health.healthFactor;

  const flat: HfTrajectory = {
    current,
    projected: current,
    horizonSeconds,
    secondsToLiquidation: Number.POSITIVE_INFINITY,
  };

  // Debt-free (HF = uint256 max) → nothing can liquidate; no meaningful drift.
  if (current === MAX_UINT256) return flat;
  if (fitted.length < 2) return flat;

  // Least-squares sums over (tSeconds relative to first sample, hf clamped).
  const t0 = fitted[0]!.ts;
  let n = 0n;
  let sumT = 0n;
  let sumY = 0n;
  let sumTY = 0n;
  let sumTT = 0n;
  for (const s of fitted) {
    const t = BigInt(Math.round((s.ts - t0) / 1000)); // whole seconds
    const y = s.health.healthFactor > HF_CAP ? HF_CAP : s.health.healthFactor;
    n += 1n;
    sumT += t;
    sumY += y;
    sumTY += t * y;
    sumTT += t * t;
  }

  const num = n * sumTY - sumT * sumY; // slope numerator   (1e18-HF · s)
  const den = n * sumTT - sumT * sumT; // slope denominator (s²), ≥ 0
  if (den === 0n) return flat; // all samples at the same second — no drift signal

  // Projected HF at the horizon, floor-truncated, clamped at 0.
  let projected = current + (num * BigInt(Math.round(horizonSeconds))) / den;
  if (projected < 0n) projected = 0n;

  // Seconds until HF crosses 1.0 at this drift.
  let secondsToLiquidation: number;
  if (num >= 0n) {
    secondsToLiquidation = Number.POSITIVE_INFINITY; // non-decreasing
  } else if (current <= WAD) {
    secondsToLiquidation = 0; // already at/below liquidation
  } else {
    secondsToLiquidation = Number(((current - WAD) * den) / -num);
  }

  return { current, projected, horizonSeconds, secondsToLiquidation };
}
