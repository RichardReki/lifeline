# LIFELINE

**A liquidation guardian that sells protection, not liquidations.** Every liquidation bot on Aave is paid to destroy positions; LIFELINE is the counterparty paid to save them. It watches a wallet's Aave v3 health factor from inside KeeperHub's automation network, computes the *cheapest* rescue (repay a sliver of debt, or top up collateral) that restores the health factor to 1.5, and lands that rescue through KeeperHub's `check-and-execute` — which re-reads the health factor **on-chain, in the same transaction context, at execution time** — so a stale decision can never fire a pointless or harmful transaction. Protection-as-a-service: the position owner subscribes, the agent stands guard, and the rescue only spends money when the chain itself confirms it is still needed.

Built for the **KeeperHub Agents Onchain** hackathon.

## Architecture: Detect -> Decide -> Execute

Each stage maps to a specific KeeperHub surface:

```
   DETECT                        DECIDE                          EXECUTE
   KeeperHub workflow            LIFELINE agent (TypeScript)     KeeperHub check-and-execute

+---------------------------+  +----------------------------+  +------------------------------+
| Block trigger             |  | webhook received           |  | POST /api/execute/           |
|  (network: sepolia,       |  |   |                        |  |      check-and-execute       |
|   blockInterval: N)       |  |   v                        |  |                              |
|   |                       |  | read Aave v3 Pool          |  | check (ON-CHAIN, at exec     |
|   v                       |  |  getUserAccountData ->     |  |  time):                      |
| action: read              |  |  AccountHealth +           |  |  HealthFactorLens            |
|  HealthFactorLens         |  |  HfTrajectory (rate drift, |  |   .healthFactor(user)        |
|  .healthFactor(user)      |  |  seconds-to-liquidation)   |  |   lt  HF_WARN * 1e18         |
|   |                       |  |   |                        |  |   |                          |
|   v                       |  |   v                        |  |   v (only if still true)     |
| condition edge            |  | planner: minimal RescuePlan|  | action: aave-v3 repay or     |
|  sourceHandle 'true':     |  |  repay debt vs supply      |  |  supply (protocol action /   |
|  HF < warn threshold      |  |  collateral -> target 1.5  |  |  contract-call)              |
|   |                       |  |   |                        |  |   |                          |
|   v                       |  |   v                        |  |   v                          |
| Webhook action ->         |  | dry-run: simulate:true     |  | poll status (X-Poll-Interval |
|  LIFELINE agent           |  |  via REST; discover aave-v3|  |  -Hint) -> receipts[] with   |
|  (X-Lifeline-Secret)      |  |  actions via hosted MCP    |  |  verified + receiptStatus    |
+---------------------------+  +----------------------------+  +------------------------------+
```

- **Detect** — a KeeperHub **Block-trigger workflow** (`src/workflows/`) runs every N blocks, reads our `HealthFactorLens` view contract, and follows a **condition edge** (`sourceHandle: 'true'`) to a Webhook action that wakes the agent only when the health factor drops below the warning threshold.
- **Decide** — the TypeScript agent (`src/agent/`, `src/planner/`) pulls `getUserAccountData` from the Aave v3 Pool, projects the HF trajectory, and computes the minimal-cost `RescuePlan` (repay vs supply) that restores HF to 1.5. It discovers and validates aave-v3 actions through KeeperHub's **hosted MCP** (`search_protocol_actions`, `execute_protocol_action`) and dry-runs the exact transaction with **`simulate: true`** over REST before committing to anything.
- **Execute** — the rescue is submitted as **`check-and-execute`**: the condition is our `HealthFactorLens.healthFactor(user)` view compared against the threshold, re-evaluated **on-chain at execution time**. The Aave repay/supply only fires if the position is *still* in danger at that block.

> ### Why the on-chain gate matters
>
> Between the moment the agent decides "rescue now" and the moment the transaction lands, the world moves: prices update, the borrower self-heals, another keeper acts, or the mempool delays us. A naive bot would fire anyway — wasting gas at best, double-repaying at worst. `check-and-execute` makes the *chain itself* the final authority: the rescue transaction is gated on a fresh `HealthFactorLens.healthFactor(user)` read in the execution context. If the danger has passed, the check fails and nothing is spent. The agent's off-chain decision is a *proposal*; only the on-chain state at execution time can approve it. This turns a race-condition-riddled class of automation into something safe to sell to strangers.

## Reliability

The KeeperHub client (`src/keeperhub/`) treats every execution as hostile until proven landed:

- **Simulate-first** — every action is dry-run with `simulate: true` (gas estimate + `wouldRevert`/`revertReason`, no broadcast) before any live submission. `scripts/day1-verify.ts` never leaves simulation at all.
- **Deterministic idempotency keys** — every live execution carries an `Idempotency-Key` derived from (account, plan kind, asset, amount, threshold-crossing block), so crash-and-retry can never double-fire within KeeperHub's 24h per-org window. `409 idempotency_in_progress` means *poll, don't resend*; `409 idempotency_conflict` means the payload changed and a human should look.
- **Hint-honoring polling** — `GET /api/execute/{id}/status` is polled at exactly the server's `X-Poll-Interval-Hint`; hint `0` = terminal. No tight loops, no guessed backoffs, respectful of the 100 req/min limit.
- **Receipt verification** — an execution counts as done only when `receipts[]` shows `verified: true` with `receiptStatus: "success"`. `reverted` / `safe_inner_failure` / `not_found` / `timeout` each route to their own handling — a reverted rescue triggers re-planning, never a blind retry.
- **Retry taxonomy** — 4xx validation: never retried (fix the request); 409: poll or escalate as above; 429: back off per rate-limit headers; 5xx / network: retry with the *same* idempotency key; on-chain revert: re-read state, re-plan.
- **Audit trail** — every step emits an `AgentEvent` to an append-only local log (re-served over SSE by the dashboard, in progress).

## Quickstart

```bash
git clone <this-repo> lifeline && cd lifeline
npm install
cp .env.example .env      # paste KH_API_KEY (KeeperHub > Settings > API Keys > Organisation, kh_...)

npm run day1              # day-1 verification: proves every KeeperHub surface we use,
                          # 100% simulate-only, exit code = number of failed sections

# Deploy the on-chain gate (Foundry; see contracts/DEPLOY.md + contracts/addresses.md).
# HealthFactorLens is stateless — NO constructor args; pool + user are passed per-call.
(cd contracts && PRIVATE_KEY=0x<deployer-key> forge script script/Deploy.s.sol:Deploy \
  --rpc-url sepolia --broadcast)
# then fill LENS_ADDRESS_SEPOLIA / AAVE_POOL_SEPOLIA / GUARDED_ACCOUNT in .env

npm run agent             # start the guardian
npm test                  # vitest suites
```

`npm run day1` requires only the API key; it verifies auth, canonical chain/network identifiers, the action-registry schemas (diffed field-by-field against our pinned types), the hosted MCP tool surface, a simulated WETH deposit, a simulated `check-and-execute` gated on an arbitrary view function, and gas-sponsorship discovery — then prints a summary table and concrete next steps (which wallet to fund, what to deploy).

## Project layout

| Path                     | Purpose                                                                          |
| ------------------------ | -------------------------------------------------------------------------------- |
| `src/types.ts`           | **Pinned shared contract** — every module codes against these types              |
| `src/keeperhub/`         | REST client: executions, idempotency, hint-honoring polling, receipt verification |
| `src/planner/`           | Health-factor math, HF trajectory projection, minimal-rescue planner             |
| `src/agent/`             | Orchestrator: webhook server, detect->decide->execute loop, audit log            |
| `src/workflows/`         | KeeperHub workflow definitions (Block trigger, condition edges, webhook action)  |
| `contracts/`             | `HealthFactorLens.sol` view contract + verified Aave v3 addresses                |
| `scripts/day1-verify.ts` | Day-1 API verification CLI (simulate-only, never broadcasts)                     |
| `test/`                  | Vitest suites                                                                    |

## KeeperHub surfaces used

- [x] **Direct execution REST** — `POST /api/execute/contract-call` with `simulate: true` dry-runs (`abiFunction` + JSON-string `functionArgs`/`abi` field conventions)
- [x] **`check-and-execute`** — on-chain condition gating on a *custom view contract* (`HealthFactorLens`), the core of the safety story
- [x] **Workflows** — Block trigger + condition edges (`sourceHandle: 'true'`) + Webhook action + `{{@nodeId:Label.field}}` templating
- [x] **Hosted MCP** (`/mcp`, Streamable HTTP + Bearer) — `search_protocol_actions`, `execute_protocol_action` (aave-v3 slugs), `list_integrations`, `get_wallet_integration`, `validate_workflow`
- [x] **Execution lifecycle** — `Idempotency-Key` header, `X-Poll-Interval-Hint` polling, `receipts[].verified` checking
- [x] **Chain/registry discovery** — `GET /api/chains`, `GET /api/mcp/schemas` (day-1 script diffs our request shapes against the live registry)
- [ ] **Gas sponsorship / spend caps** — probed by the day-1 script; adopted if available on our org
- [ ] **x402 marketplace** — roadmap (below)

*(Checked items are integrated in this codebase and exercised by `npm run day1` / the agent; unchecked are probing or roadmap.)*

## Roadmap to demo

In progress, in order:

1. **Live Sepolia run** — fund the org wallet, deploy `HealthFactorLens`, open a deliberately fragile Aave v3 position, and record the full detect->decide->execute rescue with transaction links.
2. **x402 marketplace listing** — publish LIFELINE as a paid protection service: position owners pay per guarded epoch over x402, the agent guards any account that has paid.
3. **Per-workflow MCP** — expose each guarded position's workflow as its own MCP tool so other agents (or a wallet UI) can query guard status and request protection programmatically.
4. **SSE dashboard** — live `AgentEvent` stream (every tick, warning, plan, simulation, execution, receipt) rendered as a real-time audit trail.

**Honesty note:** everything above describes code in this repository and verified KeeperHub behavior. Transaction links, the x402 listing, and demo recordings will be added the moment they are real — no placeholders, no faked receipts.
