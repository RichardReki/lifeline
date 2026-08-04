# Deploying HealthFactorLens

`HealthFactorLens` is stateless (no constructor args, no owner, no storage), so the same
command works on any EVM chain. The deploy script reads the deployer key from the
`PRIVATE_KEY` env var.

All commands run from `contracts/`.

## Prerequisites

```sh
export PRIVATE_KEY=0x<deployer-private-key>   # funded on the target chain
```

(Git Bash / POSIX shown; in PowerShell use `$env:PRIVATE_KEY = "0x..."`.)

## Dry run first (no broadcast)

```sh
forge script script/Deploy.s.sol:Deploy --rpc-url sepolia
```

## Sepolia (chainId 11155111)

```sh
forge script script/Deploy.s.sol:Deploy \
  --rpc-url https://ethereum-sepolia-rpc.publicnode.com \
  --broadcast
```

## Base mainnet (chainId 8453)

```sh
forge script script/Deploy.s.sol:Deploy \
  --rpc-url https://mainnet.base.org \
  --broadcast
```

The `sepolia` / `base` aliases from `foundry.toml` `[rpc_endpoints]` also work in place of
the raw URLs: `--rpc-url sepolia`, `--rpc-url base`.

## Optional: verify source on the explorer

Append to either command:

```sh
  --verify --verifier etherscan --etherscan-api-key $ETHERSCAN_API_KEY
```

(Etherscan v2 API keys cover Sepolia and Basescan.)

## After deploying

1. The script logs `HealthFactorLens deployed at: 0x...` (also recorded under
   `broadcast/Deploy.s.sol/<chainId>/run-latest.json`).
2. Record the address in `addresses.md` under "HealthFactorLens deployments".
3. Sanity-check the deployment end to end (Sepolia example):

```sh
cast call <LENS_ADDRESS> "healthFactorOf(address,address)(uint256)" \
  0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951 \
  0x0000000000000000000000000000000000000001 \
  --rpc-url https://ethereum-sepolia-rpc.publicnode.com
# expect: 115792089237316195423570985008687907853269984665640564039457584007913129639935
```

For Base use pool `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` and
`--rpc-url https://mainnet.base.org`.

## Why the lens exists

KeeperHub's `check-and-execute` compares ONE scalar return value with
`eq/neq/gt/lt/gte/lte`. Aave's `getUserAccountData` returns a 6-tuple, which cannot be
gated directly. `healthFactorOf(pool, user)` collapses it to a single `uint256` (1e18
health factor), so the rescue action can be guarded on-chain at execution time with e.g.
`operator: "lt", value: "1500000000000000000"`.
