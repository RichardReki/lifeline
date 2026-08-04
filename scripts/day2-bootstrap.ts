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
const WETH = (process.env.COLLATERAL_ASSET_ADDRESS ?? "0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c") as `0x${string}`;

// Position sizing: 2 mock-WETH collateral, borrow 4000 USDC → HF ≈ 1.6 at ~$4k/ETH
// (the test market's oracle tracks real prices loosely; `status` prints live HF).
const MINT_WETH = "2000000000000000000"; // 2e18
const MINT_USDC = "10000000000"; // 10,000e6 (kept for repay float)
const SUPPLY_WETH = "2000000000000000000";
const BORROW_USDC = "4000000000"; // 4,000e6
const CRASH_BORROW_USDC = "1500000000"; // +1,500e6 → sinks HF toward ~1.1 for the demo

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
  const [orgEth, deployerEth, weth, usdc] = await Promise.all([
    web3.getBalance({ address: ORG_WALLET }),
    DEPLOYER ? web3.getBalance({ address: DEPLOYER }) : Promise.resolve(0n),
    web3.readContract({ address: WETH, abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [ORG_WALLET] }),
    web3.readContract({ address: USDC, abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [ORG_WALLET] }),
  ]);
  console.log(`org wallet   ${ORG_WALLET}`);
  console.log(`  ETH  ${formatUnits(orgEth, 18)}`);
  console.log(`  WETH ${formatUnits(weth, 18)}   USDC ${formatUnits(usdc, 6)}`);
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
    ["WETH", WETH, MINT_WETH],
    ["USDC", USDC, MINT_USDC],
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
      return executor.runContractCall(req, { account: ORG_WALLET, label: `day2:mint-${name.toLowerCase()}` });
    });
  }
}

async function protocolStep(label: string, slug: string, asset: `0x${string}`, amount: string, extra?: Record<string, unknown>): Promise<void> {
  const { client } = makeExecutor();
  await simulateOrRun(`${label} (${slug})`, async (broadcast) => {
    const res = await client.executeProtocolAction(
      {
        slug,
        chainId: CHAIN_ID,
        params: { asset, amount, onBehalfOf: ORG_WALLET, ...extra },
      },
      broadcast ? { idempotencyKey: `day2:${slug}:${amount}` } : { simulate: true },
    );
    if (broadcast && res.executionId) return client.waitForExecution(res.executionId);
    return res;
  });
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
  case "supply":
    await protocolStep("supply 2 WETH collateral", "aave-v3/supply", WETH, SUPPLY_WETH);
    break;
  case "borrow":
    await protocolStep("borrow 4000 USDC", "aave-v3/borrow", USDC, BORROW_USDC, { interestRateMode: "2" });
    break;
  case "crash":
    await protocolStep("DEMO: borrow +1500 USDC to sink HF", "aave-v3/borrow", USDC, CRASH_BORROW_USDC, { interestRateMode: "2" });
    break;
  default:
    console.log("usage: npx tsx scripts/day2-bootstrap.ts <status|fund-deployer|mint|supply|borrow|crash> [--broadcast]");
    process.exit(STEP ? 1 : 0);
}
