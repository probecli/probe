// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {ProbeJobs} from "../src/ProbeJobs.sol";

/// Deploys ProbeJobs and approves the verifier address.
///
///   OWNER=0x... VERIFIER=0x... forge script script/Deploy.s.sol \
///     --rpc-url $RPC_URL --account <keystore-name> --broadcast
///
/// The broadcasting account must be OWNER for the verifier approval to succeed,
/// or set VERIFIER to empty and approve it later from the owner account.
contract Deploy is Script {
    function run() external returns (ProbeJobs jobs) {
        address owner = vm.envAddress("OWNER");
        address verifier = vm.envOr("VERIFIER", address(0));

        vm.startBroadcast();
        jobs = new ProbeJobs(owner);
        if (verifier != address(0)) jobs.setVerifier(verifier, true);
        vm.stopBroadcast();

        console2.log("ProbeJobs:", address(jobs));
        console2.log("owner:", owner);
        console2.log("verifier:", verifier);
    }
}
