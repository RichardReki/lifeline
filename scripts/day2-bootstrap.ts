/**
 * Day-2 bootstrap: stand up the guarded Aave position on Sepolia, with every
 * on-chain step executed THROUGH KeeperHub (each one becomes a real, linkable
 * KeeperHub execution).
 *
 *   npx tsx scripts/day2-bootstrap.ts status
 *   npx tsx scripts/day2-bootstrap.ts fund-deployer [--broadcast]
 *   npx tsx scripts/day2-bootstrap.ts mint          [--broadcast]
 *   npx tsx scripts/day2-bootstrap.ts supply        [--broadcast]
 *   npx tsx scripts/day2-bootstrap.ts borrow        [--broadcast]
 *   npx tsx scripts/day2-bootstrap.ts crash         [--broadcast]   (demo: extra borrow to sink HF)
 *
 * SAFETY: Sepolia-only (chainId hardcoded 11155111). Without --broadcast every
 * step runs simulate:true and nothing is signed or sent.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, formatUnits, http as viemHttp } from "viem";
import { sepolia } from "viem/chains";
import { KeeperHubRestClient } from "../src/keeperhub/client.js";
import { ReliableExecutor } from "../src/keeperhub/executor.js";
import type { AgentEvent } from "../src/types.js";

// ---------------------------------------------------------------------------
// Env / constants
// ---------------------------------------------------------------------------

function loadDotEnv(): void {
  try {
    const raw = readFileSync(resolve(process.cwd(), ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch {
    /* no .env — rely on the environment */
  }
}
loadDotEnv();

const CHAIN_ID = 11155111; // Sepolia ONLY — this script must never touch mainnet
const ORG_WALLET = (process.env.KH_WALLET_ADDRESS ?? "") as `0x${string}`;
const DEPLOYER = (process.env.DEPLOYER_ADDRESS ?? "") as `0x${string}`;
const POOL = (process.env.AAVE_POOL_SEPOLIA ?? "") as `0x${string}`;
const RPC = process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";

// Aave v3 Sepolia test market (contracts/addresses.md + bgd-labs/aave-address-book)
const FAUCET = "0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D" as const;
const USDC = (process.env.DEBT_ASSET_ADDRESS ?? "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8") as `0x${string}`;
// Collateral is WBTC. Probed live on the shared Sepolia test market:
// DAI/USDC/USDT supply caps are exhausted (Error 51), WETH is not
// faucet-mintable, but WBTC and LINK both mint AND have supply-cap room
// (their supply probes fail on balance, not cap). Borrow caps for the
// stables are fine (Error 34, not 50).
const WBTC = (process.env.COLLATERAL_ASSET_ADDRESS ?? "0x29f2D40B0605204364af54EC677bD022dA425d03") as `0x${string}`;
const LINK = "0xf8Fb3713D459D7C1018BD0A49D19b4C44290EBE5" as const; // backup collateral

// Debt asset is LINK, not a stable: the drained test market has only ~$86 of
// USDC / ~$200 of DAI left to borrow, while the LINK reserve holds ~78M LINK.
// LINK also mints freely from the faucet, so the rescue repay float is
// unlimited. Oracle (0x2da8...a663): LINK = $30, WBTC = $60,000 (8-dec USD).
const ORACLE = "0x2da88497588bf89281816106C7259e31AF45a663" as const;

// Position sizing: 1 WBTC collateral; `borrow` sizes LINK debt off the LIVE
// account data + oracle price for HF ≈ 1.65.
const MINT_WBTC = "200000000"; // 2e8 = 2 WBTC (1 to supply, 1 as supply-rescue float)
const MINT_LINK = "2000000000000000000000"; // 2,000e18 LINK (repay-rescue float)
const SUPPLY_WBTC = "100000000"; // 1 WBTC
const TARGET_HF_BPS = 16500n; // borrow sized for HF 1.65
const CRASH_HF_BPS = 11500n; // demo crash borrows down to HF 1.15

const BROADCAST = process.argv.includes("--broadcast");
const STEP = process.argv[2];

const FAUCET_MINT_ABI = JSON.stringify([
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
]);

const POOL_ABI = [
  {
    type: "function",
    name: "getUserAccountData",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      { name: "totalCollateralBase", type: "uint256" },
      { name: "totalDebtBase", type: "uint256" },
      { name: "availableBorrowsBase", type: "uint256" },
      { name: "currentLiquidationThreshold", type: "uint256" },
      { name: "ltv", type: "uint256" },
      { name: "healthFactor", type: "uint256" },
    ],
  },
] as const;

const ERC20_BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

function requireEnv(): void {
  const missing: string[] = [];
  if (!process.env.KH_API_KEY) missing.push("KH_API_KEY");
  if (!ORG_WALLET) missing.push("KH_WALLET_ADDRESS");
  if (!POOL) missing.push("AAVE_POOL_SEPOLIA");
  if (missing.length) {
    console.error(`missing .env values: ${missing.join(", ")}`);
    process.exit(1);
  }
}

const onEvent = (e: AgentEvent) =>
  console.log(`  [${e.kind}] ${JSON.stringify(e.detail).slice(0, 300)}`);

function makeExecutor(): { client: KeeperHubRestClient; executor: ReliableExecutor } {
  const client = new KeeperHubRestClient({
    baseUrl: process.env.KH_BASE_URL ?? "https://app.keeperhub.com",
    apiKey: process.env.KH_API_KEY as string,
  });
  return { client, executor: new ReliableExecutor(client, { onEvent }) };
}

function mode(): string {
  return BROADCAST ? "BROADCAST (real Sepolia transactions)" : "simulate-only (pass --broadcast to send)";
}

async function simulateOrRun(
  label: string,
  run: (broadcast: boolean) => Promise<unknown>,
): Promise<void> {
  console.log(`\n== ${label} — ${mode()}`);
  const out = await run(BROADCAST);
  console.log(`   result: ${JSON.stringify(out, null, 2).slice(0, 1500)}`);
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function stepStatus(): Promise<void> {
  const web3 = createPublicClient({ chain: sepolia, transport: viemHttp(RPC) });
  const [orgEth, deployerEth, wbtc, link] = await Promise.all([
    web3.getBalance({ address: ORG_WALLET }),
    DEPLOYER ? web3.getBalance({ address: DEPLOYER }) : Promise.resolve(0n),
    web3.readContract({ address: WBTC, abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [ORG_WALLET] }),
    web3.readContract({ address: LINK, abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [ORG_WALLET] }),
  ]);
  console.log(`org wallet   ${ORG_WALLET}`);
  console.log(`  ETH  ${formatUnits(orgEth, 18)}`);
  console.log(`  WBTC ${formatUnits(wbtc, 8)}   LINK ${formatUnits(link, 18)}`);
  if (DEPLOYER) console.log(`deployer     ${DEPLOYER}\n  ETH  ${formatUnits(deployerEth, 18)}`);
  const acct = await web3.readContract({
    address: POOL,
    abi: POOL_ABI,
    functionName: "getUserAccountData",
    args: [ORG_WALLET],
  });
  const hf = acct[5];
  const hfStr = hf > 10n ** 30n ? "max (no debt)" : formatUnits(hf, 18);
  console.log(`aave position collateral=$${formatUnits(acct[0], 8)} debt=$${formatUnits(acct[1], 8)} HF=${hfStr}`);
}

async function stepFundDeployer(): Promise<void> {
  const { client } = makeExecutor();
  await simulateOrRun(`transfer 0.02 ETH org→deployer ${DEPLOYER}`, async (broadcast) => {
    const res = await client.executeTransfer(
      // amount is ETHER units by API contract (parseEther server-side)
      { chainId: CHAIN_ID, recipientAddress: DEPLOYER, amount: "0.02" },
      broadcast ? { idempotencyKey: "day2:fund-deployer:1" } : { simulate: true },
    );
    if (broadcast && res.executionId) return client.waitForExecution(res.executionId);
    return res;
  });
}

async function stepMint(): Promise<void> {
  const { executor } = makeExecutor();
  for (const [name, token, amount] of [
    ["WBTC", WBTC, MINT_WBTC],
    ["LINK", LINK, MINT_LINK],
  ] as const) {
    await simulateOrRun(`faucet mint ${name} → org wallet`, async (broadcast) => {
      const req = {
        chainId: CHAIN_ID,
        contractAddress: FAUCET,
        abi: FAUCET_MINT_ABI,
        functionName: "mint",
        functionArgs: JSON.stringify([token, ORG_WALLET, amount]),
      } as const;
      if (!broadcast) {
        const { client } = makeExecutor();
        return client.executeContractCall(req, { simulate: true });
      }
      // Amount is part of the label: the idempotency key must change when the
      // request payload changes (the API 409s on key reuse with a new payload).
      return executor.runContractCall(req, { account: ORG_WALLET, label: `day2:mint-${name.toLowerCase()}-${amount}` });
    });
  }
}

const ERC20_APPROVE_ABI = JSON.stringify([
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
]);

async function stepApprove(): Promise<void> {
  const { client, executor } = makeExecutor();
  await simulateOrRun(`approve Pool to pull ${SUPPLY_WBTC} WBTC`, async (broadcast) => {
    const req = {
      chainId: CHAIN_ID,
      contractAddress: WBTC,
      abi: ERC20_APPROVE_ABI,
      functionName: "approve",
      functionArgs: JSON.stringify([POOL, SUPPLY_WBTC]),
    } as const;
    if (!broadcast) return client.executeContractCall(req, { simulate: true });
    return executor.runContractCall(req, { account: ORG_WALLET, label: "day2:approve-wbtc" });
  });
}

async function protocolStep(label: string, slug: string, asset: `0x${string}`, amount: string, extra?: Record<string, unknown>): Promise<void> {
  // HARD-LEARNED: the protocol-action route (app/api/execute/[...slug]) has NO
  // simulate support — unlike transfer/contract-call/check-and-execute it
  // ignores the flag, and a "dry run" that passes gas estimation BROADCASTS.
  // (Failing calls do error out at estimation, which is why the cap probes
  // never landed.) So: refuse to run protocol actions without --broadcast.
  if (!BROADCAST) {
    console.log(`\n== ${label} (${slug}) — SKIPPED: protocol actions have no dry-run; re-run with --broadcast`);
    return;
  }
  const { client } = makeExecutor();
  await simulateOrRun(`${label} (${slug})`, async () => {
    const res = await client.executeProtocolAction(
      {
        slug,
        chainId: CHAIN_ID,
        params: { asset, amount, onBehalfOf: ORG_WALLET, ...extra },
      },
      { idempotencyKey: `day2:${slug}:${amount}` },
    );
    if (res.executionId) return client.waitForExecution(res.executionId);
    return res;
  });
}

const ORACLE_PRICE_ABI = [
  {
    type: "function",
    name: "getAssetPrice",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** Live account data + the oracle's LINK price, in one round trip. */
async function readPosition(): Promise<{
  acct: readonly [bigint, bigint, bigint, bigint, bigint, bigint];
  linkPrice8: bigint;
}> {
  const web3 = createPublicClient({ chain: sepolia, transport: viemHttp(RPC) });
  const [acct, linkPrice8] = await Promise.all([
    web3.readContract({ address: POOL, abi: POOL_ABI, functionName: "getUserAccountData", args: [ORG_WALLET] }),
    web3.readContract({ address: ORACLE, abi: ORACLE_PRICE_ABI, functionName: "getAssetPrice", args: [LINK] }),
  ]);
  return { acct, linkPrice8 };
}

/**
 * Repay LINK until the position sits at the requested health factor.
 *
 * This is the demo-day reset: a take ends with the agent having rescued to
 * HF 1.50, and the next take needs to start healthy again at 1.65. It is
 * deliberately NOT part of the agent — the agent only ever repays down to
 * HF_TARGET when the chain says a position is in danger.
 */
async function healToTargetHf(targetHfBps: bigint, label: string): Promise<void> {
  const { acct, linkPrice8 } = await readPosition();
  // debt(USD8) for target HF = collateral(USD8) * liqThr(bps) / targetHf(bps)
  const targetDebtUsd8 = (acct[0] * acct[3]) / targetHfBps;
  const repayUsd8 = acct[1] - targetDebtUsd8;
  if (repayUsd8 <= 0n) {
    console.log(`position already at/above HF ${Number(targetHfBps) / 10000} — nothing to repay`);
    return;
  }
  // Round the LINK amount up so accrued interest between sizing and execution
  // cannot leave us a hair under target.
  const repayLink18 = (repayUsd8 * 10n ** 18n) / linkPrice8 + 10n ** 16n;
  console.log(
    `live sizing: collateral=$${formatUnits(acct[0], 8)} debt=$${formatUnits(acct[1], 8)} liqThr=${acct[3]}bps ` +
      `LINK=$${formatUnits(linkPrice8, 8)} -> repay ${formatUnits(repayLink18, 18)} LINK for HF≈${Number(targetHfBps) / 10000}`,
  );

  // Pool has to be able to pull the LINK. Key includes the amount: a reused
  // key with a changed payload is a 409 (learned the hard way in rescue #2).
  const { client, executor } = makeExecutor();
  if (BROADCAST) {
    await executor.runContractCall(
      {
        chainId: CHAIN_ID,
        contractAddress: LINK,
        abi: ERC20_APPROVE_ABI,
        functionName: "approve",
        functionArgs: JSON.stringify([POOL, repayLink18.toString()]),
      },
      { account: ORG_WALLET, label: `day2:approve-link-${repayLink18}` },
    );
  } else {
    const sim = await client.executeContractCall(
      {
        chainId: CHAIN_ID,
        contractAddress: LINK,
        abi: ERC20_APPROVE_ABI,
        functionName: "approve",
        functionArgs: JSON.stringify([POOL, repayLink18.toString()]),
      },
      { simulate: true },
    );
    console.log(`   approve simulation: ${JSON.stringify(sim.simulation)}`);
  }

  await protocolStep(
    `${label}: ${formatUnits(repayLink18, 18)} LINK`,
    "aave-v3/repay",
    LINK,
    repayLink18.toString(),
    { interestRateMode: "2" },
  );
}

/**
 * Borrow LINK sized off the LIVE account data + oracle price so the position
 * lands at the requested health factor (bps, e.g. 16500 = HF 1.65).
 */
async function borrowToTargetHf(targetHfBps: bigint, label: string): Promise<void> {
  const web3 = createPublicClient({ chain: sepolia, transport: viemHttp(RPC) });
  const [acct, linkPrice8] = await Promise.all([
    web3.readContract({ address: POOL, abi: POOL_ABI, functionName: "getUserAccountData", args: [ORG_WALLET] }),
    web3.readContract({ address: ORACLE, abi: ORACLE_PRICE_ABI, functionName: "getAssetPrice", args: [LINK] }),
  ]);
  // debt(USD8) for target HF = collateral(USD8) * liqThr(bps) / targetHf(bps)
  const targetDebtUsd8 = (acct[0] * acct[3]) / targetHfBps;
  const borrowUsd8 = targetDebtUsd8 - acct[1];
  if (borrowUsd8 <= 0n) throw new Error(`position already at/below HF ${Number(targetHfBps) / 10000}`);
  const borrowLink18 = (borrowUsd8 * 10n ** 18n) / linkPrice8;
  console.log(
    `live sizing: collateral=$${formatUnits(acct[0], 8)} debt=$${formatUnits(acct[1], 8)} liqThr=${acct[3]}bps ` +
      `LINK=$${formatUnits(linkPrice8, 8)} -> borrow ${formatUnits(borrowLink18, 18)} LINK for HF≈${Number(targetHfBps) / 10000}`,
  );
  await protocolStep(
    `${label}: ${formatUnits(borrowLink18, 18)} LINK`,
    "aave-v3/borrow",
    LINK,
    borrowLink18.toString(),
    { interestRateMode: "2", referralCode: "0" },
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

requireEnv();
switch (STEP) {
  case "status":
    await stepStatus();
    break;
  case "fund-deployer":
    if (!DEPLOYER) throw new Error("DEPLOYER_ADDRESS not in .env");
    await stepFundDeployer();
    break;
  case "mint":
    await stepMint();
    break;
  case "approve":
    await stepApprove();
    break;
  case "supply":
    await protocolStep("supply 1 WBTC collateral", "aave-v3/supply", WBTC, SUPPLY_WBTC, { referralCode: "0" });
    break;
  case "borrow":
    await borrowToTargetHf(TARGET_HF_BPS, "borrow LINK to open the position");
    break;
  case "crash":
    await borrowToTargetHf(CRASH_HF_BPS, "DEMO: borrow LINK to sink HF");
    break;
  case "heal":
    await healToTargetHf(TARGET_HF_BPS, "DEMO RESET: repay LINK to restore HF");
    break;
  default:
    console.log("usage: npx tsx scripts/day2-bootstrap.ts <status|fund-deployer|mint|approve|supply|borrow|crash|heal> [--broadcast]");
    process.exit(STEP ? 1 : 0);
}
