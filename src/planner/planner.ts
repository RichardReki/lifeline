/**
 * LIFELINE rescue planner — pure bigint math, no I/O, no side effects.
 *
 * ── Aave v3 health-factor math (all "base" values are 8-decimal USD, HF is 1e18) ──
 *
 *   HF = totalCollateralBase · liquidationThreshold(bps) · 1e18
 *        ─────────────────────────────────────────────────────────
 *                    totalDebtBase · 10_000
 *
 * To restore HF to `targetHf` we can either shrink the denominator (repay debt)
 * or grow the numerator (supply collateral):
 *
 *  REPAY  — solve for debtAfter at targetHf:
 *      debtAfter  = totalCollateralBase · LT · 1e18 / (targetHf · 10_000)   (floor ⇒ HF ≥ target)
 *      repayBase  = totalDebtBase − debtAfter
 *
 *  SUPPLY — solve for collateralAfter at targetHf:
 *      collateralAfter  = targetHf · totalDebtBase · 10_000 / (LT · 1e18)   (ceil ⇒ HF ≥ target)
 *      collateralNeeded = collateralAfter − totalCollateralBase
 *
 * Base→token conversion uses the Aave oracle price (8-dec USD per WHOLE token):
 *      amountRaw = ceil( baseNeeded · 1.01 · 10^decimals / priceBase )
 * The 1% margin absorbs interest accrual and price drift between planning and
 * execution; Aave `repay` caps at the actual debt so overshooting is safe.
 *
 * `costBase` is the USD (8-dec) value of the *discretized, margined* token
 * amount actually spent — i.e. amountRaw · priceBase / 10^decimals. The plans
 * are compared on costBase. Repay is generically the capital-efficient option
 * (collateral only counts LT-weighted, so collateralNeeded = repayBase·target/LT
 * > repayBase), but token granularity can flip the choice: a chunky, expensive,
 * low-decimals debt asset can make the smallest repay unit cost more USD than
 * the fine-grained supply — the comparison is done on real spend, so the
 * planner picks whichever rescue is genuinely cheaper.
 */

import type { AccountHealth, RescuePlan, RescueKind } from "../types.js";

export const WAD = 10n ** 18n; // 1e18, HF scale
export const BPS = 10_000n; // basis-point denominator
export const MAX_UINT256 = (1n << 256n) - 1n; // Aave HF when there is no debt

/** Thrown when the account needs no rescue (no debt, or HF already ≥ target). */
export class PlanNotNeeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanNotNeeded";
  }
}

export interface MarketAsset {
  address: `0x${string}`;
  symbol: string;
  decimals: number;
  /** Aave oracle price: 8-dec USD per whole token. */
  priceBase: bigint;
}

export interface RescueMarket {
  /** Asset we would repay (the account's debt asset). */
  debtAsset: MarketAsset;
  /** Asset we would supply as extra collateral. */
  collateralAsset: MarketAsset;
  /** HF the rescue must restore, 1e18-scaled (e.g. 1.5e18). */
  targetHf: bigint;
}

/** ceil(a / b) for non-negative bigints. */
function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/** HF (1e18) of a hypothetical position; MAX_UINT256 when debt is zero (Aave convention). */
export function hfOf(collateralBase: bigint, debtBase: bigint, liqThresholdBps: bigint): bigint {
  if (debtBase === 0n) return MAX_UINT256;
  return (collateralBase * liqThresholdBps * WAD) / (debtBase * BPS);
}

/**
 * Exact base-USD (8-dec) debt reduction that restores `targetHf`.
 * debtAfter is floored, so repaying this amount yields HF ≥ targetHf.
 */
export function repayBaseToTarget(health: AccountHealth, targetHf: bigint): bigint {
  const debtAfter =
    (health.totalCollateralBase * health.currentLiquidationThreshold * WAD) / (targetHf * BPS);
  return health.totalDebtBase > debtAfter ? health.totalDebtBase - debtAfter : 0n;
}

/**
 * Exact base-USD (8-dec) collateral addition that restores `targetHf`.
 * collateralAfter is ceiled, so supplying this amount yields HF ≥ targetHf.
 */
export function supplyBaseToTarget(health: AccountHealth, targetHf: bigint): bigint {
  const collateralAfter = ceilDiv(
    targetHf * health.totalDebtBase * BPS,
    health.currentLiquidationThreshold * WAD,
  );
  return collateralAfter > health.totalCollateralBase
    ? collateralAfter - health.totalCollateralBase
    : 0n;
}

interface Candidate {
  kind: RescueKind;
  asset: MarketAsset;
  /** Exact base USD needed (no margin) — the theoretical restore point. */
  baseNeeded: bigint;
  /** Raw token amount: baseNeeded ·1.01, ceil-rounded to a raw token unit. */
  amount: bigint;
  /** USD 8-dec actually spent for `amount` (margin + granularity included). */
  costBase: bigint;
}

/** Convert an exact base need into a margined, discretized token amount + real cost. */
function buildCandidate(kind: RescueKind, baseNeeded: bigint, asset: MarketAsset): Candidate {
  if (asset.priceBase <= 0n) {
    throw new Error(`planner: ${asset.symbol} priceBase must be positive`);
  }
  if (!Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 36) {
    throw new Error(`planner: ${asset.symbol} decimals out of range`);
  }
  const unit = 10n ** BigInt(asset.decimals);
  // 1% safety margin, then round UP to a raw token unit so we never undershoot.
  const amount = ceilDiv(baseNeeded * 101n * unit, 100n * asset.priceBase);
  // Real USD spend of that discretized amount (floor: value of whole raw units).
  const costBase = (amount * asset.priceBase) / unit;
  return { kind, asset, baseNeeded, amount, costBase };
}

const fmtHf = (hf: bigint): string =>
  hf === MAX_UINT256 ? "∞" : (Number(hf / 10n ** 12n) / 1e6).toFixed(3);
const fmtUsd = (base: bigint): string => `$${(Number(base) / 1e8).toFixed(2)}`;
const fmtToken = (amount: bigint, asset: MarketAsset): string =>
  `${(Number(amount) / 10 ** asset.decimals).toFixed(Math.min(asset.decimals, 6))} ${asset.symbol}`;

/**
 * Compute the minimal rescue that restores `market.targetHf`.
 *
 * @throws PlanNotNeeded when the account has no debt or HF is already ≥ target.
 */
export function planRescue(
  health: AccountHealth,
  market: { debtAsset: MarketAsset; collateralAsset: MarketAsset; targetHf: bigint },
): RescuePlan {
  const { targetHf } = market;
  if (targetHf <= WAD) throw new Error("planner: targetHf must be > 1.0 (1e18)");

  // Edge: no debt → HF is type(uint256).max, nothing to rescue.
  if (health.totalDebtBase === 0n || health.healthFactor === MAX_UINT256) {
    throw new PlanNotNeeded("account has no debt; health factor is infinite");
  }
  // Edge: already at/above target.
  if (health.healthFactor >= targetHf) {
    throw new PlanNotNeeded(
      `health factor ${fmtHf(health.healthFactor)} already ≥ target ${fmtHf(targetHf)}`,
    );
  }
  if (health.currentLiquidationThreshold === 0n) {
    // LT=0 ⇒ collateral counts for nothing: supply can never raise HF; only repay works.
    const repay = buildCandidate("repay", health.totalDebtBase, market.debtAsset);
    return finalize(repay, health, market, null);
  }

  const repay = buildCandidate("repay", repayBaseToTarget(health, targetHf), market.debtAsset);
  const supply = buildCandidate("supply", supplyBaseToTarget(health, targetHf), market.collateralAsset);

  // Cheaper real spend wins; tie → repay (also unlocks borrow power, reduces interest).
  const chosen = repay.costBase <= supply.costBase ? repay : supply;
  const other = chosen === repay ? supply : repay;
  return finalize(chosen, health, market, other);
}

function finalize(
  chosen: Candidate,
  health: AccountHealth,
  market: { targetHf: bigint },
  other: Candidate | null,
): RescuePlan {
  // Resulting HF from the *actual* spend (margin + rounding included), so it is ≥ target.
  let resultingHf: bigint;
  if (chosen.kind === "repay") {
    const debtAfter =
      chosen.costBase >= health.totalDebtBase ? 0n : health.totalDebtBase - chosen.costBase;
    resultingHf = hfOf(health.totalCollateralBase, debtAfter, health.currentLiquidationThreshold);
  } else {
    resultingHf = hfOf(
      health.totalCollateralBase + chosen.costBase,
      health.totalDebtBase,
      health.currentLiquidationThreshold,
    );
  }

  const action =
    chosen.kind === "repay"
      ? `repay ${fmtToken(chosen.amount, chosen.asset)} of debt`
      : `supply ${fmtToken(chosen.amount, chosen.asset)} as collateral`;
  const vs = other
    ? ` (cheaper than ${other.kind} at ${fmtUsd(other.costBase)})`
    : " (liquidation threshold is 0 — supplying collateral cannot raise HF)";
  const rationale =
    `HF ${fmtHf(health.healthFactor)} < target ${fmtHf(market.targetHf)}: ` +
    `${action} costing ${fmtUsd(chosen.costBase)}${vs}; ` +
    `includes 1% safety margin over the exact ${fmtUsd(chosen.baseNeeded)} need; ` +
    `restores HF to ${fmtHf(resultingHf)}`;

  return {
    kind: chosen.kind,
    asset: chosen.asset.address,
    assetSymbol: chosen.asset.symbol,
    assetDecimals: chosen.asset.decimals,
    amount: chosen.amount,
    resultingHf,
    costBase: chosen.costBase,
    rationale,
  };
}
