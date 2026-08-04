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

- [x] **Direct execution REST** — `POST /api/execute/{transfer,contract-call,check-and-execute}` with `simulate: true` dry-runs (real schema: numeric `chainId` + `functionName`; JSON-string `functionArgs`/`abi`)
- [x] **`check-and-execute`** — on-chain condition gating on a *custom view contract* (`HealthFactorLens`), the core of the safety story — **used in anger for a live rescue** (below)
- [x] **Protocol actions** — `aave-v3/supply` / `aave-v3/borrow` by slug for position management
- [x] **Workflows** — Block trigger + `web3/read-contract` on the lens + Condition edges (`sourceHandle: 'true'`) + alert leg, running live (`enabled: true`) every 25 Sepolia blocks
- [x] **Hosted MCP** (`/mcp`, Streamable HTTP + Bearer) — `search_protocol_actions`, `list_integrations`, `update_workflow_listing`, `list_workflow`
- [x] **x402 / MPP marketplace** — `lifeline-rescue-check` listed at $0.05/call; the unauthenticated endpoint answers with a dual-protocol payment challenge (x402 v2 on Base USDC **and** Tempo/MPP `www-authenticate`)
- [x] **Execution lifecycle** — `Idempotency-Key` header (cached-replay and 409-conflict both observed live), `X-Poll-Interval-Hint` polling, `receipts[].verified` checking
- [x] **Gas sponsorship** — every Sepolia execution below ran `sponsored: true` (relayed), which is why receipts/`transactionLink`, not the org wallet's explorer history, are the proof
- [x] **Chain/registry discovery** — `GET /api/chains`, `GET /api/mcp/schemas` (day-1 script diffs our request shapes against the live registry)

## Live on Sepolia — on-chain proof

Everything below happened through KeeperHub, unattended where it matters. Org wallet (Turnkey-custodied): `0xE20405094C45b4F9adc050C429F2F45C72fF7467`. Lens: [`0x0D7D746d915B885a61897f4f6CF38372e2f5a802`](https://sepolia.etherscan.io/address/0x0D7D746d915B885a61897f4f6CF38372e2f5a802).

| Step | KeeperHub surface | Tx |
|---|---|---|
| Fund deployer (0.02 ETH) | direct `transfer` | [`0x4b61…c78d`](https://sepolia.etherscan.io/tx/0x4b61b8b6c32aa0c7692560f37b16468c73a83d9ff6faed5c8835e616afd4c78d) |
| Mint 2 WBTC (test faucet) | `contract-call` | [`0x710f…7080`](https://sepolia.etherscan.io/tx/0x710f142ec206e366871723603882a950704523df9a007560f4e94f94a5c37080) |
| Mint 2,000 LINK (rescue float) | `contract-call` | [`0xa044…1347`](https://sepolia.etherscan.io/tx/0xa0448e1a3d9d77ab8e146139a48fc127716ea1203fc614f336261a8978861347) |
| Approve Pool for WBTC | `contract-call` | [`0x6b4c…b605`](https://sepolia.etherscan.io/tx/0x6b4c6009431f0e6bcfc358610f1a59306c5fe3b8084f6284416532aa1ae4b605) |
| Supply 1 WBTC ($60k collateral) | `aave-v3/supply` | [`0xdff5…94b6`](https://sepolia.etherscan.io/tx/0xdff59360694160ebeeda5807d4f2698a61ba2a09e1dd18a64281efe2329e94b6) |
| Borrow 909 LINK → HF 1.65 | `aave-v3/borrow` | [`0xaa7d…454d`](https://sepolia.etherscan.io/tx/0xaa7d3ffba86249b6506168328730d2614df16eb81ebd308a6e8e0b94cbca454d) |
| **Crash**: borrow +395 LINK → HF 1.15 | `aave-v3/borrow` | [`0xb371…abf1`](https://sepolia.etherscan.io/tx/0xb3713be9c153122cbb1fbb22b4c5045fd07c96fa97d7d51b4b6ccbfe8ab1abf1) |
| Agent: approve LINK for repay | `contract-call` via `ReliableExecutor` | [`0xfa77…c89b`](https://sepolia.etherscan.io/tx/0xfa77ec86f456e26c5ddc7ab8dbb34203d216eef0f3ad9f7d2961edd5cdcfc89b) |
| **Agent rescue: repay 304 LINK, HF-gated on-chain → HF 1.50** | **`check-and-execute`** | [`0x88f7…9450`](https://sepolia.etherscan.io/tx/0x88f745c9eb4325c5a8c5c8905eb204a040953bb98667443fdfb12a3ccd819450) |

The two bold rows are the story: a position deliberately crashed to HF 1.15, and the agent — with no human in the loop — detected it, planned the minimal-cost rescue, and landed a repay through `check-and-execute`, whose condition (`HealthFactorLens.healthFactorOf < 1.3e18`) was **re-verified on-chain in the same transaction that executed the rescue**. Debt went $39,130 → $29,909; HF closed at 1.5046 against a 1.5 target.

Also live right now:

- **`LIFELINE HF Monitor`** — Block-trigger workflow, enabled, reads the lens every 25 blocks and alerts when HF < 1.3.
- **[`lifeline-rescue-check`](https://app.keeperhub.com/api/mcp/workflows/lifeline-rescue-check/call)** — $0.05/call marketplace listing; `POST` it unauthenticated and you get the dual-protocol 402 challenge back.

## For the next builder

Everything we tripped over on the way here became **[keeperhub-agent-starter](https://github.com/RichardReki/keeperhub-agent-starter)**: your agent's first receipt-verified KeeperHub transaction in under 10 minutes, plus field notes on 9 onboarding traps (with repros and proposed fixes) in its [teardown](https://github.com/RichardReki/keeperhub-agent-starter/blob/main/teardown/TEARDOWN.md).

**Honesty note:** every claim above is a real execution against `app.keeperhub.com` — no placeholders, no faked receipts. Demo video: coming with the submission.
