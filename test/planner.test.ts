import { describe, expect, it } from "vitest";
import {
  BPS,
  MAX_UINT256,
  PlanNotNeeded,
  WAD,
  hfOf,
  planRescue,
  repayBaseToTarget,
  supplyBaseToTarget,
  type MarketAsset,
} from "../src/planner/planner.js";
import { projectHf, type HfSample } from "../src/planner/trajectory.js";
import type { AccountHealth } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures — clean numbers so the target-HF divisions are exact.
// ---------------------------------------------------------------------------

const USD = 10n ** 8n; // 8-dec base currency

/** $10,000 collateral (LT 80%), $6,000 debt → HF = 8000/6000 = 1.333… */
function baseAccount(): AccountHealth {
  const totalCollateralBase = 10_000n * USD;
  const totalDebtBase = 6_000n * USD;
  const currentLiquidationThreshold = 8_000n; // bps
  return {
    totalCollateralBase,
    totalDebtBase,
    availableBorrowsBase: 0n,
    currentLiquidationThreshold,
    ltv: 7_500n,
    healthFactor: hfOf(totalCollateralBase, totalDebtBase, currentLiquidationThreshold),
  };
}

const TARGET = (16n * WAD) / 10n; // 1.6e18 — chosen so debtAfter (5000e8) and collateralAfter (12000e8) are exact

const usdc: MarketAsset = {
  address: "0x0000000000000000000000000000000000000001",
  symbol: "USDC",
  decimals: 6,
  priceBase: 1n * USD, // $1
};
const weth: MarketAsset = {
  address: "0x0000000000000000000000000000000000000002",
  symbol: "WETH",
  decimals: 18,
  priceBase: 2_000n * USD, // $2,000
};

// ---------------------------------------------------------------------------
// Exact restore math
// ---------------------------------------------------------------------------

describe("repay math", () => {
  it("computes the base repay that restores exactly the target HF", () => {
    const health = baseAccount();
    const repayBase = repayBaseToTarget(health, TARGET);
    // debtAfter = 10000·0.8/1.6 = 5000 → repay 1000 USD
    expect(repayBase).toBe(1_000n * USD);
    const hfAfter = hfOf(
      health.totalCollateralBase,
      health.totalDebtBase - repayBase,
      health.currentLiquidationThreshold,
    );
    expect(hfAfter).toBe(TARGET); // exactly on target
  });

  it("never overshoots below target from flooring debtAfter", () => {
    // Awkward numbers: HF after repay must still be ≥ target.
    const health: AccountHealth = {
      totalCollateralBase: 9_876_543_210n,
      totalDebtBase: 7_777_777_777n,
      availableBorrowsBase: 0n,
      currentLiquidationThreshold: 8_250n,
      ltv: 8_000n,
      healthFactor: hfOf(9_876_543_210n, 7_777_777_777n, 8_250n),
    };
    const target = (15n * WAD) / 10n;
    const repayBase = repayBaseToTarget(health, target);
    const hfAfter = hfOf(
      health.totalCollateralBase,
      health.totalDebtBase - repayBase,
      health.currentLiquidationThreshold,
    );
    expect(hfAfter >= target).toBe(true);
  });
});

describe("supply math", () => {
  it("computes the base supply that restores exactly the target HF", () => {
    const health = baseAccount();
    const supplyBase = supplyBaseToTarget(health, TARGET);
    // collateralAfter = 1.6·6000/0.8 = 12000 → supply 2000 USD
    expect(supplyBase).toBe(2_000n * USD);
    const hfAfter = hfOf(
      health.totalCollateralBase + supplyBase,
      health.totalDebtBase,
      health.currentLiquidationThreshold,
    );
    expect(hfAfter).toBe(TARGET); // exactly on target
  });

  it("never lands below target from ceiling collateralAfter", () => {
    const health: AccountHealth = {
      totalCollateralBase: 9_876_543_210n,
      totalDebtBase: 7_777_777_777n,
      availableBorrowsBase: 0n,
      currentLiquidationThreshold: 8_250n,
      ltv: 8_000n,
      healthFactor: hfOf(9_876_543_210n, 7_777_777_777n, 8_250n),
    };
    const target = (15n * WAD) / 10n;
    const supplyBase = supplyBaseToTarget(health, target);
    const hfAfter = hfOf(
      health.totalCollateralBase + supplyBase,
      health.totalDebtBase,
      health.currentLiquidationThreshold,
    );
    expect(hfAfter >= target).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// planRescue — selection, margin, conversions
// ---------------------------------------------------------------------------

describe("planRescue", () => {
  it("picks repay when it is the cheaper rescue and applies the 1% margin", () => {
    const plan = planRescue(baseAccount(), {
      debtAsset: usdc,
      collateralAsset: weth,
      targetHf: TARGET,
    });
    expect(plan.kind).toBe("repay");
    expect(plan.asset).toBe(usdc.address);
    expect(plan.assetSymbol).toBe("USDC");
    expect(plan.assetDecimals).toBe(6);
    // 1000 USD need · 1.01 at $1 / 6 decimals = 1010 USDC raw
    expect(plan.amount).toBe(1_010_000_000n);
    expect(plan.costBase).toBe(1_010n * USD);
    // Margin overshoots the target slightly — never undershoots.
    expect(plan.resultingHf >= TARGET).toBe(true);
    expect(plan.resultingHf < (TARGET * 103n) / 100n).toBe(true);
    expect(plan.rationale).toContain("repay");
  });

  it("flips to supply when debt-token granularity/price makes repay dearer, and back with prices", () => {
    const chunkyDebt: MarketAsset = {
      address: "0x0000000000000000000000000000000000000003",
      symbol: "CHUNK",
      decimals: 0, // indivisible token
      priceBase: 5_000n * USD, // $5,000 per token
    };
    // Repay needs $1,010 → smallest unit is 1 whole token = $5,000 spent.
    // Supply needs $2,020 of WETH → supply is the genuinely cheaper rescue.
    const expensive = planRescue(baseAccount(), {
      debtAsset: chunkyDebt,
      collateralAsset: weth,
      targetHf: TARGET,
    });
    expect(expensive.kind).toBe("supply");
    expect(expensive.asset).toBe(weth.address);
    expect(expensive.amount).toBe(1_010_000_000_000_000_000n); // 1.01 WETH
    expect(expensive.costBase).toBe(2_020n * USD);
    expect(expensive.resultingHf >= TARGET).toBe(true);

    // Same market, debt token now $100: repay = 11 tokens = $1,100 < $2,020 → flips back.
    const cheapDebt: MarketAsset = { ...chunkyDebt, priceBase: 100n * USD };
    const cheap = planRescue(baseAccount(), {
      debtAsset: cheapDebt,
      collateralAsset: weth,
      targetHf: TARGET,
    });
    expect(cheap.kind).toBe("repay");
    expect(cheap.amount).toBe(11n);
    expect(cheap.costBase).toBe(1_100n * USD);
    expect(cheap.resultingHf >= TARGET).toBe(true);
  });

  it("throws PlanNotNeeded when the account has no debt", () => {
    const health: AccountHealth = {
      totalCollateralBase: 10_000n * USD,
      totalDebtBase: 0n,
      availableBorrowsBase: 8_000n * USD,
      currentLiquidationThreshold: 8_000n,
      ltv: 7_500n,
      healthFactor: MAX_UINT256,
    };
    expect(() =>
      planRescue(health, { debtAsset: usdc, collateralAsset: weth, targetHf: TARGET }),
    ).toThrow(PlanNotNeeded);
  });

  it("throws PlanNotNeeded when HF is already at or above target", () => {
    const health = baseAccount();
    const healthy: AccountHealth = {
      ...health,
      totalDebtBase: 4_000n * USD, // HF = 8000/4000 = 2.0
      healthFactor: hfOf(health.totalCollateralBase, 4_000n * USD, health.currentLiquidationThreshold),
    };
    expect(healthy.healthFactor).toBe(2n * WAD);
    expect(() =>
      planRescue(healthy, { debtAsset: usdc, collateralAsset: weth, targetHf: TARGET }),
    ).toThrow(PlanNotNeeded);
  });

  it("sanity: exposed constants line up", () => {
    expect(WAD).toBe(10n ** 18n);
    expect(BPS).toBe(10_000n);
  });
});

// ---------------------------------------------------------------------------
// Trajectory
// ---------------------------------------------------------------------------

function sampleAt(tsMs: number, hf: bigint): HfSample {
  return {
    ts: tsMs,
    health: {
      totalCollateralBase: 10_000n * USD,
      totalDebtBase: 6_000n * USD,
      availableBorrowsBase: 0n,
      currentLiquidationThreshold: 8_000n,
      ltv: 7_500n,
      healthFactor: hf,
    },
  };
}

describe("projectHf", () => {
  it("fits a falling series and projects drift + secondsToLiquidation exactly", () => {
    // HF falls 0.01 per 60s: 1.50, 1.49, 1.48, 1.47, 1.46 (perfectly linear).
    const step = 10n ** 16n; // 0.01e18
    const samples: HfSample[] = [0, 1, 2, 3, 4].map((i) =>
      sampleAt(i * 60_000, (150n * WAD) / 100n - BigInt(i) * step),
    );
    const traj = projectHf(samples, 600);
    expect(traj.current).toBe((146n * WAD) / 100n);
    // slope = −0.01e18/60s → over 600s = −0.1e18
    expect(traj.projected).toBe((136n * WAD) / 100n);
    // (1.46 − 1.0) / (0.01/60) = 0.46·60/0.01 = 2760 s
    expect(traj.secondsToLiquidation).toBe(2760);
    expect(traj.horizonSeconds).toBe(600);
  });

  it("returns Infinity secondsToLiquidation for a non-decreasing series", () => {
    const samples: HfSample[] = [0, 1, 2, 3].map((i) =>
      sampleAt(i * 60_000, (150n * WAD) / 100n + BigInt(i) * 10n ** 15n),
    );
    const traj = projectHf(samples, 3600);
    expect(traj.secondsToLiquidation).toBe(Number.POSITIVE_INFINITY);
    expect(traj.projected >= traj.current).toBe(true);
  });

  it("is flat with a single sample", () => {
    const traj = projectHf([sampleAt(0, (12n * WAD) / 10n)], 3600);
    expect(traj.projected).toBe((12n * WAD) / 10n);
    expect(traj.secondsToLiquidation).toBe(Number.POSITIVE_INFINITY);
  });

  it("reports 0 seconds when already at/below HF 1.0 and still falling", () => {
    const samples: HfSample[] = [0, 1, 2].map((i) =>
      sampleAt(i * 60_000, WAD - BigInt(i) * 10n ** 15n),
    );
    const traj = projectHf(samples, 600);
    expect(traj.secondsToLiquidation).toBe(0);
  });

  it("treats a debt-free (uint256 max HF) account as non-liquidatable", () => {
    const samples: HfSample[] = [sampleAt(0, MAX_UINT256), sampleAt(60_000, MAX_UINT256)];
    const traj = projectHf(samples, 600);
    expect(traj.current).toBe(MAX_UINT256);
    expect(traj.projected).toBe(MAX_UINT256);
    expect(traj.secondsToLiquidation).toBe(Number.POSITIVE_INFINITY);
  });

  it("clamps the projection at zero", () => {
    // Violent fall: 1.4 → 1.2 over 2 minutes; projecting an hour ahead goes negative → clamp.
    const samples: HfSample[] = [0, 1, 2].map((i) =>
      sampleAt(i * 60_000, (14n * WAD) / 10n - (BigInt(i) * WAD) / 10n),
    );
    const traj = projectHf(samples, 3600);
    expect(traj.projected).toBe(0n);
    expect(traj.secondsToLiquidation).toBe(120); // 0.2 left / (0.1/60s)
  });
});
