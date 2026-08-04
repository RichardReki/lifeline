// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal slice of the Aave v3 Pool interface needed by the lens.
interface IPool {
    /// @return totalCollateralBase total collateral, base currency (8-dec USD)
    /// @return totalDebtBase total debt, base currency (8-dec USD)
    /// @return availableBorrowsBase borrowing power left, base currency (8-dec USD)
    /// @return currentLiquidationThreshold weighted avg liquidation threshold, bps
    /// @return ltv weighted avg loan-to-value, bps
    /// @return healthFactor 1e18-scaled; type(uint256).max when no debt
    function getUserAccountData(address user)
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        );
}

/// @title HealthFactorLens
/// @notice Stateless view adapter over Aave v3's getUserAccountData.
/// @dev `healthFactorOf` collapses the 6-tuple into a SINGLE uint256 so that
///      KeeperHub's check-and-execute can gate on it with lt/gt operators
///      (its condition check compares one scalar return value).
///      No owner, no storage, no constructor args — safe to deploy anywhere
///      and share across pools/users, since both are passed per-call.
contract HealthFactorLens {
    /// @notice Health factor of `user` on `pool`, 1e18-scaled.
    ///         Returns type(uint256).max when the user has no debt.
    function healthFactorOf(address pool, address user) external view returns (uint256) {
        (,,,,, uint256 healthFactor) = IPool(pool).getUserAccountData(user);
        return healthFactor;
    }

    /// @notice Full Aave v3 account data passthrough for the off-chain agent.
    function accountData(address pool, address user)
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        )
    {
        return IPool(pool).getUserAccountData(user);
    }
}
