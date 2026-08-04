/**
 * Day-3: stand up the KeeperHub *workflow-builder* surface.
 *
 *   npx tsx scripts/day3-workflows.ts create-monitor [webhookUrl]
 *   npx tsx scripts/day3-workflows.ts create-rescue-check
 *   npx tsx scripts/day3-workflows.ts list
 *
 * Node/edge shapes mirror the platform's own seed fixtures
 * (scripts/seed/fixtures/onboarding-workflows.ts + lib/workflow/node-builders.ts):
 * trigger config carries `triggerType`, action config carries `actionType`,
 * workflow-layer web3 nodes use `abiFunction` (unlike the direct-exec REST
 * API, which uses `functionName` — the two layers genuinely differ).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { KeeperHubRestClient } from "../src/keeperhub/client.js";

function loadDotEnv(): void {
  try {
    const raw = readFileSync(resolve(process.cwd(), ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch {
    /* rely on environment */
  }
}
loadDotEnv();

const NETWORK = "11155111"; // Sepolia (workflow layer wants the chain id as a string)
const LENS = process.env.LENS_ADDRESS_SEPOLIA ?? "";
const POOL = process.env.AAVE_POOL_SEPOLIA ?? "";
const GUARDED = process.env.GUARDED_ACCOUNT ?? "";
const HF_WARN_1E18 = "1300000000000000000"; // 1.3

const LENS_ABI = JSON.stringify([
  {
    type: "function",
    name: "healthFactorOf",
    stateMutability: "view",
    inputs: [
      { name: "pool", type: "address" },
      { name: "user", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
]);

type Node = {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: {
    label: string;
    description?: string;
    type: string;
    config: Record<string, unknown>;
    status: string;
  };
};

function trigger(id: string, config: Record<string, unknown>): Node {
  return {
    id,
    type: "trigger",
    position: { x: 100, y: 200 },
    data: { label: "Trigger", type: "trigger", config, status: "idle" },
  };
}

function action(id: string, label: string, description: string, config: Record<string, unknown>, y: number): Node {
  return {
    id,
    type: "action",
    position: { x: 100, y },
    data: { label, description, type: "action", config, status: "idle" },
  };
}

function edge(source: string, target: string, sourceHandle?: string) {
  return { id: `${source}->${target}${sourceHandle ? `:${sourceHandle}` : ""}`, source, target, ...(sourceHandle ? { sourceHandle } : {}) };
}

/** Block-trigger monitor: every 25 blocks read HF via the lens; if < 1.3 alert (email now, agent webhook once Pro). */
function monitorWorkflow(webhookUrl?: string) {
  const readLabel = "Read Health Factor";
  return {
    name: "LIFELINE HF Monitor",
    description:
      "Every 25 Sepolia blocks, read the guarded account's Aave v3 health factor through the HealthFactorLens (single-uint view) and alert the LIFELINE agent when it drops below the 1.3 warn threshold.",
    nodes: [
      trigger("trigger-1", { triggerType: "Block", network: NETWORK, blockInterval: "25" }),
      action(
        "step-1",
        readLabel,
        "healthFactorOf(pool, guarded) via the deployed HealthFactorLens — a single uint256 so conditions can compare it numerically",
        {
          actionType: "web3/read-contract",
          network: NETWORK,
          contractAddress: LENS,
          abi: LENS_ABI,
          abiFunction: "healthFactorOf",
          functionArgs: JSON.stringify([POOL, GUARDED]),
        },
        400,
      ),
      action(
        "step-2",
        "Condition",
        "HF below the 1.3 warn threshold?",
        {
          actionType: "Condition",
          condition: `{{@step-1:${readLabel}.result}} < ${HF_WARN_1E18}`,
          conditionConfig: {
            id: "group-1",
            logic: "AND",
            rules: [
              {
                id: "rule-1",
                leftOperand: `{{@step-1:${readLabel}.result}}`,
                operator: "<",
                rightOperand: HF_WARN_1E18,
              },
            ],
          },
        },
        600,
      ),
      // NOTE: the HTTP Request action is Pro-gated (402 upgrade_required,
      // featureId action.http-request, probed live). Until hackathon Pro
      // access lands, the alert leg is a free-tier email; pass a webhookUrl
      // argument to switch back to the direct agent webhook.
      webhookUrl
        ? action(
            "step-3",
            "Alert LIFELINE Agent",
            "POST the agent webhook so it plans and executes an on-chain-gated rescue",
            {
              actionType: "HTTP Request",
              endpoint: webhookUrl,
              httpMethod: "POST",
              httpHeaders: JSON.stringify({
                "Content-Type": "application/json",
                "X-Lifeline-Secret": process.env.WEBHOOK_SECRET ?? "change-me",
              }),
              httpBody: JSON.stringify({
                account: GUARDED,
                healthFactor: `{{@step-1:${readLabel}.result}}`,
                blockNumber: "{{@trigger-1:Trigger.blockNumber}}",
                source: "keeperhub-block-monitor",
              }),
              timeout: 10,
              // The agent's own poll loop is the belt to this workflow's
              // braces — a down webhook must not fail the monitor run.
              failOnError: false,
            },
            800,
          )
        : action(
            "step-3",
            "Alert Owner",
            "Email the owner that LIFELINE has engaged (free-tier alert leg)",
            {
              actionType: "sendgrid/send-email",
              emailTo: process.env.ALERT_EMAIL ?? "a2201832943@gmail.com",
              emailSubject: "LIFELINE: position at risk — agent engaged",
              emailBody:
                `Health factor {{@step-1:${readLabel}.result}} dropped below the 1.3 warn threshold at block {{@trigger-1:Trigger.blockNumber}}. ` +
                "The LIFELINE agent plans a minimal-cost rescue and executes it through KeeperHub check-and-execute with the HF re-verified on-chain.",
            },
            800,
          ),
    ],
    edges: [edge("trigger-1", "step-1"), edge("step-1", "step-2"), edge("step-2", "step-3", "true")],
  };
}

/** Marketplace-facing paid check: caller passes {user}, gets the lens HF read back. */
function rescueCheckWorkflow() {
  const readLabel = "Rescue Check";
  return {
    name: "LIFELINE Rescue Check",
    description:
      "Pay-per-call liquidation risk check: reads the caller-supplied account's Aave v3 (Sepolia) health factor through LIFELINE's HealthFactorLens and returns the raw 1e18 value — the same on-chain read LIFELINE's check-and-execute gate uses.",
    nodes: [
      trigger("trigger-1", { triggerType: "Webhook" }),
      action(
        "step-1",
        readLabel,
        "healthFactorOf(pool, caller-supplied user) via HealthFactorLens",
        {
          actionType: "web3/read-contract",
          network: NETWORK,
          contractAddress: LENS,
          abi: LENS_ABI,
          abiFunction: "healthFactorOf",
          functionArgs: `["${POOL}", "{{@trigger-1:Trigger.user}}"]`,
        },
        400,
      ),
    ],
    edges: [edge("trigger-1", "step-1")],
  };
}

async function main(): Promise<void> {
  const client = new KeeperHubRestClient({
    baseUrl: process.env.KH_BASE_URL ?? "https://app.keeperhub.com",
    apiKey: process.env.KH_API_KEY as string,
  });
  const cmd = process.argv[2];

  if (!LENS || !POOL || !GUARDED) throw new Error(".env missing LENS_ADDRESS_SEPOLIA / AAVE_POOL_SEPOLIA / GUARDED_ACCOUNT");

  if (cmd === "create-monitor") {
    const webhookUrl = process.argv[3]; // omit -> free-tier email alert leg
    const wf = monitorWorkflow(webhookUrl);
    const res = await client.createWorkflow(wf);
    console.log("created monitor workflow:", JSON.stringify(res.raw, null, 2).slice(0, 1200));
  } else if (cmd === "create-rescue-check") {
    const wf = rescueCheckWorkflow();
    const res = await client.createWorkflow(wf);
    console.log("created rescue-check workflow:", JSON.stringify(res.raw, null, 2).slice(0, 1200));
  } else if (cmd === "list") {
    const { payload } = await (client as unknown as { request: (m: string, p: string) => Promise<{ payload: unknown }> }).request("GET", "/api/workflows");
    console.log(JSON.stringify(payload, null, 1).slice(0, 2000));
  } else {
    console.log("usage: npx tsx scripts/day3-workflows.ts <create-monitor [webhookUrl] | create-rescue-check | list>");
  }
}

await main();
