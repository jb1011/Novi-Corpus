// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DeployMinimalChecks} from "./DeployMinimal.t.sol";
import {DeployMinimal} from "../script/DeployMinimal.s.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";

/// @notice Runs the shipped Minimal deploy script against live Arc testnet state, with fresh keys
///         and the live identity registry, then uses what it deployed end to end: a link signed
///         by the identity owner, the owner's pointer, the guardian's dissolution and its cancel,
///         and the refusal of every full-product selector. Nothing is broadcast.
contract DeployMinimalForkTest is DeployMinimalChecks {
    address internal constant LIVE_REGISTRY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    uint256 internal constant ARC_TESTNET = 5042002;

    IIdentityRegistry internal registry = IIdentityRegistry(LIVE_REGISTRY);
    DeployMinimal internal script;
    uint256 internal agentId;
    bool internal forked;

    modifier onlyFork() {
        vm.skip(!forked);
        _;
    }

    function _supportsPush0() internal returns (bool ok) {
        bytes memory initcode = hex"5f";
        address probe;
        assembly {
            probe := create(0, add(initcode, 0x20), mload(initcode))
        }
        ok = probe != address(0);
    }

    function setUp() public {
        string memory url = vm.envOr("ARC_TESTNET_RPC_URL", string(""));
        if (bytes(url).length == 0 || !_supportsPush0()) {
            require(!vm.envOr("FORK_TESTS_REQUIRED", false), "fork tests required but would skip");
            return;
        }
        vm.createSelectFork(url);
        require(block.chainid == ARC_TESTNET, "ARC_TESTNET_RPC_URL is not Arc testnet");
        forked = true;

        _makeKeys();
        admin = makeAddr("forkMinimalAdmin");
        executor = makeAddr("forkMinimalExecutor");

        script = new DeployMinimal();
        d = script.deploy(_config(ARC_TESTNET, LIVE_REGISTRY));
        controller = d.controller;

        vm.prank(idOwner);
        agentId = registry.register("ipfs://minimal-novi-deploy-fork");
    }

    function test_fork_postConditionsHold() public onlyFork {
        _assertDeployment(LIVE_REGISTRY);
    }

    function test_fork_executorCreatesBody_ownerPointerLinks() public onlyFork {
        address body = _createBodyViaExecutor(agentId);
        assertEq(d.factory.identityOwnerAtCreation(body), idOwner);

        bytes memory pointer = d.factory.encodePointer(body); // read before the prank
        vm.prank(idOwner);
        registry.setMetadata(agentId, "legalBody", pointer);
        assertEq(d.factory.linkedLegalBody(agentId), body);
    }

    function test_fork_guardianInitiatesAndCancelsDissolution() public onlyFork {
        address body = _createBodyViaExecutor(agentId);
        bytes memory pointer = d.factory.encodePointer(body);
        vm.prank(idOwner);
        registry.setMetadata(agentId, "legalBody", pointer);

        _assertGuardianInitiatesAndCancels(body);
        assertEq(d.factory.linkedLegalBody(agentId), body, "linked again once Active");
    }

    function test_fork_executorCannotRelayFullProductSelectors() public onlyFork {
        _assertExecutorCannotRelayFullProduct(LIVE_REGISTRY, agentId);
    }

    function test_fork_nobodyHoldsWildcard() public onlyFork {
        bytes32 wildcard = controller.WILDCARD_ROLE();
        assertFalse(controller.hasRole(wildcard, admin));
        assertFalse(controller.hasRole(wildcard, executor));
        assertFalse(controller.hasRole(wildcard, deployer));
    }

    function test_fork_testnetScriptRefusesTheMainnetRegistry() public onlyFork {
        vm.expectRevert(bytes("IDENTITY_REGISTRY is not the registry pinned for this chain"));
        script.deploy(_config(ARC_TESTNET, 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432));
    }
}
