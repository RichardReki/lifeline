# Aave v3 addresses (authoritative, verified)

Source: [bgd-labs/aave-address-book](https://github.com/bgd-labs/aave-address-book), raw `.sol`
files on `main` fetched 2026-08-04:

- `https://raw.githubusercontent.com/bgd-labs/aave-address-book/main/src/AaveV3Base.sol`
- `https://raw.githubusercontent.com/bgd-labs/aave-address-book/main/src/AaveV3Sepolia.sol`

## Base mainnet (chainId 8453) — library `AaveV3Base` / `AaveV3BaseAssets`

| Name | Address | Notes |
| --- | --- | --- |
| POOL | `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` | `IPool`, verified live below |
| WETH (underlying) | `0x4200000000000000000000000000000000000006` | 18 decimals |
| USDC (underlying) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | 6 decimals (native Circle USDC) |

## Sepolia testnet market (chainId 11155111) — library `AaveV3Sepolia` / `AaveV3SepoliaAssets`

Aave's test market — tokens are Aave-Faucet mintable mocks, NOT canonical Sepolia tokens.

| Name | Address | Notes |
| --- | --- | --- |
| POOL | `0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951` | `IPool`, verified live below |
| USDC (underlying) | `0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8` | 6 decimals |
| WETH (underlying) | `0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c` | 18 decimals |
| DAI (underlying) | `0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357` | 18 decimals |

## Live verification (run 2026-08-04, cast 1.7.1)

`getUserAccountData` called with the fresh address `0x...01`; both pools returned the
expected 6-tuple with `healthFactor = type(uint256).max` (no debt).

### Base

```
$ cast call 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5 \
    "getUserAccountData(address)(uint256,uint256,uint256,uint256,uint256,uint256)" \
    0x0000000000000000000000000000000000000001 \
    --rpc-url https://mainnet.base.org
0
0
0
0
0
115792089237316195423570985008687907853269984665640564039457584007913129639935 [1.157e77]
```

### Sepolia

```
$ cast call 0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951 \
    "getUserAccountData(address)(uint256,uint256,uint256,uint256,uint256,uint256)" \
    0x0000000000000000000000000000000000000001 \
    --rpc-url https://ethereum-sepolia-rpc.publicnode.com
0
0
0
0
0
115792089237316195423570985008687907853269984665640564039457584007913129639935 [1.157e77]
```

Both fork tests in `test/HealthFactorLens.t.sol` re-assert this through the deployed
`HealthFactorLens` (`forge test`, 8/8 passing on 2026-08-04).

## HealthFactorLens deployments

Filled in after `script/Deploy.s.sol` runs (see `DEPLOY.md`):

| Network | Address |
| --- | --- |
| Sepolia | _not deployed yet_ |
| Base | _not deployed yet_ |
