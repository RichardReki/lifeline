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

/** Pay the challenge and invoke the workflow through the agentic wallet. */
async function buy(): Promise<void> {
  const client = new Client({ name: "lifeline-buyer", version: "1.0.0" });
  const transport = new StdioClientTransport(WALLET_MCP);
  await client.connect(transport);

  try {
    const balance = await client.callTool({ name: "balance", arguments: {} });
    console.log("wallet balance before:", JSON.stringify(balance.content));

    console.log(`\npaying + invoking ${SLUG} for ${SUBJECT} …`);
    const out = await client.callTool({
      name: "call_workflow",
      arguments: { slug: SLUG, body: { user: SUBJECT }, paymentHint: "x402", responseFormat: "json" },
    });
    console.log("\nresult:", JSON.stringify(out.content, null, 2));

    const after = await client.callTool({ name: "balance", arguments: {} });
    console.log("\nwallet balance after:", JSON.stringify(after.content));
    console.log(
      "\nThe reading above is the same on-chain value LIFELINE's check-and-execute gate gates on.\n" +
        "Settlement is indexed on x402scan.com under the seller address.",
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
