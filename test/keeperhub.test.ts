/**
 * Unit tests for src/keeperhub/ — global fetch is mocked, NO live network calls.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { KeeperHubError, KeeperHubRestClient } from "../src/keeperhub/client.js";
import { makeIdempotencyKey, ReliableExecutor } from "../src/keeperhub/executor.js";
import type { AgentEvent, CheckAndExecuteRequest, ContractCallRequest } from "../src/types.js";

// ---------- fetch mock ----------

interface MockResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

function installFetch(queue: MockResponse[]): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      const next = queue.shift();
      if (!next) throw new Error("mock fetch queue exhausted — unexpected extra request");
      return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
        status: next.status ?? 200,
        headers: next.headers,
      });
    }),
  );
  return calls;
}

function makeClient(): KeeperHubRestClient {
  const client = new KeeperHubRestClient({ baseUrl: "https://app.keeperhub.com", apiKey: "kh_test_key" });
  client.sleep = async () => {}; // never actually wait in tests
  return client;
}

const ACCOUNT = "0x1111111111111111111111111111111111111111" as const;

const CALL_REQ: ContractCallRequest = {
  chainId: 11155111,
  contractAddress: "0x2222222222222222222222222222222222222222",
  abi: '[{"type":"function","name":"repay","inputs":[]}]',
  functionName: "repay",
  functionArgs: '["0x3333333333333333333333333333333333333333","1000000"]',
};

// Flat layout per app/api/execute/_lib/schemas.ts: check fields top-level,
// condition {operator, value}, write nested under action.
const CHECK_REQ: CheckAndExecuteRequest = {
  chainId: 11155111,
  contractAddress: "0x4444444444444444444444444444444444444444",
  abi: '[{"type":"function","name":"healthFactorOf","inputs":[],"outputs":[{"type":"uint256"}]}]',
  functionName: "healthFactorOf",
  functionArgs: `["${ACCOUNT}"]`,
  condition: {
    operator: "lt",
    value: "1100000000000000000",
  },
  action: {
    contractAddress: CALL_REQ.contractAddress,
    abi: CALL_REQ.abi,
    functionName: CALL_REQ.functionName,
    functionArgs: CALL_REQ.functionArgs,
  },
};

const CONFIRMED_STATUS: MockResponse = {
  body: {
    executionId: "ex-1",
    state: "confirmed",
    receipts: [
      {
        verified: true,
        receiptStatus: "success",
        transactionHash: "0xdeadbeef",
        blockNumber: 123,
        gasUsed: "21000",
      },
    ],
  },
  headers: { "X-Poll-Interval-Hint": "0" },
};

const TIMEOUT_STATUS: MockResponse = {
  body: {
    executionId: "ex-1",
    state: "submitted",
    receipts: [{ verified: false, receiptStatus: "timeout" }],
  },
  headers: { "X-Poll-Interval-Hint": "0" },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------- client ----------

describe("KeeperHubRestClient", () => {
  it("sends the Authorization Bearer header on every request", async () => {
    const calls = installFetch([{ body: { chains: [{ id: 11155111 }] } }]);
    const chains = await makeClient().listChains();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://app.keeperhub.com/api/chains");
    expect(calls[0].headers.Authorization).toBe("Bearer kh_test_key");
    expect(chains).toEqual([{ id: 11155111 }]);
  });

  it("passes functionName/functionArgs through untouched and sets simulate + Idempotency-Key", async () => {
    const calls = installFetch([{ body: { executionId: "ex-9" } }]);
    const res = await makeClient().executeContractCall(CALL_REQ, {
      simulate: true,
      idempotencyKey: "rescue:1",
      gasLimitMultiplier: 1.2,
    });

    expect(calls[0].url).toBe("https://app.keeperhub.com/api/execute/contract-call");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers["Idempotency-Key"]).toBe("rescue:1");
    const body = calls[0].body as Record<string, unknown>;
    // Real schema per app/api/execute/_lib/schemas.ts: functionName + numeric chainId.
    expect(body.functionName).toBe("repay");
    expect(body.chainId).toBe(11155111);
    expect(body.functionArgs).toBe(CALL_REQ.functionArgs); // JSON-encoded array STRING, not re-parsed
    expect(body.abi).toBe(CALL_REQ.abi); // JSON-encoded string
    expect(body.simulate).toBe(true);
    expect(body.gasLimitMultiplier).toBe(1.2);
    expect(res.executionId).toBe("ex-9");
  });

  it("throws KeeperHubError with status/code parsed from the error envelope", async () => {
    installFetch([{ status: 409, body: { error: { code: "idempotency_conflict", message: "key reused" } } }]);
    const err = await makeClient()
      .executeContractCall(CALL_REQ)
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(KeeperHubError);
    expect((err as KeeperHubError).status).toBe(409);
    expect((err as KeeperHubError).code).toBe("idempotency_conflict");
    expect((err as KeeperHubError).message).toBe("key reused");
  });

  it("normalizes executionId from nested payload shapes", async () => {
    installFetch([{ body: { data: { executionId: "ex-nested" } } }]);
    const res = await makeClient().executeCheckAndExecute(CHECK_REQ);
    expect(res.executionId).toBe("ex-nested");
  });

  it("honors X-Poll-Interval-Hint (seconds, fallback 3s, cap 15s, 0 = terminal)", async () => {
    installFetch([
      { body: { state: "pending" }, headers: { "X-Poll-Interval-Hint": "7" } },
      { body: { state: "pending" }, headers: { "X-Poll-Interval-Hint": "60" } },
      { body: { state: "pending" } }, // no hint header
      { body: { state: "pending" }, headers: { "X-Poll-Interval-Hint": "0" } }, // hint 0 = terminal
    ]);
    const client = makeClient();
    const sleeps: number[] = [];
    client.sleep = async (ms) => {
      sleeps.push(ms);
    };

    const status = await client.waitForExecution("ex-1");

    expect(sleeps).toEqual([7000, 15000, 3000]); // hint*1000, capped, fallback
    expect(status.state).toBe("pending"); // hint 0 ended polling even though state was non-terminal
    expect(status.executionId).toBe("ex-1");
  });

  it("maps receipts through and stops on confirmed state", async () => {
    installFetch([CONFIRMED_STATUS]);
    const status = await makeClient().waitForExecution("ex-1");

    expect(status.state).toBe("confirmed");
    expect(status.receipts).toHaveLength(1);
    expect(status.receipts[0]).toMatchObject({
      verified: true,
      receiptStatus: "success",
      transactionHash: "0xdeadbeef",
      blockNumber: 123,
      gasUsed: "21000",
    });
    expect(status.transactionHash).toBe("0xdeadbeef");
  });
});

// ---------- executor ----------

function makeExecutor(events: AgentEvent[], maxAttempts?: number) {
  const client = makeClient();
  const executor = new ReliableExecutor(client, {
    maxAttempts,
    onEvent: (e) => events.push(e),
  });
  executor.sleep = async () => {}; // no real backoff waits in tests
  return executor;
}

function idempotencyKeysOf(calls: RecordedCall[]): (string | undefined)[] {
  return calls
    .filter((c) => c.method === "POST" && c.url.includes("/api/execute/"))
    .map((c) => c.headers["Idempotency-Key"]);
}

describe("makeIdempotencyKey", () => {
  it("is deterministic: label + ':' + attempt", () => {
    expect(makeIdempotencyKey("rescue-0x1-repay", 1)).toBe("rescue-0x1-repay:1");
    expect(makeIdempotencyKey("rescue-0x1-repay", 2)).toBe("rescue-0x1-repay:2");
  });
});

describe("ReliableExecutor", () => {
  it("short-circuits on simulated revert WITHOUT broadcasting", async () => {
    const calls = installFetch([{ body: { simulation: { wouldRevert: true, revertReason: "HF_ABOVE_THRESHOLD" } } }]);
    const events: AgentEvent[] = [];
    const executor = makeExecutor(events);

    const status = await executor.runCheckAndExecute(CHECK_REQ, { account: ACCOUNT, label: "rescue" });

    expect(calls).toHaveLength(1); // ONLY the simulate call — nothing was broadcast
    expect((calls[0].body as Record<string, unknown>).simulate).toBe(true);
    expect(calls[0].headers["Idempotency-Key"]).toBeUndefined(); // dry-run carries no key
    expect(status.state).toBe("failed");
    expect(status.error?.code).toBe("simulation_would_revert");
    expect(status.error?.message).toBe("HF_ABOVE_THRESHOLD");

    const simEvent = events.find((e) => e.kind === "execute.simulated");
    expect(simEvent?.detail.wouldRevert).toBe(true);
    expect(simEvent?.detail.revertReason).toBe("HF_ABOVE_THRESHOLD");
    expect(events.some((e) => e.kind === "execute.submitted")).toBe(false);
  });

  it("retries on 500 with the SAME idempotency key, then succeeds", async () => {
    const calls = installFetch([
      { body: { simulation: { wouldRevert: false, gasEstimate: "150000" } } }, // simulate
      { status: 500, body: { error: { message: "upstream exploded" } } }, // send #1 → transient
      { body: { executionId: "ex-1" } }, // send #2, same key
      CONFIRMED_STATUS, // status poll
    ]);
    const events: AgentEvent[] = [];
    const executor = makeExecutor(events);

    const status = await executor.runContractCall(CALL_REQ, { account: ACCOUNT, label: "rescue" });

    expect(status.state).toBe("confirmed");
    // simulate has no key; both real sends reuse rescue:1 — safe server-side dedupe
    expect(idempotencyKeysOf(calls)).toEqual([undefined, "rescue:1", "rescue:1"]);
    expect(events.filter((e) => e.kind === "execute.retry")).toHaveLength(1);
    expect(events.at(-1)?.kind).toBe("execute.confirmed");
  });

  it("keeps the key stable across the same-key re-poll and rotates it on a fresh attempt", async () => {
    const calls = installFetch([
      { body: { simulation: { wouldRevert: false } } }, // simulate
      { body: { executionId: "ex-1" } }, // attempt 1, pass 0
      TIMEOUT_STATUS, // → transient (receipt timeout)
      { body: { executionId: "ex-1" } }, // attempt 1, pass 1 (SAME key)
      TIMEOUT_STATUS, // → transient again
      { body: { executionId: "ex-2" } }, // attempt 2 (ROTATED key)
      { ...CONFIRMED_STATUS, body: { ...(CONFIRMED_STATUS.body as object), executionId: "ex-2" } },
    ]);
    const events: AgentEvent[] = [];
    const executor = makeExecutor(events);

    const status = await executor.runContractCall(CALL_REQ, { account: ACCOUNT, label: "guard" });

    expect(status.state).toBe("confirmed");
    expect(status.executionId).toBe("ex-2");
    expect(idempotencyKeysOf(calls)).toEqual([undefined, "guard:1", "guard:1", "guard:2"]);
    expect(events.filter((e) => e.kind === "execute.retry")).toHaveLength(2);
  });

  it("never reports success without a VERIFIED successful receipt", async () => {
    const unverified: MockResponse = {
      body: {
        executionId: "ex-1",
        state: "confirmed",
        receipts: [{ verified: false, receiptStatus: "success" }],
      },
      headers: { "X-Poll-Interval-Hint": "0" },
    };
    installFetch([
      { body: { simulation: { wouldRevert: false } } },
      { body: { executionId: "ex-1" } },
      unverified,
      { body: { executionId: "ex-1" } }, // same-key re-poll
      unverified, // still unverified → attempts exhausted (maxAttempts 1)
    ]);
    const events: AgentEvent[] = [];
    const executor = makeExecutor(events, 1);

    const status = await executor.runContractCall(CALL_REQ, { account: ACCOUNT, label: "gate" });

    expect(status.state).toBe("unknown"); // downgraded — never "confirmed" while unverified
    expect(events.some((e) => e.kind === "execute.confirmed")).toBe(false);
    expect(events.at(-1)?.kind).toBe("execute.failed");
    expect(events.at(-1)?.detail.reason).toBe("max_attempts_exhausted");
  });

  it("returns a definitive failure without retrying when the receipt says reverted", async () => {
    const calls = installFetch([
      { body: { simulation: { wouldRevert: false } } },
      { body: { executionId: "ex-1" } },
      {
        body: {
          executionId: "ex-1",
          state: "confirmed",
          receipts: [{ verified: true, receiptStatus: "reverted", transactionHash: "0xbad" }],
        },
        headers: { "X-Poll-Interval-Hint": "0" },
      },
    ]);
    const events: AgentEvent[] = [];
    const executor = makeExecutor(events);

    const status = await executor.runContractCall(CALL_REQ, { account: ACCOUNT, label: "revert-case" });

    expect(status.state).toBe("failed");
    expect(calls).toHaveLength(3); // no retries for a definitive on-chain revert
    expect(events.some((e) => e.kind === "execute.retry")).toBe(false);
    expect(events.at(-1)?.kind).toBe("execute.failed");
  });

  it("re-polls the original execution on 409 idempotency_in_progress instead of failing", async () => {
    installFetch([
      { body: { simulation: { wouldRevert: false } } },
      {
        status: 409,
        body: { error: { code: "idempotency_in_progress", message: "still running" }, executionId: "ex-1" },
      },
      CONFIRMED_STATUS,
    ]);
    const events: AgentEvent[] = [];
    const executor = makeExecutor(events);

    const status = await executor.runContractCall(CALL_REQ, { account: ACCOUNT, label: "dup" });

    expect(status.state).toBe("confirmed");
    const submitted = events.find((e) => e.kind === "execute.submitted");
    expect(submitted?.detail.deduplicated).toBe(true);
    expect(submitted?.detail.executionId).toBe("ex-1");
  });
});
