/**
 * PINNED SHARED TYPES — every module codes against these.
 * Do not change shapes without updating all consumers (keeperhub/, planner/, agent/, scripts/).
 */

// ---------- Aave domain ----------

/** Raw return of IPool.getUserAccountData — base-currency values are 8-decimal USD, healthFactor is 1e18-scaled. */
export interface AccountHealth {
  totalCollateralBase: bigint;
  totalDebtBase: bigint;
  availableBorrowsBase: bigint;
  currentLiquidationThreshold: bigint; // bps
  ltv: bigint; // bps
  healthFactor: bigint; // 1e18; type(uint256).max when no debt
}

/** Projected trajectory of the health factor. */
export interface HfTrajectory {
  current: bigint; // 1e18
  /** Projected HF in `horizonSeconds`, from borrow-rate drift + recent collateral price volatility. */
  projected: bigint; // 1e18
  horizonSeconds: number;
  /** Seconds until HF crosses 1.0 at current drift, Infinity if not falling. */
  secondsToLiquidation: number;
}

export type RescueKind = "repay" | "supply";

export interface RescuePlan {
  kind: RescueKind;
  /** ERC-20 the action spends (repay: debt asset; supply: collateral asset). */
  asset: `0x${string}`;
  assetSymbol: string;
  assetDecimals: number;
  /** Raw token amount for the action. */
  amount: bigint;
  /** HF this plan restores (1e18). */
  resultingHf: bigint;
  /** USD cost at 8 decimals (base currency units actually spent). */
  costBase: bigint;
  rationale: string;
}

// ---------- KeeperHub client ----------

export interface KeeperHubConfig {
  baseUrl: string; // https://app.keeperhub.com
  apiKey: string; // kh_...
}

/** Common options for direct executions. */
export interface ExecOptions {
  /** Dry-run: gas estimate + wouldRevert without broadcasting. */
  simulate?: boolean;
  /** Sent as Idempotency-Key header (24h window, per-org). */
  idempotencyKey?: string;
  gasLimitMultiplier?: number;
}

/**
 * Shapes below mirror the AUTHORITATIVE validators in the KeeperHub source:
 * app/api/execute/_lib/schemas.ts + check-and-execute/route.ts (staging).
 * Direct-execution REST uses `functionName` — `abiFunction` exists only in
 * workflow web3 node configs. `chainId` (numeric) is canonical; `network` is
 * a deprecated alias (KEEP-490).
 */
export interface ContractCallRequest {
  chainId: number; // canonical (11155111 Sepolia, 8453 Base)
  contractAddress: `0x${string}`;
  /**
   * JSON-encoded ABI STRING. Optional: the API auto-resolves verified ABIs
   * from its explorer cache — our freshly deployed lens must pass it explicitly.
   */
  abi?: string;
  functionName: string;
  /** JSON-encoded array STRING, e.g. '["0x..","100"]'. */
  functionArgs?: string;
  /**
   * Native value in ETHER units (NOT wei): the API parses it with
   * ethers.parseEther (lib/execute/native-value.ts) — "0.001" = 0.001 ETH.
   * Charged against the org's daily value cap (contract-call only).
   */
  value?: string;
  priorityFeeGwei?: string;
}

/**
 * check-and-execute: condition re-verified ON-CHAIN at execution time.
 * FLAT layout — the check's contract/function sit at the top level, with the
 * write nested under `action`. The condition evaluator BigInt-compares a
 * SINGLE-output view only (multi-output views degrade to string eq/neq),
 * which is exactly why HealthFactorLens exists.
 * NOTE: the action leg never forwards native value (route calls
 * writeContractCore without ethValue) — keep actions ERC-20-only.
 */
export interface CheckAndExecuteRequest {
  chainId: number;
  contractAddress: `0x${string}`; // the CHECK view contract (our lens)
  abi?: string;
  functionName: string; // view returning a single uint256
  functionArgs?: string;
  condition: {
    operator: "eq" | "neq" | "gt" | "lt" | "gte" | "lte";
    value: string; // decimal string, BigInt-compared against the observed value
  };
  action: {
    contractAddress: `0x${string}`;
    abi?: string;
    functionName: string;
    functionArgs?: string;
  };
}

export interface SimulationResult {
  wouldRevert: boolean;
  revertReason?: string;
  gasEstimate?: string;
}

export interface Receipt {
  verified: boolean;
  receiptStatus: "success" | "reverted" | "safe_inner_failure" | "not_found" | "timeout";
  transactionHash?: `0x${string}`;
  blockNumber?: number;
  gasUsed?: string;
}

export type ExecutionState = "pending" | "submitted" | "confirmed" | "failed" | "unknown";

export interface ExecutionStatus {
  executionId: string;
  state: ExecutionState;
  transactionHash?: `0x${string}`;
  receipts: Receipt[];
  sponsored?: boolean;
  error?: { code: string; message: string };
  /** Raw API payload for observability. */
  raw: unknown;
}

/**
 * REST client over app.keeperhub.com. Implemented in src/keeperhub/client.ts.
 * All methods throw KeeperHubError (with .status and .code) on non-2xx.
 */
export interface KeeperHubClient {
  listChains(): Promise<unknown[]>;
  executeContractCall(req: ContractCallRequest, opts?: ExecOptions): Promise<{ executionId?: string; simulation?: SimulationResult; raw: unknown }>;
  executeCheckAndExecute(req: CheckAndExecuteRequest, opts?: ExecOptions): Promise<{ executionId?: string; simulation?: SimulationResult; raw: unknown }>;
  /** Polls GET /api/execute/{id}/status honoring X-Poll-Interval-Hint until terminal (hint 0) or timeout. */
  waitForExecution(executionId: string, timeoutMs?: number): Promise<ExecutionStatus>;
  createWorkflow(definition: unknown): Promise<{ id: string; raw: unknown }>;
  executeWorkflow(id: string, input?: unknown): Promise<{ executionId: string; raw: unknown }>;
  getAnalyticsRuns(params?: Record<string, string>): Promise<unknown>;
}

// ---------- Agent / audit events ----------

/** Every step the agent takes is appended to the local audit log and re-emitted over SSE by the dashboard. */
export interface AgentEvent {
  ts: string; // ISO
  kind:
    | "monitor.tick"
    | "monitor.webhook"
    | "detect.warning"
    | "plan.created"
    | "execute.simulated"
    | "execute.submitted"
    | "execute.confirmed"
    | "execute.retry"
    | "execute.failed";
  account: `0x${string}`;
  detail: Record<string, unknown>;
}
