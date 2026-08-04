// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {HealthFactorLens} from "../src/HealthFactorLens.sol";

/// @notice Deploys the stateless HealthFactorLens. No constructor args, no config —
///         the same bytecode works on any chain with an Aave v3 Pool.
///         Reads deployer key from the PRIVATE_KEY env var.
contract Deploy is Script {
    function run() external returns (HealthFactorLens lens) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);
        lens = new HealthFactorLens();
        vm.stopBroadcast();
        console.log("HealthFactorLens deployed at:", address(lens));
    }
}
