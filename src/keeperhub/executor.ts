/**
 * ReliableExecutor — the reliability layer between the planner and KeeperHub.
 *
 * Guarantees, in order:
 *  (a) SIMULATE FIRST   — every execution is dry-run (simulate:true). A predicted
 *      revert short-circuits: nothing is broadcast, a failed status is returned.
 *  (b) IDEMPOTENT SENDS — deterministic Idempotency-Key = `${label}:${attempt}`.
 *      The attempt suffix only changes when we deliberately rotate to a fresh
 *      attempt, so accidental double-sends are impossible (24h server window).
 *  (c) VERIFIED RECEIPTS — success is only declared when receipts[0].verified
 *      is true AND receiptStatus === "success". An unverified "confirmed" is
 *      treated as not-yet-known and re-checked, never trusted.
 *  (d) TRANSIENT-AWARE RETRY — 429 / 5xx / network faults / poll timeouts /
 *      receipt timeout|not_found retry with the SAME key first (a safe re-poll:
 *      the server dedupes and returns the original execution), then rotate to a
 *      fresh attempt suffix. Backoff is quadratic: 1s / 4s / 9s per attempt.
 *      HTTP 409 idempotency_in_progress is never an error — we just re-poll the
 *      original execution's status. 409 idempotency_conflict (same key,
 *      different payload) is a hard programming error and throws.
 *  (e) FULL AUDIT TRAIL — an AgentEvent is emitted at every step via onEvent.
 */

import type {
  AgentEvent,
  CheckAndExecuteRequest,
  ContractCallRequest,
  ExecOptions,
  ExecutionStatus,
  KeeperHubClient,
  SimulationResult,
} from "../types.js";
import { KeeperHubError } from "./client.js";

/** Deterministic Idempotency-Key: attempt suffix ONLY changes on a fresh attempt. */
export function makeIdempotencyKey(label: string, attempt: number): string {
  return `${label}:${attempt}`;
}

export interface ExecutorContext {
  account: `0x${string}`;
  label: string;
}

export interface ReliableExecutorOptions {
  /** Fresh-key attempts (each also gets one safe same-key re-send). Default 3. */
  maxAttempts?: number;
  onEvent?: (e: AgentEvent) => void;
}

type SendFn = (opts: ExecOptions) => Promise<{ executionId?: string; simulation?: SimulationResult; raw: unknown }>;

/** Internal marker for "the outcome is not yet known — safe to retry". */
class TransientExecutionError extends Error {
  constructor(
    readonly reason: string,
    readonly status?: ExecutionStatus,
  ) {
    super(reason);
    this.name = "TransientExecutionError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function bodyExecutionId(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const direct = body.executionId ?? body.execution_id ?? body.id;
  if (typeof direct === "string" && direct.length > 0) return direct;
  if (isRecord(body.data)) return bodyExecutionId(body.data);
  if (isRecord(body.error)) return bodyExecutionId(body.error);
  return undefined;
}

function classifyTransient(err: unknown): { transient: boolean; reason: string } {
  if (err instanceof TransientExecutionError) return { transient: true, reason: err.reason };
  if (err instanceof KeeperHubError) {
    if (err.status === 429) return { transient: true, reason: `rate_limited (429): ${err.message}` };
    if (err.status >= 500) return { transient: true, reason: `server_error (${err.status}): ${err.message}` };
    if (err.status === 409 && err.code === "idempotency_in_progress") {
      return { transient: true, reason: "idempotency_in_progress" };
    }
    return { transient: false, reason: err.message };
  }
  if (err instanceof TypeError) {
    // global fetch throws TypeError on network failure
    return { transient: true, reason: `network_error: ${err.message}` };
  }
  if (err instanceof Error && (err.name === "AbortError" || /time.?out/i.test(err.message))) {
    return { transient: true, reason: `timeout: ${err.message}` };
  }
  return { transient: false, reason: err instanceof Error ? err.message : String(err) };
}

export class ReliableExecutor {
  private readonly maxAttempts: number;
  private readonly onEvent?: (e: AgentEvent) => void;

  /** Injectable for tests. Backoff is quadratic in attempt: 1s / 4s / 9s. */
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  constructor(
    private readonly client: KeeperHubClient,
    opts: ReliableExecutorOptions = {},
  ) {
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
    this.onEvent = opts.onEvent;
  }

  runContractCall(req: ContractCallRequest, ctx: ExecutorContext): Promise<ExecutionStatus> {
    return this.run((opts) => this.client.executeContractCall(req, opts), ctx);
  }

  runCheckAndExecute(req: CheckAndExecuteRequest, ctx: ExecutorContext): Promise<ExecutionStatus> {
    return this.run((opts) => this.client.executeCheckAndExecute(req, opts), ctx);
  }

  // ---------- core flow ----------

  private async run(send: SendFn, ctx: ExecutorContext): Promise<ExecutionStatus> {
    // (a) simulate first — never broadcast something we can already see reverting.
    const sim = await this.simulate(send, ctx);
    if (sim.result?.wouldRevert) {
      return {
        executionId: "",
        state: "failed",
        receipts: [],
        error: {
          code: "simulation_would_revert",
          message: sim.result.revertReason ?? "simulation predicted revert",
        },
        raw: sim.raw,
      };
    }

    let lastStatus: ExecutionStatus | undefined;
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const key = makeIdempotencyKey(ctx.label, attempt);
      // pass 0 = first send with this key; pass 1 = safe same-key re-send
      // (server-side idempotency dedupes, so this is effectively a re-poll).
      for (let pass = 0; pass < 2; pass++) {
        try {
          const status = await this.sendAndAwait(send, key, ctx, attempt);
          const r0 = status.receipts[0];

          // (d-gate) success requires a VERIFIED successful receipt.
          if (status.state === "confirmed" && r0?.verified === true && r0.receiptStatus === "success") {
            this.emit("execute.confirmed", ctx, {
              executionId: status.executionId,
              transactionHash: status.transactionHash,
              blockNumber: r0.blockNumber,
              gasUsed: r0.gasUsed,
              sponsored: status.sponsored,
              attempt,
              idempotencyKey: key,
            });
            return status;
          }

          // receipt timeout / not_found = outcome not yet knowable → transient, even if state says failed
          const receiptTransient = r0?.receiptStatus === "timeout" || r0?.receiptStatus === "not_found";

          // definitive on-chain failure — retrying would just fail again
          if (
            r0?.receiptStatus === "reverted" ||
            r0?.receiptStatus === "safe_inner_failure" ||
            (status.state === "failed" && !receiptTransient)
          ) {
            const failed: ExecutionStatus = { ...status, state: "failed" };
            this.emit("execute.failed", ctx, {
              executionId: status.executionId,
              receiptStatus: r0?.receiptStatus,
              error: status.error,
              attempt,
              idempotencyKey: key,
            });
            return failed;
          }

          // everything else — poll timeout ("unknown"), receipt timeout/not_found,
          // or a confirmed-but-unverified receipt — is a not-yet-known outcome.
          lastStatus = status;
          throw new TransientExecutionError(
            status.state === "unknown"
              ? "status_poll_timeout"
              : r0
                ? `receipt_${r0.receiptStatus}${r0.verified ? "" : "_unverified"}`
                : `state_${status.state}_without_receipt`,
            status,
          );
        } catch (err) {
          const { transient, reason } = classifyTransient(err);
          if (!transient) {
            this.emit("execute.failed", ctx, {
              reason,
              attempt,
              idempotencyKey: key,
              status: err instanceof KeeperHubError ? err.status : undefined,
              code: err instanceof KeeperHubError ? err.code : undefined,
            });
            throw err;
          }
          lastError = err;
          const exhausted = attempt === this.maxAttempts && pass === 1;
          if (!exhausted) {
            this.emit("execute.retry", ctx, {
              reason,
              attempt,
              idempotencyKey: key,
              nextKey: pass === 0 ? key : makeIdempotencyKey(ctx.label, attempt + 1),
              sameKeyRepoll: pass === 0,
              backoffMs: attempt * attempt * 1000,
            });
            await this.sleep(attempt * attempt * 1000); // 1s / 4s / 9s
          }
        }
      }
    }

    // exhausted every attempt without a definitive outcome
    this.emit("execute.failed", ctx, {
      reason: "max_attempts_exhausted",
      attempts: this.maxAttempts,
      lastError: lastError instanceof Error ? lastError.message : String(lastError ?? "unknown"),
      lastExecutionId: lastStatus?.executionId,
    });
    if (lastStatus) {
      // never report an unverified execution as confirmed
      return lastStatus.state === "confirmed" ? { ...lastStatus, state: "unknown" } : lastStatus;
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("ReliableExecutor: all attempts failed with no execution status");
  }

  /**
   * Simulation with its own transient-retry loop. Fails CLOSED on a predicted
   * revert, but fails OPEN if the simulation infrastructure itself is down —
   * the on-chain check in check-and-execute is the real safety gate, and a
   * liquidation rescue must not be blocked by a flaky dry-run endpoint.
   */
  private async simulate(
    send: SendFn,
    ctx: ExecutorContext,
  ): Promise<{ result?: SimulationResult; raw?: unknown }> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const res = await send({ simulate: true });
        this.emit("execute.simulated", ctx, {
          wouldRevert: res.simulation?.wouldRevert ?? false,
          revertReason: res.simulation?.revertReason,
          gasEstimate: res.simulation?.gasEstimate,
        });
        return { result: res.simulation, raw: res.raw };
      } catch (err) {
        const { transient, reason } = classifyTransient(err);
        if (!transient) {
          this.emit("execute.failed", ctx, { phase: "simulate", reason });
          throw err;
        }
        if (attempt === this.maxAttempts) {
          this.emit("execute.simulated", ctx, { skipped: true, reason, wouldRevert: false });
          return {};
        }
        this.emit("execute.retry", ctx, { phase: "simulate", reason, attempt, backoffMs: attempt * attempt * 1000 });
        await this.sleep(attempt * attempt * 1000);
      }
    }
    return {}; // unreachable
  }

  /** One send (idempotent) + one full status wait. 409 in_progress → re-poll. */
  private async sendAndAwait(
    send: SendFn,
    key: string,
    ctx: ExecutorContext,
    attempt: number,
  ): Promise<ExecutionStatus> {
    let executionId: string | undefined;
    try {
      const res = await send({ idempotencyKey: key });
      executionId = res.executionId;
      this.emit("execute.submitted", ctx, { executionId, attempt, idempotencyKey: key });
    } catch (err) {
      if (err instanceof KeeperHubError && err.status === 409 && err.code === "idempotency_in_progress") {
        // Original send is still running server-side — never a failure.
        executionId = bodyExecutionId(err.body);
        if (executionId === undefined) {
          // Can't locate the in-flight execution: back off and re-send same key.
          throw new TransientExecutionError("idempotency_in_progress_without_id");
        }
        this.emit("execute.submitted", ctx, {
          executionId,
          attempt,
          idempotencyKey: key,
          deduplicated: true,
        });
      } else {
        throw err; // classified by the caller
      }
    }

    if (executionId === undefined) {
      // 2xx without an id — outcome unknowable; safe to re-send under same key.
      throw new TransientExecutionError("response_missing_execution_id");
    }
    return this.client.waitForExecution(executionId);
  }

  private emit(kind: AgentEvent["kind"], ctx: ExecutorContext, detail: Record<string, unknown>): void {
    if (!this.onEvent) return;
    try {
      this.onEvent({
        ts: new Date().toISOString(),
        kind,
        account: ctx.account,
        detail: { label: ctx.label, ...detail },
      });
    } catch {
      /* an audit listener must never break an execution */
    }
  }
}
