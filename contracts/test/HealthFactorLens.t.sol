// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HealthFactorLens, IPool} from "../src/HealthFactorLens.sol";

/// @dev Configurable mock of Aave v3 getUserAccountData.
contract MockPool is IPool {
    uint256 public totalCollateralBase;
    uint256 public totalDebtBase;
    uint256 public availableBorrowsBase;
    uint256 public currentLiquidationThreshold;
    uint256 public ltv;
    uint256 public healthFactor;

    function set(
        uint256 _totalCollateralBase,
        uint256 _totalDebtBase,
        uint256 _availableBorrowsBase,
        uint256 _currentLiquidationThreshold,
        uint256 _ltv,
        uint256 _healthFactor
    ) external {
        totalCollateralBase = _totalCollateralBase;
        totalDebtBase = _totalDebtBase;
        availableBorrowsBase = _availableBorrowsBase;
        currentLiquidationThreshold = _currentLiquidationThreshold;
        ltv = _ltv;
        healthFactor = _healthFactor;
    }

    function getUserAccountData(address)
        external
        view
        returns (uint256, uint256, uint256, uint256, uint256, uint256)
    {
        return (
            totalCollateralBase,
            totalDebtBase,
            availableBorrowsBase,
            currentLiquidationThreshold,
            ltv,
            healthFactor
        );
    }
}

contract HealthFactorLensUnitTest is Test {
    HealthFactorLens internal lens;
    MockPool internal pool;

    address internal constant USER = address(0xBEEF);

    function setUp() public {
        lens = new HealthFactorLens();
        pool = new MockPool();
    }

    function test_healthFactorOf_passesThroughSingleUint() public {
        // At-risk position: HF 1.02, exactly the shape check-and-execute gates on (lt "1050000000000000000").
        pool.set(10_000e8, 8_000e8, 0, 8250, 8000, 1.02e18);
        assertEq(lens.healthFactorOf(address(pool), USER), 1.02e18);
    }

    function test_healthFactorOf_maxWhenNoDebt() public {
        pool.set(0, 0, 0, 0, 0, type(uint256).max);
        assertEq(lens.healthFactorOf(address(pool), USER), type(uint256).max);
    }

    function test_accountData_returnsAllSixValues() public {
        pool.set(10_000e8, 8_000e8, 123e8, 8250, 8000, 1.02e18);
        (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        ) = lens.accountData(address(pool), USER);
        assertEq(totalCollateralBase, 10_000e8);
        assertEq(totalDebtBase, 8_000e8);
        assertEq(availableBorrowsBase, 123e8);
        assertEq(currentLiquidationThreshold, 8250);
        assertEq(ltv, 8000);
        assertEq(healthFactor, 1.02e18);
    }

    function testFuzz_healthFactorOf_matchesPool(uint256 hf) public {
        pool.set(1e8, 1e8, 0, 8000, 7500, hf);
        assertEq(lens.healthFactorOf(address(pool), USER), hf);
    }
}

/// @dev Fork tests against live Aave v3 deployments. Addresses from
///      bgd-labs/aave-address-book (see ../addresses.md, verified with cast).
///      Public RPCs can be flaky/rate-limited — a failure here with an RPC/HTTP
///      error is environmental, not a contract bug.
contract HealthFactorLensForkTestBase is Test {
    address internal constant AAVE_V3_BASE_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    // Fresh address: never touched Aave, so no debt -> HF = type(uint256).max.
    address internal constant FRESH = address(0x1);

    HealthFactorLens internal lens;

    function setUp() public {
        vm.createSelectFork("https://mainnet.base.org");
        lens = new HealthFactorLens();
    }

    function test_fork_base_healthFactorOf_freshAddressIsMax() public view {
        assertEq(lens.healthFactorOf(AAVE_V3_BASE_POOL, FRESH), type(uint256).max);
    }

    function test_fork_base_accountData_returnsSixValues() public view {
        (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            ,
            ,
            ,
            uint256 healthFactor
        ) = lens.accountData(AAVE_V3_BASE_POOL, FRESH);
        assertEq(totalCollateralBase, 0);
        assertEq(totalDebtBase, 0);
        assertEq(healthFactor, type(uint256).max);
    }
}

contract HealthFactorLensForkTestSepolia is Test {
    address internal constant AAVE_V3_SEPOLIA_POOL = 0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951;
    address internal constant FRESH = address(0x1);

    HealthFactorLens internal lens;

    function setUp() public {
        vm.createSelectFork("https://ethereum-sepolia-rpc.publicnode.com");
        lens = new HealthFactorLens();
    }

    function test_fork_sepolia_healthFactorOf_freshAddressIsMax() public view {
        assertEq(lens.healthFactorOf(AAVE_V3_SEPOLIA_POOL, FRESH), type(uint256).max);
    }

    function test_fork_sepolia_accountData_returnsSixValues() public view {
        (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            ,
            ,
            ,
            uint256 healthFactor
        ) = lens.accountData(AAVE_V3_SEPOLIA_POOL, FRESH);
        assertEq(totalCollateralBase, 0);
        assertEq(totalDebtBase, 0);
        assertEq(healthFactor, type(uint256).max);
    }
}
