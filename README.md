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

## Why KeeperHub and not just an API call?

A fair question to ask of anything built on an execution layer: what would break if this agent talked to an RPC endpoint directly? Three things, and this project hit all three for real rather than in theory.

| A plain API call… | KeeperHub | What happened here |
| --- | --- | --- |
| fires whatever the caller decided, whenever it lands | `check-and-execute` re-reads the condition **on-chain, in the execution context**, and drops the write if it no longer holds | The rescue repay is gated on `HealthFactorLens.healthFactorOf < 1.3e18`. The agent's decision is a *proposal*; the chain approves it or nothing is spent |
| double-spends when you retry a request whose response you never saw | `Idempotency-Key` replays the original execution instead of sending a second one | Re-running the starter script returned the **same `executionId` and tx hash**, no second broadcast. And rescue #2 hit a real `409 idempotency_conflict` from a key bug of ours — a plain API would have silently repaid twice |
| tells you a transaction was *sent* | `receipts[].verified` + `receiptStatus` tell you it **landed and succeeded** | Nothing in this agent counts as done until the receipt verifies; `reverted` / `timeout` / `not_found` each route to different handling |

On top of that: gas sponsorship (these Sepolia executions cost the wallet nothing), congestion-aware gas estimation, and an execution history the workflow layer keeps for you.

The honest version: an agent *can* be built on raw RPC. It just has to reimplement all of the above, badly, before it can be trusted with someone else's collateral — which is the whole reason LIFELINE is sellable to a stranger at $0.05 a call.

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

A second crash-and-rescue cycle ran the next day and is worth reading the commit log for: a *static* idempotency label collided inside KeeperHub's 24h window and returned `409 idempotency_conflict` — the exact failure this README claims to prevent, caught by running the thing in anger rather than by reasoning about it. Keys are now derived from rescue intent (account, plan kind, asset, amount), and rescue #2 landed clean: [`0x842f…cfa7`](https://sepolia.etherscan.io/tx/0x842f3896b59cc4fc66c1e8545c66e395f881249e2fb96924c2acd28e2902cfa7).

### The guard on duty

`LIFELINE HF Monitor` (Block trigger, every 25 Sepolia blocks) has been enabled and running continuously. The 50 most recent runs at time of writing:

| Metric | Value |
| --- | --- |
| Success rate | **50/50 (100%)** |
| Trigger interval | 296–325 s (p50 **311 s**) — 25 blocks at ~12.4 s |
| Steps per run | 3/4 — trigger → lens read → condition; the alert leg correctly stays unexecuted |
| Condition outcome | `false` × 50 — health factor above threshold every time |
| Trigger source | `block` (no manual runs in the window) |

Fifty consecutive runs that correctly decided **not** to act is the half of automation nobody demos. Paired with the two rescues above — where the same pipeline did act, and only because the chain re-confirmed the danger — that is the whole safety claim in one dataset.

### Someone actually paid

Protection is a product, so the seller side had to work for a stranger. `lifeline-rescue-check` is listed on the KeeperHub marketplace at **$0.05/call**; `POST` it unauthenticated and it answers with a dual-rail 402 — x402 v2 on Base USDC *and* Tempo/MPP on chain 4217, same price, same payee, one response.

A buyer agent with its own Turnkey wallet — a different identity from the guarded position's — then paid it for real:

| | |
| --- | --- |
| Settlement | [`0xfdd6…1f0c`](https://basescan.org/tx/0xfdd675949e148280bb2a2dd74a17445824c5ec1749f96f68a1c5eb483a231f0c) — 0.05 USDC, Base mainnet, EIP-3009 `TransferWithAuthorization` |
| Buyer | `0xDaC3…99d4` → 10.00 → 9.95 USDC |
| Seller | `0xE204…7467` → +0.05 USDC |
| Protocol used | `x402` (the wallet picked it from the dual-rail challenge) |
| Response | HF `1649812249271816192` — the same lens read the rescue gate uses |

The call also came back carrying an **ERC-8004 identity** for the workflow ([agent 31875](https://8004scan.io/agents/ethereum/31875) on the Ethereum registry) and an invitation for the payer to sign on-chain reputation feedback for the execution it just bought. Discovery on x402scan, identity and reputation on ERC-8004, settlement on Base: the whole agent-commerce stack, exercised by one $0.05 call.

Reproduce both halves yourself:

```bash
npx tsx scripts/day5-buyer.ts challenge   # free — decodes the dual-rail 402
npx tsx scripts/day5-buyer.ts buy         # real payment, needs a funded wallet
```

## For the next builder

Everything we tripped over on the way here became **[keeperhub-agent-starter](https://github.com/RichardReki/keeperhub-agent-starter)**: your agent's first receipt-verified KeeperHub transaction in under 10 minutes, plus field notes on 9 onboarding traps (with repros and proposed fixes) in its [teardown](https://github.com/RichardReki/keeperhub-agent-starter/blob/main/teardown/TEARDOWN.md).

Filed upstream while building:

- **[PR #1926](https://github.com/KeeperHub/keeperhub/pull/1926) — merged into `staging`.** Every "Edit this page" link on docs.keeperhub.com was 404ing. The branch was only half the bug; the other half was the `content/` segment Nextra reports because `docs-site/content` is a symlink to `../docs`. Verified by building the docs site locally and checking all 172 rendered links against the branch. The maintainer merged it and generalised the fix into a `toDocsRelativePath()` helper that also covers the symlink-resolved layout our repro couldn't produce on Windows.
- **[Issues #1927–#1933](https://github.com/KeeperHub/keeperhub/issues?q=is%3Aissue+author%3ARichardReki)** — each with expect/actual, a copy-paste repro, and a proposed fix. Three are funds-risk: protocol actions silently ignore `simulate` and broadcast for real; `value` is parsed as ether by a function named `parseNativeValueWei`; `check-and-execute` silently string-compares multi-output views instead of erroring.

  **All seven were confirmed by the maintainer at source level.** `#1929` was called *"the highest-severity item in the queue"*, and it — together with two of the others — was escalated into [**#2004**](https://github.com/KeeperHub/keeperhub/issues/2004), a tracking issue carrying the invariant the reports converged on: *`simulate` behaves uniformly across `/api/execute/*` — a route either honours a dry run or refuses one, and never accepts the flag and broadcasts.* Their own audit of that invariant then found a fourth affected surface we had not reported: `?simulate=` as a query parameter is silently ignored on every route.

**Honesty note:** every claim above is a real execution against `app.keeperhub.com` — no placeholders, no faked receipts. Demo video: coming with the submission.
