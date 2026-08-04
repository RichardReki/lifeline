/**
 * LIFELINE agent — detect → decide → execute.
 *
 * One process, two detection paths (belt and braces):
 *   (a) HTTP server on WEBHOOK_PORT
 *         POST /hook/hf-alert  — fired by the KeeperHub Block-trigger workflow
 *                                (src/workflows/hf-monitor.json); requires the
 *                                X-Lifeline-Secret header to match WEBHOOK_SECRET.
 *         GET  /events         — SSE stream of AgentEvents (audit log live tail).
 *         GET  /health         — liveness: { ok, lastTick }.
 *   (b) A local 60s poll loop reading Aave getUserAccountData via viem.
 *
 * Decide: planner.planRescue picks the cheaper of repay-debt / supply-collateral
 * to restore HF_TARGET, with trajectory.projectHf providing early warning.
 *
 * Execute: KeeperHub check-and-execute — the condition re-verifies
 * HealthFactorLens.healthFactorOf(pool, account) < HF_WARN_THRESHOLD ON-CHAIN at
 * execution time, so a stale alert can never fire an unnecessary rescue.
 *
 * Flags:
 *   --once  evaluate the guarded account a single time, then exit
 *   --dry   simulate-only (KeeperHub "simulate": true — no broadcast)
 *
 * Run: npx tsx src/agent/index.ts [--once] [--dry]
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, http as viemHttp } from "viem";
import type {
  AccountHealth,
  AgentEvent,
  CheckAndExecuteRequest,
  ContractCallRequest,
  KeeperHubClient,
  RescuePlan,
} from "../types.js";
import { planRescue, PlanNotNeeded, type RescueMarket, type MarketAsset } from "../planner/planner.js";
import { projectHf, type HfSample } from "../planner/trajectory.js";
import { AuditLog, stringifyEvent } from "./audit.js";
// Built in parallel in src/keeperhub/ against the pinned signatures in src/types.ts.
import { KeeperHubRestClient } from "../keeperhub/client.js";
import { ReliableExecutor } from "../keeperhub/executor.js";

type Address = `0x${string}`;
const WAD = 10n ** 18n;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// ---------------------------------------------------------------------------
// ABIs
// ---------------------------------------------------------------------------

/** Aave v3 IPool.getUserAccountData — full six-field return, base values 8-dec USD. */
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

/** Our HealthFactorLens view — single uint256, usable as a check-and-execute condition. */
const LENS_ABI = [
  {
    type: "function",
    name: "healthFactorOf",
    stateMutability: "view",
    inputs: [
      { name: "pool", type: "address" },
      { name: "account", type: "address" },
    ],
    outputs: [{ name: "healthFactor", type: "uint256" }],
  },
] as const;

const ERC20_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
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
] as const;

const ORACLE_ABI = [
  {
    type: "function",
    name: "getAssetPrice",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** Aave v3 IPool.repay / supply — the two rescue actions (JSON-encoded into requests). */
const REPAY_ABI_ITEM = {
  type: "function",
  name: "repay",
  stateMutability: "nonpayable",
  inputs: [
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "interestRateMode", type: "uint256" },
    { name: "onBehalfOf", type: "address" },
  ],
  outputs: [{ name: "", type: "uint256" }],
};
const SUPPLY_ABI_ITEM = {
  type: "function",
  name: "supply",
  stateMutability: "nonpayable",
  inputs: [
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "onBehalfOf", type: "address" },
    { name: "referralCode", type: "uint16" },
  ],
  outputs: [],
};

// ---------------------------------------------------------------------------
// Env / config
// ---------------------------------------------------------------------------

/** Minimal dotenv: parse ./.env if present; never overrides existing process.env. */
function loadDotEnv(path = ".env"): void {
  const file = resolve(path);
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/** Parse a human decimal like "1.3" into a 1e18-scaled bigint without float error. */
function parseDecimal1e18(text: string, name: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) throw new Error(`config: ${name}="${text}" is not a decimal number`);
  const frac = (m[2] ?? "").slice(0, 18).padEnd(18, "0");
  return BigInt(m[1]!) * WAD + BigInt(frac);
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

function requireEnv(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`config: required env ${name} is not set (see .env.example)`);
  return v;
}

function envAddress(name: string): Address | undefined {
  const v = env(name);
  if (!v) return undefined;
  if (!ADDRESS_RE.test(v)) throw new Error(`config: ${name}="${v}" is not a 0x address`);
  return v as Address;
}

interface AgentConfig {
  /** Symbolic network name, "sepolia" | "base" (drives RPC/address selection). */
  network: string;
  /** Canonical KeeperHub chain id for request bodies (KEEP-490): 11155111 | 8453. */
  chainId: number;
  rpcUrl: string;
  poolAddress: Address;
  lensAddress?: Address;
  oracleAddress?: Address;
  guardedAccount: Address;
  /** KeeperHub org wallet that signs executions (for the allowance pre-check). */
  executorAddress?: Address;
  webhookPort: number;
  webhookSecret: string;
  hfWarn: bigint; // 1e18
  hfTarget: bigint; // 1e18
  horizonSeconds: number;
  pollMs: number;
  rescueCooldownMs: number;
  khBaseUrl: string;
  khApiKey?: string;
  debtAsset?: MarketAsset;
  collateralAsset?: MarketAsset;
}

function envAsset(prefix: "DEBT_ASSET" | "COLLATERAL_ASSET"): MarketAsset | undefined {
  const address = envAddress(`${prefix}_ADDRESS`);
  if (!address) return undefined;
  const decimals = Number(env(`${prefix}_DECIMALS`) ?? "18");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`config: ${prefix}_DECIMALS out of range`);
  }
  return {
    address,
    symbol: env(`${prefix}_SYMBOL`) ?? prefix,
    decimals,
    // Fallback price when no on-chain oracle is configured (8-dec USD / whole token).
    priceBase: BigInt(env(`${prefix}_PRICE_BASE`) ?? "0"),
  };
}

function loadConfig(): AgentConfig {
  const network = (env("KH_NETWORK") ?? env("NETWORK") ?? "sepolia").toLowerCase();
  const isBase = network.startsWith("base");
  const rpcUrl = isBase ? requireEnv("BASE_RPC") : requireEnv("SEPOLIA_RPC");
  const poolAddress = isBase
    ? (envAddress("AAVE_POOL_BASE") ?? envAddress("AAVE_POOL"))
    : (envAddress("AAVE_POOL_SEPOLIA") ?? envAddress("AAVE_POOL"));
  if (!poolAddress) throw new Error("config: AAVE_POOL_SEPOLIA / AAVE_POOL_BASE not set");
  const lensAddress = isBase
    ? (envAddress("LENS_ADDRESS_BASE") ?? envAddress("LENS_ADDRESS"))
    : (envAddress("LENS_ADDRESS_SEPOLIA") ?? envAddress("LENS_ADDRESS"));
  const guardedAccount = envAddress("GUARDED_ACCOUNT");
  if (!guardedAccount) throw new Error("config: GUARDED_ACCOUNT not set");

  return {
    network,
    chainId: isBase ? 8453 : 11155111,
    rpcUrl,
    poolAddress,
    lensAddress,
    oracleAddress: isBase
      ? (envAddress("AAVE_ORACLE_BASE") ?? envAddress("AAVE_ORACLE"))
      : (envAddress("AAVE_ORACLE_SEPOLIA") ?? envAddress("AAVE_ORACLE")),
    guardedAccount,
    executorAddress: envAddress("KH_WALLET_ADDRESS"),
    webhookPort: Number(env("WEBHOOK_PORT") ?? "8787"),
    webhookSecret: requireEnv("WEBHOOK_SECRET"),
    hfWarn: parseDecimal1e18(env("HF_WARN_THRESHOLD") ?? "1.3", "HF_WARN_THRESHOLD"),
    hfTarget: parseDecimal1e18(env("HF_TARGET") ?? "1.5", "HF_TARGET"),
    horizonSeconds: Number(env("HF_HORIZON_SECONDS") ?? "3600"),
    pollMs: Number(env("POLL_INTERVAL_MS") ?? "60000"),
    rescueCooldownMs: Number(env("RESCUE_COOLDOWN_MS") ?? "300000"),
    khBaseUrl: env("KH_BASE_URL") ?? "https://app.keeperhub.com",
    khApiKey: env("KH_API_KEY"),
    debtAsset: envAsset("DEBT_ASSET"),
    collateralAsset: envAsset("COLLATERAL_ASSET"),
  };
}

// ---------------------------------------------------------------------------
// Chain reads
// ---------------------------------------------------------------------------

function makeWeb3(rpcUrl: string) {
  return createPublicClient({ transport: viemHttp(rpcUrl) });
}
type Web3 = ReturnType<typeof makeWeb3>;

async function readAccountHealth(web3: Web3, pool: Address, account: Address): Promise<AccountHealth> {
  const [
    totalCollateralBase,
    totalDebtBase,
    availableBorrowsBase,
    currentLiquidationThreshold,
    ltv,
    healthFactor,
  ] = await web3.readContract({
    address: pool,
    abi: POOL_ABI,
    functionName: "getUserAccountData",
    args: [account],
  });
  return {
    totalCollateralBase,
    totalDebtBase,
    availableBorrowsBase,
    currentLiquidationThreshold,
    ltv,
    healthFactor,
  };
}

/** Market for the planner: env-configured assets, prices refreshed from the Aave oracle when set. */
async function resolveMarket(deps: Deps): Promise<RescueMarket | null> {
  const { cfg, web3 } = deps;
  if (!cfg.debtAsset || !cfg.collateralAsset) return null;
  const debtAsset = { ...cfg.debtAsset };
  const collateralAsset = { ...cfg.collateralAsset };
  if (cfg.oracleAddress) {
    const [debtPrice, collateralPrice] = await Promise.all([
      web3.readContract({
        address: cfg.oracleAddress,
        abi: ORACLE_ABI,
        functionName: "getAssetPrice",
        args: [debtAsset.address],
      }),
      web3.readContract({
        address: cfg.oracleAddress,
        abi: ORACLE_ABI,
        functionName: "getAssetPrice",
        args: [collateralAsset.address],
      }),
    ]);
    debtAsset.priceBase = debtPrice;
    collateralAsset.priceBase = collateralPrice;
  }
  if (debtAsset.priceBase <= 0n || collateralAsset.priceBase <= 0n) return null;
  return { debtAsset, collateralAsset, targetHf: cfg.hfTarget };
}

// ---------------------------------------------------------------------------
// Execution — KeeperHub check-and-execute (HF re-verified on-chain)
// ---------------------------------------------------------------------------

/**
 * The on-chain guard: only execute while HealthFactorLens still reports
 * HF < warn threshold. Flat fields per the real check-and-execute schema
 * (check contract at the top level, condition as {operator, value}).
 */
function buildCheck(
  cfg: AgentConfig,
  account: Address,
): Omit<CheckAndExecuteRequest, "chainId" | "action"> {
  if (!cfg.lensAddress) throw new Error("buildCheck requires lensAddress");
  return {
    contractAddress: cfg.lensAddress,
    abi: JSON.stringify(LENS_ABI),
    functionName: "healthFactorOf",
    functionArgs: JSON.stringify([cfg.poolAddress, account]),
    condition: {
      operator: "lt",
      value: cfg.hfWarn.toString(), // HF_WARN_THRESHOLD, 1e18-scaled decimal string
    },
  };
}

/** Aave Pool repay(asset, amount, 2 = variable rate, onBehalfOf) or supply(asset, amount, onBehalfOf, 0). */
function buildRescueAction(
  cfg: AgentConfig,
  plan: RescuePlan,
  account: Address,
): CheckAndExecuteRequest["action"] {
  const repay = plan.kind === "repay";
  return {
    contractAddress: cfg.poolAddress,
    abi: JSON.stringify([repay ? REPAY_ABI_ITEM : SUPPLY_ABI_ITEM]),
    functionName: repay ? "repay" : "supply",
    functionArgs: JSON.stringify(
      repay
        ? [plan.asset, plan.amount.toString(), "2", account]
        : [plan.asset, plan.amount.toString(), account, "0"],
    ),
  };
}

/**
 * ERC-20 approve for the Pool, if needed. When the KeeperHub wallet address is
 * known we check its live allowance and skip a sufficient one; otherwise we
 * conservatively approve the exact plan amount every time.
 */
async function buildApproveIfNeeded(deps: Deps, plan: RescuePlan): Promise<ContractCallRequest | null> {
  const { cfg, web3 } = deps;
  if (cfg.executorAddress) {
    const allowance = await web3.readContract({
      address: plan.asset,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [cfg.executorAddress, cfg.poolAddress],
    });
    if (allowance >= plan.amount) return null;
  }
  return {
    chainId: cfg.chainId,
    contractAddress: plan.asset,
    abi: JSON.stringify([
      { ...ERC20_ABI[1], inputs: [...ERC20_ABI[1].inputs], outputs: [...ERC20_ABI[1].outputs] },
    ]),
    functionName: "approve",
    functionArgs: JSON.stringify([cfg.poolAddress, plan.amount.toString()]),
  };
}

async function executeRescue(deps: Deps, account: Address, plan: RescuePlan): Promise<void> {
  const { cfg, audit } = deps;
  if (!cfg.lensAddress) {
    console.warn(
      "execute: LENS_ADDRESS not set — cannot build the on-chain HF check; skipping execution",
    );
    return;
  }
  const request: CheckAndExecuteRequest = {
    chainId: cfg.chainId,
    ...buildCheck(cfg, account),
    action: buildRescueAction(cfg, plan, account),
  };
  const approve = await buildApproveIfNeeded(deps, plan);

  if (deps.dry) {
    if (!deps.client) {
      console.warn("execute (--dry): KH_API_KEY not set — cannot call the simulate API; skipping");
      return;
    }
    if (approve) {
      const sim = await deps.client.executeContractCall(approve, { simulate: true });
      audit.append(event("execute.simulated", account, { phase: "approve", simulation: sim.simulation }));
    }
    const sim = await deps.client.executeCheckAndExecute(request, { simulate: true });
    audit.append(
      event("execute.simulated", account, {
        phase: "rescue",
        kind: plan.kind,
        simulation: sim.simulation,
      }),
    );
    return;
  }

  if (!deps.executor) {
    console.warn("execute: KH_API_KEY not set — rescue planned but NOT executed");
    return;
  }
  // The idempotency key is derived from the label, so the label must encode
  // the INTENT — account, plan kind, asset, amount. A static label collides
  // with the previous rescue inside KeeperHub's 24h idempotency window and
  // 409s (idempotency_conflict) the moment the amount differs. Same intent
  // retried -> same key (safe replay); new rescue -> new key.
  const intent = `${account.slice(2, 10)}-${plan.kind}-${plan.assetSymbol}-${plan.amount}`;
  if (approve) {
    await deps.executor.runContractCall(approve, {
      account,
      label: `lifeline-approve-${intent}`,
    });
  }
  const status = await deps.executor.runCheckAndExecute(request, {
    account,
    label: `lifeline-rescue-${intent}`,
  });
  deps.state.lastRescueAt = Date.now();
  console.log(
    `execute: check-and-execute ${status.executionId} → ${status.state}` +
      (status.transactionHash ? ` (${status.transactionHash})` : ""),
  );
}

// ---------------------------------------------------------------------------
// Core evaluation (shared by webhook + poll loop)
// ---------------------------------------------------------------------------

function event(kind: AgentEvent["kind"], account: Address, detail: Record<string, unknown>): AgentEvent {
  return { ts: new Date().toISOString(), kind, account, detail };
}

interface AgentState {
  lastTick: string | null;
  lastRescueAt: number | null;
  busy: boolean;
  samples: Map<string, HfSample[]>;
}

interface Deps {
  cfg: AgentConfig;
  web3: Web3;
  audit: AuditLog;
  client: KeeperHubClient | null;
  executor: ReliableExecutor | null;
  state: AgentState;
  dry: boolean;
}

async function evaluate(deps: Deps, account: Address): Promise<void> {
  const { cfg, audit, state } = deps;
  if (state.busy) {
    console.log("evaluate: previous evaluation still running — skipping");
    return;
  }
  state.busy = true;
  try {
    const health = await readAccountHealth(deps.web3, cfg.poolAddress, account);
    state.lastTick = new Date().toISOString();

    const key = account.toLowerCase();
    const history = state.samples.get(key) ?? [];
    history.push({ ts: Date.now(), health });
    if (history.length > 100) history.splice(0, history.length - 100);
    state.samples.set(key, history);

    const trajectory = projectHf(history, cfg.horizonSeconds);
    audit.append(
      event("monitor.tick", account, {
        healthFactor: health.healthFactor,
        totalCollateralBase: health.totalCollateralBase,
        totalDebtBase: health.totalDebtBase,
        projected: trajectory.projected,
        secondsToLiquidation: Number.isFinite(trajectory.secondsToLiquidation)
          ? trajectory.secondsToLiquidation
          : "Infinity",
      }),
    );

    const projectedDanger =
      trajectory.projected < WAD ||
      (Number.isFinite(trajectory.secondsToLiquidation) &&
        trajectory.secondsToLiquidation <= cfg.horizonSeconds);
    const inDanger = health.healthFactor < cfg.hfWarn || projectedDanger;
    if (!inDanger) return;

    audit.append(
      event("detect.warning", account, {
        healthFactor: health.healthFactor,
        warnThreshold: cfg.hfWarn,
        projected: trajectory.projected,
        horizonSeconds: cfg.horizonSeconds,
        reason: health.healthFactor < cfg.hfWarn ? "hf-below-warn" : "projected-liquidation",
      }),
    );

    if (state.lastRescueAt && Date.now() - state.lastRescueAt < cfg.rescueCooldownMs) {
      console.log("evaluate: rescue cooldown active — not re-planning yet");
      return;
    }
    const market = await resolveMarket(deps);
    if (!market) {
      console.warn(
        "evaluate: DEBT_ASSET_* / COLLATERAL_ASSET_* env (or AAVE_ORACLE prices) missing — cannot plan a rescue",
      );
      return;
    }

    let plan: RescuePlan;
    try {
      plan = planRescue(health, market);
    } catch (err) {
      if (err instanceof PlanNotNeeded) {
        console.log(`evaluate: ${err.message}`);
        return;
      }
      throw err;
    }
    audit.append(
      event("plan.created", account, {
        kind: plan.kind,
        asset: plan.asset,
        assetSymbol: plan.assetSymbol,
        amount: plan.amount,
        costBase: plan.costBase,
        resultingHf: plan.resultingHf,
        rationale: plan.rationale,
      }),
    );

    await executeRescue(deps, account, plan);
  } finally {
    state.busy = false;
  }
}

// ---------------------------------------------------------------------------
// HTTP server: webhook + SSE + health
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(text);
}

function startServer(deps: Deps): void {
  const { cfg, audit } = deps;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch((err) => {
      console.error("http: handler error:", err);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: "internal error" });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost:${cfg.webhookPort}`);

    if (req.method === "POST" && url.pathname === "/hook/hf-alert") {
      // The KeeperHub workflow must present our shared secret.
      if (req.headers["x-lifeline-secret"] !== cfg.webhookSecret) {
        sendJson(res, 401, { ok: false, error: "invalid X-Lifeline-Secret" });
        return;
      }
      let body: { account?: string } = {};
      const raw = await readBody(req);
      if (raw.trim()) {
        try {
          body = JSON.parse(raw) as { account?: string };
        } catch {
          sendJson(res, 400, { ok: false, error: "invalid JSON body" });
          return;
        }
      }
      const account = (body.account ?? cfg.guardedAccount) as Address;
      if (!ADDRESS_RE.test(account)) {
        sendJson(res, 400, { ok: false, error: "account is not a 0x address" });
        return;
      }
      audit.append(event("monitor.webhook", account, { source: "keeperhub-workflow" }));
      // Fire-and-forget: the rescue may involve tx confirmation waits.
      void evaluate(deps, account).catch((err) => console.error("webhook evaluate failed:", err));
      sendJson(res, 202, { ok: true, account });
      return;
    }

    if (req.method === "GET" && url.pathname === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      for (const past of audit.getRecent()) res.write(`data: ${stringifyEvent(past)}\n\n`);
      const unsubscribe = audit.subscribe((e) => res.write(`data: ${stringifyEvent(e)}\n\n`));
      req.on("close", unsubscribe);
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, lastTick: deps.state.lastTick });
      return;
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      try {
        const html = readFileSync(new URL("../../dashboard/index.html", import.meta.url), "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
        res.end(html);
      } catch {
        sendJson(res, 404, { ok: false, error: "dashboard/index.html not found" });
      }
      return;
    }

    sendJson(res, 404, { ok: false, error: "not found" });
  }

  server.listen(cfg.webhookPort, () => {
    console.log(`lifeline: webhook/SSE server on http://localhost:${cfg.webhookPort}`);
  });
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const once = args.has("--once");
  const dry = args.has("--dry");

  loadDotEnv();
  const cfg = loadConfig();
  const audit = new AuditLog();
  const web3 = makeWeb3(cfg.rpcUrl);

  const client: KeeperHubClient | null = cfg.khApiKey
    ? new KeeperHubRestClient({ baseUrl: cfg.khBaseUrl, apiKey: cfg.khApiKey })
    : null;
  const executor = client
    ? new ReliableExecutor(client, { onEvent: (e: AgentEvent) => audit.append(e) })
    : null;
  if (!client) console.warn("lifeline: KH_API_KEY not set — monitoring only, no execution");
  if (dry) console.log("lifeline: --dry — all KeeperHub calls are simulate-only");

  const deps: Deps = {
    cfg,
    web3,
    audit,
    client,
    executor,
    state: { lastTick: null, lastRescueAt: null, busy: false, samples: new Map() },
    dry,
  };

  if (once) {
    await evaluate(deps, cfg.guardedAccount);
    console.log("lifeline: --once evaluation complete");
    return;
  }

  startServer(deps);
  // Belt-and-braces poll loop alongside the KeeperHub Block-trigger workflow.
  setInterval(() => {
    void evaluate(deps, cfg.guardedAccount).catch((err) =>
      console.error("poll evaluate failed:", err),
    );
  }, cfg.pollMs);
  void evaluate(deps, cfg.guardedAccount).catch((err) =>
    console.error("initial evaluate failed:", err),
  );
  console.log(
    `lifeline: guarding ${cfg.guardedAccount} on ${cfg.network} — poll every ${cfg.pollMs}ms, ` +
      `warn < ${cfg.hfWarn}, target ${cfg.hfTarget}`,
  );
}

main().catch((err) => {
  console.error("lifeline: fatal:", err);
  process.exit(1);
});
