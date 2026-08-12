/**
 * The other side of the market: a STRANGER agent paying for protection.
 *
 *   npx tsx scripts/day5-buyer.ts challenge     # show the 402 without paying
 *   npx tsx scripts/day5-buyer.ts buy           # pay $0.05 and get the reading
 *
 * `challenge` is free and always safe to run: it POSTs the paid endpoint with
 * no credentials and prints the dual-protocol payment challenge KeeperHub
 * answers with — x402 v2 (Base USDC) *and* Tempo/MPP, in one response.
 *
 * `buy` performs a REAL mainnet payment. It drives the KeeperHub agentic
 * wallet's MCP server (`keeperhub-wallet-mcp`, stdio) and calls `call_workflow`,
 * which settles the 402 challenge with an EIP-3009 `TransferWithAuthorization`
 * on Base USDC — the facilitator pays gas, the wallet pays the fee. The wallet
 * is a Turnkey sub-org provisioned by `keeperhub-wallet add`; its config lives
 * at ~/.keeperhub/wallet.json and holds no private key.
 *
 * This buyer is deliberately a different identity from the guarded position's
 * org wallet: LIFELINE's seller side has to work for someone who is not us.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SLUG = "lifeline-rescue-check";
const ENDPOINT = `https://app.keeperhub.com/api/mcp/workflows/${SLUG}/call`;
/** The position LIFELINE guards — the account whose health factor we are buying a reading of. */
const SUBJECT = process.env.GUARDED_ACCOUNT ?? "0xE20405094C45b4F9adc050C429F2F45C72fF7467";

const WALLET_MCP = {
  command: "npx",
  args: ["-y", "-p", "@keeperhub/wallet@0.1.15", "keeperhub-wallet-mcp"],
};

function decodeChallenge(header: string | null): unknown {
  if (!header) return null;
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return header;
  }
}

/** Print the 402 challenge without paying anything. */
async function challenge(): Promise<void> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user: SUBJECT }),
  });

  console.log(`POST ${ENDPOINT}  ->  HTTP ${res.status}\n`);

  // x402: the machine-readable challenge rides in a base64 header AND the body.
  const x402 = decodeChallenge(res.headers.get("payment-required"));
  if (x402 && typeof x402 === "object") {
    const accepts = (x402 as { accepts?: Array<Record<string, string>> }).accepts ?? [];
    console.log("x402 v2 challenge:");
    for (const a of accepts) {
      const usd = Number(a.amount ?? 0) / 1e6; // USDC is 6-decimal
      console.log(`  scheme=${a.scheme}  network=${a.network}  asset=${a.asset}`);
      console.log(`  price=${usd} USDC  payTo=${a.payTo}`);
    }
  }

  // MPP rides in the standard WWW-Authenticate header, Tempo-settled.
  const mpp = res.headers.get("www-authenticate");
  if (mpp) {
    console.log("\nMPP challenge (www-authenticate):");
    const req = /request="([^"]+)"/.exec(mpp)?.[1];
    const method = /method="([^"]+)"/.exec(mpp)?.[1];
    console.log(`  method=${method}`);
    if (req) {
      const parsed = decodeChallenge(req) as Record<string, unknown> | null;
      if (parsed) {
        const amt = Number(parsed.amount ?? 0) / 1e6;
        console.log(`  amount=${amt} USDC.e  chainId=${JSON.stringify(parsed.methodDetails)}`);
        console.log(`  currency=${parsed.currency}  recipient=${parsed.recipient}`);
      }
    }
  }

  console.log(
    "\nBoth rails advertised in a single 402 — a client picks whichever it can settle.\n" +
      "Run `npx tsx scripts/day5-buyer.ts buy` to actually pay (real Base USDC).",
  );
}

/** MCP tools answer with `content: [{type:"text", text:"<json>"}]` — pull the JSON out. */
function unwrap(res: unknown): unknown {
  const c = (res as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
  const text = Array.isArray(c) ? c.find((x) => x?.type === "text")?.text : undefined;
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readBalance(res: unknown): { address: string; base: string } {
  const b = unwrap(res) as { base?: { amount?: string; address?: string } } | null;
  return { address: b?.base?.address ?? "?", base: `${b?.base?.amount ?? "?"} USDC` };
}

/** Pay the challenge and invoke the workflow through the agentic wallet. */
async function buy(): Promise<void> {
  const client = new Client({ name: "lifeline-buyer", version: "1.0.0" });
  const transport = new StdioClientTransport(WALLET_MCP);
  await client.connect(transport);

  try {
    const balance = await client.callTool({ name: "balance", arguments: {} });
    const before = readBalance(balance);
    console.log(`buyer wallet  ${before.address}`);
    console.log(`  Base USDC   ${before.base}\n`);

    console.log(`paying + invoking ${SLUG} for ${SUBJECT} …\n`);
    const out = await client.callTool({
      name: "call_workflow",
      arguments: { slug: SLUG, body: { user: SUBJECT }, paymentHint: "x402", responseFormat: "json" },
    });

    // The MCP tool returns the HTTP response as an escaped JSON string inside a
    // text content block. Unwrap it so the interesting facts are readable
    // instead of buried three levels of escaping deep.
    const env = unwrap(out) as Record<string, unknown> | null;
    const body = env && typeof env.bodyText === "string" ? (JSON.parse(env.bodyText) as Record<string, unknown>) : null;
    const output = body?.output as Record<string, unknown> | undefined;
    const agent = (body?.feedback as { context?: { agent?: Record<string, unknown> } } | undefined)?.context?.agent;

    console.log(`  paid            ${env?.paid}`);
    console.log(`  protocol used   ${env?.protocolUsed}`);
    console.log(`  http status     ${env?.status}`);
    if (output?.result) {
      const hf = Number(output.result) / 1e18;
      console.log(`  health factor   ${hf.toFixed(4)}   (raw ${output.result})`);
    }
    if (body?.executionId) console.log(`  execution       ${body.executionId}`);
    if (agent) console.log(`  ERC-8004 agent  #${agent.id}  ${agent.explorerUrl}`);

    const after = readBalance(await client.callTool({ name: "balance", arguments: {} }));
    console.log(`\n  Base USDC       ${before.base}  ->  ${after.base}`);
    console.log(
      "\nThat health factor is the same on-chain value LIFELINE's check-and-execute gate reads.\n" +
        "Settlement is an EIP-3009 transfer on Base, indexed on x402scan.com under the seller.",
    );
  } finally {
    await client.close();
  }
}

const cmd = process.argv[2];
if (cmd === "challenge") await challenge();
else if (cmd === "buy") await buy();
else {
  console.log("usage: npx tsx scripts/day5-buyer.ts <challenge|buy>");
  process.exit(cmd ? 1 : 0);
}
