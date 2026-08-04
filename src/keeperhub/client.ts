/**
 * KeeperHub REST client — implements the pinned KeeperHubClient contract from src/types.ts.
 *
 * Endpoints (verified against KeeperHub docs):
 *   GET  /api/chains                        — authoritative chain list
 *   POST /api/execute/contract-call         — direct contract execution (supports simulate:true)
 *   POST /api/execute/check-and-execute     — on-chain-condition-gated execution
 *   GET  /api/execute/{id}/status           — poll with X-Poll-Interval-Hint header (0 = terminal)
 *   POST /api/workflows/create
 *   POST /api/workflows/{id}/execute
 *   GET  /api/analytics/runs                — run analytics (params as query string)
 *
 * Auth: Authorization: Bearer kh_... on every request.
 * Idempotency-Key header supported on execute endpoints (24h window, per-org).
 */

import type {
  CheckAndExecuteRequest,
  ContractCallRequest,
  ExecOptions,
  ExecutionState,
  ExecutionStatus,
  KeeperHubClient,
  KeeperHubConfig,
  Receipt,
  SimulationResult,
} from "../types.js";

const DEFAULT_WAIT_TIMEOUT_MS = 180_000;
const FALLBACK_POLL_MS = 3_000;
const MAX_POLL_MS = 15_000;

/** Thrown by every client method on a non-2xx response (and on malformed 2xx payloads). */
export class KeeperHubError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly body: unknown;

  constructor(message: string, status: number, code: string | undefined, body: unknown) {
    super(message);
    this.name = "KeeperHubError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

// ---------- defensive payload helpers ----------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Parse an error envelope without assuming its exact shape. */
export function parseErrorEnvelope(status: number, body: unknown): { code?: string; message: string } {
  if (isRecord(body)) {
    const nested = isRecord(body.error) ? body.error : undefined;
    const code =
      (nested && typeof nested.code === "string" && nested.code) ||
      (typeof body.code === "string" && body.code) ||
      undefined;
    const message =
      (nested && typeof nested.message === "string" && nested.message) ||
      (typeof body.error === "string" && body.error) ||
      (typeof body.message === "string" && body.message) ||
      `KeeperHub request failed (HTTP ${status})`;
    return { code, message };
  }
  if (typeof body === "string" && body.trim().length > 0) {
    return { message: body.slice(0, 500) };
  }
  return { message: `KeeperHub request failed (HTTP ${status})` };
}

/** executionId may live at .executionId, .id, .data.executionId, or .data.id — normalize. */
function extractExecutionId(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const direct = payload.executionId ?? payload.id;
  if (typeof direct === "string" && direct.length > 0) return direct;
  if (typeof direct === "number") return String(direct);
  if (isRecord(payload.data)) return extractExecutionId(payload.data);
  return undefined;
}

/** Simulation payload may be nested under .simulation / .data, or spread at the top level. */
function extractSimulation(payload: unknown): SimulationResult | undefined {
  if (!isRecord(payload)) return undefined;
  const candidates: unknown[] = [payload.simulation, isRecord(payload.data) ? payload.data.simulation : undefined, payload];
  for (const c of candidates) {
    if (isRecord(c) && typeof c.wouldRevert === "boolean") {
      return {
        wouldRevert: c.wouldRevert,
        revertReason: typeof c.revertReason === "string" ? c.revertReason : undefined,
        gasEstimate:
          typeof c.gasEstimate === "string"
            ? c.gasEstimate
            : typeof c.gasEstimate === "number"
              ? String(c.gasEstimate)
              : undefined,
      };
    }
  }
  return undefined;
}

const RECEIPT_STATUSES: ReadonlySet<string> = new Set([
  "success",
  "reverted",
  "safe_inner_failure",
  "not_found",
  "timeout",
]);

function normalizeReceipt(r: unknown): Receipt {
  const rec = isRecord(r) ? r : {};
  const rawStatus = typeof rec.receiptStatus === "string" ? rec.receiptStatus : undefined;
  return {
    verified: rec.verified === true,
    receiptStatus: (rawStatus && RECEIPT_STATUSES.has(rawStatus) ? rawStatus : "not_found") as Receipt["receiptStatus"],
    transactionHash:
      typeof rec.transactionHash === "string" && rec.transactionHash.startsWith("0x")
        ? (rec.transactionHash as `0x${string}`)
        : undefined,
    blockNumber:
      typeof rec.blockNumber === "number"
        ? rec.blockNumber
        : typeof rec.blockNumber === "string" && rec.blockNumber !== ""
          ? Number(rec.blockNumber)
          : undefined,
    gasUsed: rec.gasUsed != null ? String(rec.gasUsed) : undefined,
  };
}

/** Map whatever state string the API returns onto the pinned ExecutionState union. */
export function normalizeState(raw: string | undefined): ExecutionState | undefined {
  switch (raw?.toLowerCase()) {
    case "pending":
    case "queued":
    case "created":
    case "accepted":
    case "scheduled":
      return "pending";
    case "submitted":
    case "broadcast":
    case "broadcasting":
    case "processing":
    case "in_progress":
    case "inflight":
    case "sent":
    case "relayed":
      return "submitted";
    case "confirmed":
    case "success":
    case "succeeded":
    case "completed":
    case "executed":
    case "mined":
    case "finalized":
      return "confirmed";
    case "failed":
    case "failure":
    case "error":
    case "reverted":
    case "rejected":
    case "cancelled":
    case "canceled":
    case "expired":
      return "failed";
    default:
      return undefined;
  }
}

/** Map a status payload onto the pinned ExecutionStatus, inferring state from receipts when ambiguous. */
export function mapExecutionStatus(executionId: string, payload: unknown): ExecutionStatus {
  const top = isRecord(payload) ? payload : {};
  const d = isRecord(top.data) ? top.data : top;

  const receipts = Array.isArray(d.receipts) ? d.receipts.map(normalizeReceipt) : [];
  const rawState =
    (typeof d.state === "string" && d.state) || (typeof d.status === "string" && d.status) || undefined;
  let state = normalizeState(rawState);
  if (state === undefined) {
    const r0 = receipts[0];
    if (r0?.receiptStatus === "success") state = "confirmed";
    else if (r0?.receiptStatus === "reverted" || r0?.receiptStatus === "safe_inner_failure") state = "failed";
    else state = "pending";
  }

  const txHash =
    typeof d.transactionHash === "string" && d.transactionHash.startsWith("0x")
      ? (d.transactionHash as `0x${string}`)
      : receipts[0]?.transactionHash;

  let error: ExecutionStatus["error"];
  if (isRecord(d.error)) {
    error = {
      code: typeof d.error.code === "string" ? d.error.code : "unknown",
      message: typeof d.error.message === "string" ? d.error.message : JSON.stringify(d.error),
    };
  } else if (typeof d.error === "string" && d.error.length > 0) {
    error = { code: "unknown", message: d.error };
  }

  return {
    executionId: extractExecutionId(payload) ?? executionId,
    state,
    transactionHash: txHash,
    receipts,
    sponsored: typeof d.sponsored === "boolean" ? d.sponsored : undefined,
    error,
    raw: payload,
  };
}

// ---------- client ----------

export class KeeperHubRestClient implements KeeperHubClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  /** Injectable for tests (poll-interval assertions without real waiting). */
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  constructor(config: KeeperHubConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    opts?: { body?: unknown; headers?: Record<string, string> },
  ): Promise<{ payload: unknown; res: Response }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      ...(opts?.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(opts?.headers ?? {}),
    };
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

    let payload: unknown;
    const text = await res.text();
    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }

    if (!res.ok) {
      const { code, message } = parseErrorEnvelope(res.status, payload);
      throw new KeeperHubError(message, res.status, code, payload);
    }
    return { payload, res };
  }

  async listChains(): Promise<unknown[]> {
    const { payload } = await this.request("GET", "/api/chains");
    if (Array.isArray(payload)) return payload;
    if (isRecord(payload)) {
      if (Array.isArray(payload.chains)) return payload.chains;
      if (Array.isArray(payload.data)) return payload.data;
    }
    return payload === undefined ? [] : [payload];
  }

  private async execute(
    path: string,
    req: ContractCallRequest | CheckAndExecuteRequest,
    opts?: ExecOptions,
  ): Promise<{ executionId?: string; simulation?: SimulationResult; raw: unknown }> {
    const body: Record<string, unknown> = { ...req };
    if (opts?.simulate !== undefined) body.simulate = opts.simulate;
    if (opts?.gasLimitMultiplier !== undefined) body.gasLimitMultiplier = opts.gasLimitMultiplier;

    const headers = opts?.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : undefined;
    const { payload } = await this.request("POST", path, { body, headers });
    return {
      executionId: extractExecutionId(payload),
      simulation: extractSimulation(payload),
      raw: payload,
    };
  }

  executeContractCall(
    req: ContractCallRequest,
    opts?: ExecOptions,
  ): Promise<{ executionId?: string; simulation?: SimulationResult; raw: unknown }> {
    return this.execute("/api/execute/contract-call", req, opts);
  }

  executeCheckAndExecute(
    req: CheckAndExecuteRequest,
    opts?: ExecOptions,
  ): Promise<{ executionId?: string; simulation?: SimulationResult; raw: unknown }> {
    return this.execute("/api/execute/check-and-execute", req, opts);
  }

  /**
   * Poll GET /api/execute/{id}/status until terminal.
   * Terminal = X-Poll-Interval-Hint header of 0, or a confirmed/failed state.
   * Next poll delay = hint seconds (fallback 3s when absent/invalid, capped at 15s).
   * Transient poll errors (429/5xx) are absorbed inside the window; timeout -> state "unknown".
   */
  async waitForExecution(executionId: string, timeoutMs: number = DEFAULT_WAIT_TIMEOUT_MS): Promise<ExecutionStatus> {
    const deadline = Date.now() + timeoutMs;
    let lastRaw: unknown;

    for (;;) {
      let payload: unknown;
      let res: Response;
      try {
        ({ payload, res } = await this.request("GET", `/api/execute/${encodeURIComponent(executionId)}/status`));
      } catch (err) {
        if (err instanceof KeeperHubError && (err.status === 429 || err.status >= 500)) {
          // transient poll failure — keep polling until the window closes
          lastRaw = err.body ?? lastRaw;
          if (Date.now() + FALLBACK_POLL_MS >= deadline) {
            return {
              executionId,
              state: "unknown",
              receipts: [],
              error: { code: err.code ?? "poll_failed", message: err.message },
              raw: lastRaw,
            };
          }
          await this.sleep(FALLBACK_POLL_MS);
          continue;
        }
        throw err;
      }

      lastRaw = payload;
      const status = mapExecutionStatus(executionId, payload);

      const hintHeader = res.headers.get("X-Poll-Interval-Hint");
      const hint = hintHeader === null || hintHeader.trim() === "" ? undefined : Number(hintHeader);
      const terminal = hint === 0 || status.state === "confirmed" || status.state === "failed";
      if (terminal) return status;

      const remaining = deadline - Date.now();
      if (remaining <= 0) return { ...status, state: "unknown" };

      const waitMs =
        hint !== undefined && Number.isFinite(hint) && hint > 0 ? Math.min(hint * 1000, MAX_POLL_MS) : FALLBACK_POLL_MS;
      await this.sleep(Math.min(waitMs, remaining));
    }
  }

  async createWorkflow(definition: unknown): Promise<{ id: string; raw: unknown }> {
    const { payload, res } = await this.request("POST", "/api/workflows/create", { body: definition });
    let id: string | undefined;
    if (isRecord(payload)) {
      const direct = payload.id ?? payload.workflowId ?? (isRecord(payload.data) ? (payload.data.id ?? payload.data.workflowId) : undefined);
      if (typeof direct === "string" && direct.length > 0) id = direct;
      else if (typeof direct === "number") id = String(direct);
    }
    if (id === undefined) {
      throw new KeeperHubError("workflow create response missing id", res.status, "malformed_response", payload);
    }
    return { id, raw: payload };
  }

  async executeWorkflow(id: string, input?: unknown): Promise<{ executionId: string; raw: unknown }> {
    const { payload, res } = await this.request("POST", `/api/workflows/${encodeURIComponent(id)}/execute`, {
      body: input ?? {},
    });
    const executionId = extractExecutionId(payload);
    if (executionId === undefined) {
      throw new KeeperHubError("workflow execute response missing executionId", res.status, "malformed_response", payload);
    }
    return { executionId, raw: payload };
  }

  async getAnalyticsRuns(params?: Record<string, string>): Promise<unknown> {
    const qs = params && Object.keys(params).length > 0 ? `?${new URLSearchParams(params).toString()}` : "";
    const { payload } = await this.request("GET", `/api/analytics/runs${qs}`);
    return payload;
  }
}
