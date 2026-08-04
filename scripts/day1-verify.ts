/**
 * LIFELINE — day-1 KeeperHub surface verification.
 *
 * The FIRST thing to run after pasting KH_API_KEY into .env:
 *
 *   npm run day1
 *
 * Proves every KeeperHub surface LIFELINE depends on. SAFETY INVARIANT: this
 * script NEVER broadcasts a transaction — every /api/execute/* call hardcodes
 * `simulate: true`, and the POST helper refuses to send a body without it.
 *
 * Sections (each prints PASS/FAIL/SKIP + evidence; failures do not stop the run):
 *   A. Auth + chains        — GET /api/chains, canonical network identifiers
 *   B. Action registry      — GET /api/mcp/schemas, diff vs our pinned request shapes
 *   C. MCP surface          — Streamable HTTP MCP: tools, aave-v3 actions, org wallets
 *   D. Simulated call       — contract-call simulate:true (WETH9 deposit on Sepolia)
 *   E. check-and-execute    — simulate:true with an arbitrary-view-function condition
 *   F. Gas sponsorship      — spend-cap / sponsorship discovery
 *
 * Exit code = number of FAILed sections.
 *
 * Self-contained by design: raw fetch + @modelcontextprotocol/sdk only; parses
 * .env manually; imports src/types.ts for the pinned request shapes.
 */

import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CheckAndExecuteRequest, ContractCallRequest } from "../src/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WETH9_SEPOLIA = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14" as const;
// ETHER units, not wei: the API parses value with ethers.parseEther
// (proven by lib/execute/native-value.ts + a live probe that read our wei
// string as 1e15 ETH). "0.001" = 0.001 ETH.
const DEPOSIT_VALUE_ETH = "0.001";
const DEPOSIT_ABI = [
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
];
const APPROVE_ABI = [
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
];
const BALANCE_OF_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
];
const CHAINS_OF_INTEREST: Array<{ chainId: number; label: string }> = [
  { chainId: 11155111, label: "Sepolia" },
  { chainId: 8453, label: "Base" },
  { chainId: 84532, label: "Base Sepolia" },
];

// ---------------------------------------------------------------------------
// .env loading (manual, no dependency)
// ---------------------------------------------------------------------------

function loadDotEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  let text: string;
  try {
    text = readFileSync(new URL("../.env", import.meta.url), "utf8");
  } catch {
    return out; // no .env yet
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

const dotenv = loadDotEnv();
const env = (k: string): string => process.env[k] ?? dotenv[k] ?? "";

const BASE_URL = (env("KH_BASE_URL") || "https://app.keeperhub.com").replace(/\/+$/, "");
const MCP_URL = `${BASE_URL}/mcp`;
const API_KEY = env("KH_API_KEY");

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

type Status = "PASS" | "FAIL" | "SKIP";
interface SectionResult {
  id: string;
  name: string;
  status: Status;
  note: string;
}
const results: SectionResult[] = [];

const log = (...args: unknown[]) => console.log(...args);
const indent = (s: string, pad = "    ") =>
  s
    .split("\n")
    .map((l) => pad + l)
    .join("\n");

function trunc(s: string, n = 1500): string {
  return s.length <= n ? s : s.slice(0, n) + ` ...[truncated ${s.length - n} of ${s.length} chars]`;
}

function redact(s: string): string {
  return API_KEY ? s.split(API_KEY).join("kh_***REDACTED***") : s;
}

function banner(id: string, name: string): void {
  log("");
  log(`=== [${id}] ${name} ${"=".repeat(Math.max(3, 60 - id.length - name.length))}`);
}

// ---------------------------------------------------------------------------
// HTTP helpers (raw fetch)
// ---------------------------------------------------------------------------

interface HttpResult {
  ok: boolean;
  status: number;
  headers: Headers;
  json?: unknown;
  text: string;
  netError?: string;
}

async function http(method: "GET" | "POST", path: string, body?: unknown): Promise<HttpResult> {
  const url = path.startsWith("http") ? path : `${BASE_URL}${path}`;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(25_000),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON body */
    }
    return { ok: res.ok, status: res.status, headers: res.headers, json, text };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      headers: new Headers(),
      text: "",
      netError: String((e as Error)?.message ?? e),
    };
  }
}

/** The ONLY way this script hits /api/execute/*: refuses any body not marked simulate:true. */
async function postSimulatedExecute(path: string, body: Record<string, unknown>): Promise<HttpResult> {
  if (body.simulate !== true) {
    throw new Error(`SAFETY VIOLATION: refusing to POST ${path} without simulate:true`);
  }
  return http("POST", path, body);
}

// ---------------------------------------------------------------------------
// JSON spelunking helpers (schemas payload shape is not assumed)
// ---------------------------------------------------------------------------

type AnyObj = Record<string, any>;

function* walk(node: unknown, path: string[] = []): Generator<{ path: string[]; node: unknown }> {
  yield { path, node };
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) yield* walk(node[i], [...path, String(i)]);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as AnyObj)) yield* walk(v, [...path, k]);
  }
}

/** Find objects that look like a named schema entry matching `re` (by name-ish field or key path). */
function findNamed(root: unknown, re: RegExp, max = 3): Array<{ path: string; node: AnyObj }> {
  const hits: Array<{ path: string; node: AnyObj }> = [];
  const NAME_KEYS = ["name", "slug", "id", "action", "type", "title", "label", "key", "tool"];
  for (const { path, node } of walk(root)) {
    if (!node || typeof node !== "object" || Array.isArray(node)) continue;
    const obj = node as AnyObj;
    const nameHit = NAME_KEYS.some((k) => typeof obj[k] === "string" && re.test(obj[k]));
    const pathHit = path.length > 0 && re.test(path[path.length - 1]);
    if (nameHit || pathHit) {
      hits.push({ path: path.join("."), node: obj });
      if (hits.length >= max) break;
    }
  }
  return hits;
}

/** Collect every property name (+ declared type) appearing under any `properties` object in a subtree. */
function collectProps(subtree: unknown): Map<string, string> {
  const props = new Map<string, string>();
  for (const { path, node } of walk(subtree)) {
    if (path[path.length - 1] !== "properties") continue;
    if (!node || typeof node !== "object" || Array.isArray(node)) continue;
    for (const [k, v] of Object.entries(node as AnyObj)) {
      const t = v && typeof v === "object" ? String((v as AnyObj).type ?? "?") : "?";
      if (!props.has(k)) props.set(k, t);
    }
  }
  return props;
}

/** Collect `required: [...]` arrays in a subtree. */
function collectRequired(subtree: unknown): string[] {
  const req = new Set<string>();
  for (const { path, node } of walk(subtree)) {
    if (path[path.length - 1] === "required" && Array.isArray(node)) {
      for (const r of node) if (typeof r === "string") req.add(r);
    }
  }
  return [...req];
}

function extractAddresses(text: string): string[] {
  return [...new Set(text.match(/0x[0-9a-fA-F]{40}\b/g) ?? [])];
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// ---------------------------------------------------------------------------
// Shared discovery state (later sections reuse what earlier sections learned)
// ---------------------------------------------------------------------------

const state = {
  /** canonical KeeperHub network identifier for Sepolia, learned from GET /api/chains */
  sepoliaNet: "sepolia",
  sepoliaNetSource: "fallback guess (section A did not run or could not extract it)",
  schemasText: "",
  schemasJson: undefined as unknown,
  walletAddresses: [] as string[],
  mcpToolNames: [] as string[],
};

// ---------------------------------------------------------------------------
// Section runner
// ---------------------------------------------------------------------------

async function runSection(
  id: string,
  name: string,
  fn: () => Promise<{ status: Status; note: string }>,
): Promise<void> {
  banner(id, name);
  let status: Status = "FAIL";
  let note = "";
  try {
    ({ status, note } = await fn());
  } catch (e) {
    status = "FAIL";
    log(indent(`unexpected exception:`));
    log(indent(redact(String((e as Error)?.stack ?? e)), "      "));
    note = `unexpected exception: ${redact(String((e as Error)?.message ?? e)).split("\n")[0]}`;
  }
  results.push({ id, name, status, note });
  log(`--- [${id}] ${status}${note ? ` — ${note}` : ""}`);
}

// ---------------------------------------------------------------------------
// A. Auth + chains
// ---------------------------------------------------------------------------

async function sectionA(): Promise<{ status: Status; note: string }> {
  const res = await http("GET", "/api/chains");
  if (res.netError) {
    log(indent(`network error: ${res.netError}`));
    return { status: "FAIL", note: `GET /api/chains network error: ${res.netError}` };
  }
  log(indent(`GET /api/chains -> HTTP ${res.status}`));
  for (const h of ["x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"]) {
    const v = res.headers.get(h);
    if (v !== null) log(indent(`${h}: ${v}`));
  }
  if (!res.ok) {
    log(indent(`body: ${redact(trunc(res.text))}`));
    return {
      status: "FAIL",
      note: `HTTP ${res.status} — check KH_API_KEY (org key, starts with kh_)`,
    };
  }

  const j: any = res.json;
  const chains: any[] = Array.isArray(j) ? j : (j?.chains ?? j?.data ?? j?.result ?? []);
  if (!Array.isArray(chains) || chains.length === 0) {
    log(indent(`unexpected payload shape, raw body:`));
    log(indent(redact(trunc(res.text, 2000))));
    return { status: "FAIL", note: "2xx but could not locate a chains array in payload" };
  }

  const ID_KEYS = ["chainId", "chain_id", "id", "networkId", "network_id"];
  const NET_KEYS = ["network", "slug", "identifier", "key", "name", "value"];
  const byChainId = new Map<number, { network: string; netKey: string; raw: any }>();

  log(indent(`${chains.length} chain entries; full entries (canonical 'network' ids live here):`));
  for (const c of chains) {
    log(indent(trunc(JSON.stringify(c), 300), "      "));
    const idKey = ID_KEYS.find((k) => typeof c?.[k] === "number" || /^\d+$/.test(String(c?.[k] ?? "")));
    const netKey = NET_KEYS.find((k) => typeof c?.[k] === "string");
    if (idKey && netKey) {
      byChainId.set(Number(c[idKey]), { network: c[netKey], netKey, raw: c });
    }
  }

  log(indent("chains of interest:"));
  let sepoliaEnabled = false;
  for (const { chainId, label } of CHAINS_OF_INTEREST) {
    const hit = byChainId.get(chainId);
    if (hit) {
      const enabledField =
        typeof hit.raw?.enabled === "boolean"
          ? hit.raw.enabled
          : typeof hit.raw?.disabled === "boolean"
            ? !hit.raw.disabled
            : typeof hit.raw?.active === "boolean"
              ? hit.raw.active
              : true; // present in the list => treat as enabled
      log(
        indent(
          `${label} (${chainId}): ${enabledField ? "ENABLED" : "LISTED BUT NOT ENABLED"} — canonical network id: "${hit.network}" (from field '${hit.netKey}')`,
          "      ",
        ),
      );
      if (chainId === 11155111) {
        sepoliaEnabled = enabledField;
        state.sepoliaNet = hit.network;
        state.sepoliaNetSource = `GET /api/chains field '${hit.netKey}'`;
      }
    } else {
      log(indent(`${label} (${chainId}): NOT FOUND in /api/chains`, "      "));
    }
  }
  log(indent(`=> sections D/E will use network id "${state.sepoliaNet}" (${state.sepoliaNetSource})`));

  return {
    status: "PASS",
    note: `auth OK; ${chains.length} chains; Sepolia ${sepoliaEnabled ? "enabled" : "MISSING/disabled"}; sepolia network id = "${state.sepoliaNet}"`,
  };
}

// ---------------------------------------------------------------------------
// B. Action registry (schema diff vs pinned request shapes)
// ---------------------------------------------------------------------------

function diffFields(
  label: string,
  expected: Array<{ field: string; wantType?: string }>,
  props: Map<string, string>,
  rawText: string,
): number {
  let mismatches = 0;
  log(indent(`${label}: field-by-field vs pinned src/types.ts assumption`));
  for (const { field, wantType } of expected) {
    const inProps = props.has(field);
    const inRaw = count(rawText, `"${field}"`) > 0;
    const declared = props.get(field);
    if (inProps || inRaw) {
      if (wantType && declared && declared !== "?" && declared !== wantType) {
        log(indent(`MISMATCH ${field}: present but declared type '${declared}' (we pinned '${wantType}')`, "      "));
        mismatches++;
      } else {
        log(
          indent(
            `MATCH    ${field}${declared && declared !== "?" ? ` (type: ${declared})` : ""}${!inProps ? " (found in raw text only)" : ""}`,
            "      ",
          ),
        );
      }
    } else {
      log(indent(`MISMATCH ${field}: NOT FOUND anywhere in registry`, "      "));
      mismatches++;
    }
  }
  return mismatches;
}

async function sectionB(): Promise<{ status: Status; note: string }> {
  const res = await http("GET", "/api/mcp/schemas");
  if (!res.ok) {
    log(indent(`GET /api/mcp/schemas -> HTTP ${res.status} ${res.netError ?? ""}`));
    log(indent(`body: ${redact(trunc(res.text))}`));
    return { status: "FAIL", note: `HTTP ${res.status || "network error"}` };
  }
  state.schemasText = res.text;
  state.schemasJson = res.json;
  log(indent(`GET /api/mcp/schemas -> HTTP 200, ${res.text.length} chars`));

  // Coarse, decisive signal first: raw-text occurrence counts of the contested field names.
  log(indent("raw-text field-name occurrences (decisive even if schema layout differs):"));
  for (const f of ['"abiFunction"', '"functionName"', '"functionArgs"', '"operator"', '"simulate"', '"abi"']) {
    log(indent(`${f}: ${count(res.text, f)}x`, "      "));
  }

  // Locate the direct-execution schemas.
  const ccHits = findNamed(res.json, /contract[-_ ]?call/i);
  const cneHits = findNamed(res.json, /check[-_ ]?and[-_ ]?execute|check[-_ ]?execute/i);
  const aaveHits = findNamed(res.json, /aave/i, 10);

  let mismatches = 0;

  if (ccHits.length > 0) {
    log(indent(`contract-call schema candidate at '${ccHits[0].path}':`));
    log(indent(trunc(JSON.stringify(ccHits[0].node), 1200), "      "));
    const props = collectProps(ccHits[0].node);
    log(indent(`declared properties: ${[...props.entries()].map(([k, t]) => `${k}:${t}`).join(", ") || "(none found)"}`, "      "));
    const req = collectRequired(ccHits[0].node);
    if (req.length) log(indent(`required: ${req.join(", ")}`, "      "));
    mismatches += diffFields(
      "ContractCallRequest",
      [
        { field: "network" },
        { field: "contractAddress" },
        { field: "abi", wantType: "string" },
        { field: "abiFunction" },
        { field: "functionArgs", wantType: "string" },
        { field: "value" },
      ],
      props,
      JSON.stringify(ccHits[0].node),
    );
    if (collectProps(ccHits[0].node).has("functionName") || count(JSON.stringify(ccHits[0].node), '"functionName"') > 0) {
      log(indent(`WARNING: schema also mentions 'functionName' — verify which one the endpoint actually wants`, "      "));
    }
  } else {
    log(indent("no contract-call schema located by name; falling back to whole-registry field scan"));
    mismatches += diffFields(
      "ContractCallRequest (whole-registry fallback)",
      [{ field: "network" }, { field: "contractAddress" }, { field: "abi" }, { field: "abiFunction" }, { field: "functionArgs" }],
      new Map(),
      res.text,
    );
  }

  if (cneHits.length > 0) {
    log(indent(`check-and-execute schema candidate at '${cneHits[0].path}':`));
    log(indent(trunc(JSON.stringify(cneHits[0].node), 1200), "      "));
    const props = collectProps(cneHits[0].node);
    mismatches += diffFields(
      "CheckAndExecuteRequest",
      [{ field: "check" }, { field: "action" }, { field: "operator" }, { field: "value" }],
      props,
      JSON.stringify(cneHits[0].node),
    );
    // Operator enum: we pinned eq/neq/gt/lt/gte/lte.
    let enumFound: string[] | undefined;
    for (const { node } of walk(cneHits[0].node)) {
      if (Array.isArray(node) && node.includes("gte") && node.includes("lte")) {
        enumFound = node as string[];
        break;
      }
    }
    if (enumFound) {
      const pinned = ["eq", "neq", "gt", "lt", "gte", "lte"];
      const same = pinned.every((o) => enumFound!.includes(o));
      log(indent(`${same ? "MATCH   " : "MISMATCH"} operator enum: [${enumFound.join(", ")}] (pinned: [${pinned.join(", ")}])`, "      "));
      if (!same) mismatches++;
    } else {
      log(indent("operator enum values not located in candidate subtree", "      "));
    }
  } else {
    log(indent("no check-and-execute schema located by name in registry (section E probes the endpoint directly)"));
  }

  if (aaveHits.length > 0) {
    log(indent(`aave-related registry entries (${aaveHits.length}):`));
    for (const h of aaveHits) log(indent(`${h.path}: ${trunc(JSON.stringify(h.node), 300)}`, "      "));
  } else {
    const slugs = [...new Set(res.text.match(/aave[-_]?v?3?\/[a-z0-9-]+/gi) ?? [])];
    log(indent(`aave slugs in raw registry text: ${slugs.length ? slugs.join(", ") : "(none — section C searches via MCP instead)"}`));
  }

  return {
    status: mismatches === 0 ? "PASS" : "FAIL",
    note:
      mismatches === 0
        ? "registry fetched; pinned field names all confirmed"
        : `${mismatches} field MISMATCH(es) vs pinned types — update src/types.ts consumers before executing anything live`,
  };
}

// ---------------------------------------------------------------------------
// C. MCP surface
// ---------------------------------------------------------------------------

async function sectionC(): Promise<{ status: Status; note: string }> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } },
  });
  const mcp = new Client({ name: "lifeline-day1-verify", version: "0.1.0" });

  let problems = 0;
  try {
    await mcp.connect(transport);
    log(indent(`connected to ${MCP_URL} (Streamable HTTP + Bearer)`));

    const { tools } = await mcp.listTools();
    state.mcpToolNames = tools.map((t) => t.name);
    log(indent(`listTools: ${tools.length} tools`));
    log(indent(state.mcpToolNames.join(", "), "      "));

    const callText = async (name: string, args: Record<string, unknown>) => {
      if (!state.mcpToolNames.includes(name)) {
        return { ok: false, text: `(tool '${name}' not present on server)`, missing: true };
      }
      try {
        const r: any = await mcp.callTool({ name, arguments: args });
        const text =
          (r?.content ?? [])
            .filter((c: any) => c?.type === "text")
            .map((c: any) => c.text)
            .join("\n") || JSON.stringify(r);
        return { ok: r?.isError !== true, text, missing: false };
      } catch (e) {
        return { ok: false, text: String((e as Error)?.message ?? e), missing: false };
      }
    };

    // search_protocol_actions {query:'aave'}
    const search = await callText("search_protocol_actions", { query: "aave" });
    log(indent(`search_protocol_actions({query:'aave'}) -> ${search.ok ? "ok" : "ERROR"}`));
    log(indent(redact(trunc(search.text, 2000)), "      "));
    if (search.ok) {
      const slugs = [...new Set(search.text.match(/aave[-_]?v?\d*\/[a-z0-9_-]+/gi) ?? [])];
      if (slugs.length) log(indent(`aave action slugs: ${slugs.join(", ")}`, "      "));
      const nets = [...new Set<string>(search.text.match(/"networks?"\s*:\s*\[[^\]]*\]/g) ?? [])];
      for (const n of nets.slice(0, 5)) log(indent(`networks: ${trunc(n, 200)}`, "      "));
    } else if (!search.missing) {
      problems++;
    }

    // list_integrations / get_wallet_integration — we need the org wallet address(es) to know what to fund.
    for (const [name, args] of [
      ["list_integrations", {}],
      ["get_wallet_integration", {}],
    ] as const) {
      const r = await callText(name, args as Record<string, unknown>);
      log(indent(`${name}(${JSON.stringify(args)}) -> ${r.ok ? "ok" : "ERROR"}`));
      log(indent(redact(trunc(r.text, 1500)), "      "));
      const addrs = extractAddresses(r.text);
      if (addrs.length) {
        state.walletAddresses.push(...addrs.filter((a) => !state.walletAddresses.includes(a)));
        log(indent(`wallet-looking addresses: ${addrs.join(", ")}`, "      "));
      }
      if (!r.ok && !r.missing) {
        log(indent(`(error body above is evidence — it teaches the tool's real argument schema)`, "      "));
      }
    }

    if (state.walletAddresses.length) {
      log(indent(`ORG WALLET(S) TO FUND: ${state.walletAddresses.join(", ")}`));
    } else {
      log(indent("no wallet address surfaced — check integrations in the KeeperHub dashboard"));
    }

    return {
      status: problems === 0 ? "PASS" : "FAIL",
      note: `${state.mcpToolNames.length} tools; wallets: ${state.walletAddresses.join(", ") || "none surfaced"}`,
    };
  } finally {
    try {
      await mcp.close();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// D. Simulated direct contract-call (proves auth + simulate + field names end-to-end)
// ---------------------------------------------------------------------------

function buildDepositCall(): ContractCallRequest {
  // Real schema (app/api/execute/_lib/schemas.ts): chainId canonical, functionName not abiFunction.
  return {
    chainId: 11155111,
    contractAddress: WETH9_SEPOLIA,
    abi: JSON.stringify(DEPOSIT_ABI),
    functionName: "deposit",
    functionArgs: "[]",
    value: DEPOSIT_VALUE_ETH,
  };
}

function printSimulationEvidence(json: unknown): void {
  const interesting: string[] = [];
  for (const { path, node } of walk(json)) {
    const key = path[path.length - 1] ?? "";
    if (/wouldRevert|revertReason|gasEstimate|gasUsed|gasLimit|simulat|executionId/i.test(key) && typeof node !== "object") {
      interesting.push(`${path.join(".")} = ${String(node)}`);
    }
    if (interesting.length >= 12) break;
  }
  if (interesting.length) {
    log(indent("simulation fields:"));
    for (const line of interesting) log(indent(line, "      "));
  }
}

async function sectionD(): Promise<{ status: Status; note: string }> {
  const req = buildDepositCall();
  log(indent(`POST /api/execute/contract-call (simulate:true) — WETH9.deposit() value=${DEPOSIT_VALUE_ETH} ETH on chainId ${req.chainId}`));
  const res = await postSimulatedExecute("/api/execute/contract-call", { ...req, simulate: true });
  if (res.netError) {
    log(indent(`network error: ${res.netError}`));
    return { status: "FAIL", note: `network error: ${res.netError}` };
  }
  log(indent(`HTTP ${res.status}`));
  log(indent(`response body: ${redact(trunc(res.text, 1800))}`));
  if (!res.ok) {
    log(indent("(4xx error body above is verbatim — it documents the real request schema)"));
    return { status: "FAIL", note: `HTTP ${res.status} — see verbatim error body above` };
  }
  printSimulationEvidence(res.json);
  log(indent("NOTE: if the org wallet holds 0 Sepolia ETH, wouldRevert/insufficient-funds here is EXPECTED —"));
  log(indent("the API + auth + field names still proved out end-to-end. Fund the wallet and re-run."));
  return { status: "PASS", note: "simulation accepted (2xx) — auth + simulate + pinned field names proven end-to-end" };
}

// ---------------------------------------------------------------------------
// E. check-and-execute schema probe (the killer feature: arbitrary-view-function gate)
// ---------------------------------------------------------------------------

async function sectionE(): Promise<{ status: Status; note: string }> {
  // Real schema (check-and-execute/route.ts): FLAT check fields at the top level,
  // condition as {operator, value}, write nested under action. The action leg
  // never forwards native value, so the probe action is a harmless non-payable
  // approve(0x...01, 0) instead of a payable deposit.
  const req: CheckAndExecuteRequest = {
    chainId: 11155111,
    contractAddress: WETH9_SEPOLIA,
    abi: JSON.stringify(BALANCE_OF_ABI),
    functionName: "balanceOf",
    functionArgs: JSON.stringify(["0x0000000000000000000000000000000000000001"]),
    condition: {
      operator: "gte",
      value: "0", // uint256 >= 0 is always true — pure schema/plumbing probe
    },
    action: {
      contractAddress: WETH9_SEPOLIA,
      abi: JSON.stringify(APPROVE_ABI),
      functionName: "approve",
      functionArgs: JSON.stringify(["0x0000000000000000000000000000000000000001", "0"]),
    },
  };
  log(indent(`POST /api/execute/check-and-execute (simulate:true)`));
  log(indent(`check: WETH9.balanceOf(0x...01) gte 0 (single-uint view, always true) -> action: approve(0x...01, 0)`));
  log(indent(`request body: ${trunc(JSON.stringify({ ...req, simulate: true }), 1200)}`, "      "));

  const res = await postSimulatedExecute("/api/execute/check-and-execute", {
    ...(req as unknown as Record<string, unknown>),
    simulate: true,
  });
  if (res.netError) {
    log(indent(`network error: ${res.netError}`));
    return { status: "FAIL", note: `network error: ${res.netError}` };
  }
  log(indent(`HTTP ${res.status}`));
  log(indent(`full response body (verbatim):`));
  log(indent(redact(trunc(res.text, 2500)), "      "));
  if (!res.ok) {
    log(indent("SCHEMA LESSON: the 4xx body above is the API telling us the real check-and-execute shape."));
    log(indent("Update src/types.ts (pinned) + consumers to match before any live execution."));
    return { status: "FAIL", note: `HTTP ${res.status} — real schema documented in verbatim error body above` };
  }
  printSimulationEvidence(res.json);
  log(indent("PROVEN: check-and-execute accepts an ARBITRARY view function as its on-chain gate."));
  log(indent("This is LIFELINE's core safety property — HealthFactorLens.healthFactor(user) can gate the rescue."));
  return { status: "PASS", note: "on-chain gate on arbitrary view function ACCEPTED — core mechanism proven" };
}

// ---------------------------------------------------------------------------
// F. Gas sponsorship discovery
// ---------------------------------------------------------------------------

async function sectionF(): Promise<{ status: Status; note: string }> {
  const res = await http("GET", "/api/analytics/spend-cap");
  log(indent(`GET /api/analytics/spend-cap -> HTTP ${res.status}${res.netError ? ` (${res.netError})` : ""}`));
  if (res.text) log(indent(redact(trunc(res.text, 1200)), "      "));

  // Mine the action registry (already fetched in B) for sponsorship-related surface area.
  if (state.schemasText) {
    const re = /sponsor|spend[-_ ]?cap|gas[-_ ]?polic|relay/gi;
    const found: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(state.schemasText)) !== null && found.length < 8) {
      const ctx = state.schemasText.slice(Math.max(0, m.index - 60), m.index + 80).replace(/\s+/g, " ");
      found.push(`...${ctx}...`);
    }
    if (found.length) {
      log(indent(`sponsorship-related mentions in /api/mcp/schemas (${found.length} shown):`));
      for (const f of found) log(indent(redact(f), "      "));
    } else {
      log(indent("no sponsorship-related keywords in the action registry"));
    }
  } else {
    log(indent("schemas not available (section B failed) — keyword scan skipped"));
  }

  if (res.ok) {
    return { status: "PASS", note: "spend-cap endpoint responded 2xx — sponsorship telemetry available" };
  }
  if (res.status === 401 || res.status === 403) {
    return { status: "FAIL", note: `HTTP ${res.status} — auth problem on analytics endpoint` };
  }
  return {
    status: "SKIP",
    note: `spend-cap not available (HTTP ${res.status || "network error"}) — sponsorship is discovery-only, not load-bearing`,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

log("LIFELINE day-1 verification");
log(`base URL : ${BASE_URL}`);
log(`mcp URL  : ${MCP_URL}`);
log(`api key  : ${API_KEY ? `${API_KEY.slice(0, 3)}...${API_KEY.slice(-4)} (${API_KEY.length} chars)` : "(none)"}`);
log("safety   : every execute call in this script hardcodes simulate:true — nothing can broadcast");

if (!API_KEY) {
  log("");
  log("FATAL: KH_API_KEY is not set.");
  log("  1. cp .env.example .env");
  log("  2. KeeperHub dashboard > Settings > API Keys > Organisation tab > create key (kh_...)");
  log("  3. paste it as KH_API_KEY in .env, then re-run: npm run day1");
  process.exit(1);
}
if (!API_KEY.startsWith("kh_")) {
  log(`WARNING: key does not start with "kh_" — org keys do; a personal/project key may 401.`);
}

await runSection("A", "Auth + chains", sectionA);
await runSection("B", "Action registry (/api/mcp/schemas) vs pinned types", sectionB);
await runSection("C", "MCP surface (tools, aave-v3 actions, org wallets)", sectionC);
await runSection("D", "Simulated contract-call (WETH9 deposit, simulate:true)", sectionD);
await runSection("E", "check-and-execute view-function gate (simulate:true)", sectionE);
await runSection("F", "Gas sponsorship discovery", sectionF);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

log("");
log("=".repeat(78));
log("SUMMARY");
log("=".repeat(78));
const wId = 3;
const wName = Math.max(...results.map((r) => r.name.length), 4);
log(`${"SEC".padEnd(wId)} | ${"SECTION".padEnd(wName)} | STATUS | NOTE`);
log(`${"-".repeat(wId)}-+-${"-".repeat(wName)}-+--------+-${"-".repeat(30)}`);
for (const r of results) {
  const note = trunc(r.note.replace(/\s*\n\s*/g, " "), 160);
  log(`${r.id.padEnd(wId)} | ${r.name.padEnd(wName)} | ${r.status.padEnd(6)} | ${note}`);
}
const fails = results.filter((r) => r.status === "FAIL").length;
const skips = results.filter((r) => r.status === "SKIP").length;
log("");
log(`${results.length - fails - skips} PASS, ${fails} FAIL, ${skips} SKIP — exit code ${fails}`);

log("");
log("NEXT STEPS");
log("-".repeat(78));
const wallet = state.walletAddresses[0];
log(`1. Fund the org wallet on Sepolia${wallet ? `: ${wallet}` : " (address: see section C / KeeperHub dashboard > Integrations)"}`);
log("   Faucets: https://sepoliafaucet.com, https://cloud.google.com/application/web3/faucet/ethereum/sepolia");
log(`2. Canonical network ids came from section A (Sepolia = "${state.sepoliaNet}") — use them verbatim`);
log("   in src/workflows/ definitions and every execute request body.");
log("3. Deploy contracts/HealthFactorLens.sol to Sepolia (constructor: Aave v3 Pool address),");
log("   then fill LENS_ADDRESS_SEPOLIA and AAVE_POOL_SEPOLIA in .env.");
log("4. Open a small Aave v3 Sepolia position with the account you want guarded (app.aave.com,");
log("   testnet mode) and set GUARDED_ACCOUNT in .env.");
log("5. Re-run `npm run day1` until every section is PASS, then `npm run agent`.");
if (fails > 0) {
  log("");
  log("Some sections FAILED — fix those first; 4xx bodies printed above are verbatim on purpose:");
  log("they document the real API schema wherever it disagrees with our pinned assumptions.");
}

// Flush stdout before exiting with the FAIL count (Windows pipes can drop tail output otherwise).
await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
process.exit(fails);
