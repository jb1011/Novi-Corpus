// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ControllerSelectors} from "../src/libraries/ControllerSelectors.sol";
import {LegalBodyFactory} from "../src/LegalBodyFactory.sol";
import {LegalManager} from "../src/LegalManager.sol";
import {NoviController} from "../src/NoviController.sol";

/// @notice Deploys Minimal Novi in one broadcast: a fresh LegalManager implementation, a
///         LegalBodyFactory owned by the controller from construction, and a NoviController that
///         grants the executor only the two legal-body selectors and pins both to the factory in
///         its constructor. Nothing is relayable before it is pinned, and no admin transaction
///         follows: there is no acceptOwnership, no pin ceremony and no break-glass.
/// @dev    Env:
///           PRIVATE_KEY              throwaway deployer key; it ends up holding no role
///           CHAIN_ID                 must equal the connected chain's id
///           IDENTITY_REGISTRY        must equal the ERC-8004 registry pinned below for this chain
///           CONTROLLER_ADMIN         the cold role administrator (a hardware wallet on mainnet)
///           CONTROLLER_EXECUTOR      the backend key that relays the two legal-body selectors
///           CONTROLLER_ADMIN_DELAY   optional, seconds; defaults to 24 hours; on Arc mainnet it
///                                    must lie between 1 hour and 30 days
///
///         The factory needs the controller's address at construction and the controller needs
///         the factory's address for its pins, so the controller's address is predicted from the
///         deployer's nonce. The post-conditions check the prediction and every grant and pin
///         before the script returns, so a dry run that does not match reverts before anything
///         is broadcast.
contract DeployMinimal is Script {
    /// @dev The ERC-8004 identity registries this script accepts, by chain. A wrong registry is
    ///      the one input no post-condition can catch (the factory would bind to it for life),
    ///      so it is pinned here and the env value must match it.
    address internal constant REGISTRY_ARC_MAINNET = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address internal constant REGISTRY_ARC_TESTNET = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    uint256 internal constant CHAIN_ARC_MAINNET = 5042;
    uint256 internal constant CHAIN_ARC_TESTNET = 5042002;

    struct Config {
        uint256 deployerKey;
        uint256 chainId;
        address registry;
        address admin;
        address executor;
        uint48 adminDelay;
    }

    struct Deployment {
        LegalManager implementation;
        LegalBodyFactory factory;
        NoviController controller;
        uint256 controllerDeployBlock;
    }

    function run() external returns (Deployment memory d) {
        Config memory c = Config({
            deployerKey: vm.envUint("PRIVATE_KEY"),
            chainId: vm.envUint("CHAIN_ID"),
            registry: vm.envAddress("IDENTITY_REGISTRY"),
            admin: vm.envAddress("CONTROLLER_ADMIN"),
            executor: vm.envAddress("CONTROLLER_EXECUTOR"),
            adminDelay: _envAdminDelay()
        });
        // Printed before deploy() so a dry run shows every input before anything is broadcast.
        _printInputs(c);
        d = deploy(c);
        _printAddresses(d);
    }

    /// @dev CONTROLLER_ADMIN_DELAY in seconds, 24 hours when unset.
    function _envAdminDelay() internal view returns (uint48) {
        uint256 delay = vm.envOr("CONTROLLER_ADMIN_DELAY", uint256(24 hours));
        require(delay <= type(uint48).max, "CONTROLLER_ADMIN_DELAY does not fit in 48 bits");
        // Safe: the require above bounds `delay` to 48 bits.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint48(delay);
    }

    /// @notice The deploy itself, separate from the env reading so tests can drive it with
    ///         explicit inputs instead of process-wide environment variables.
    function deploy(Config memory c) public returns (Deployment memory d) {
        address deployer = vm.addr(c.deployerKey);
        _requirePreConditions(c, deployer);

        vm.startBroadcast(c.deployerKey);
        d.implementation = new LegalManager();
        // The implementation took one nonce; the factory takes the next and the controller the
        // one after it.
        uint256 nonce = vm.getNonce(deployer);
        address predicted = vm.computeCreateAddress(deployer, nonce + 1);
        d.factory = new LegalBodyFactory(address(d.implementation), c.registry, predicted);
        (bytes4[] memory pinSelectors, address[] memory pinTargets) =
            ControllerSelectors.minimalPins(address(d.factory));
        d.controller = new NoviController(
            c.adminDelay, c.admin, c.executor, ControllerSelectors.minimalGrants(), pinSelectors, pinTargets
        );
        vm.stopBroadcast();
        // In a dry run this is the simulated block, which is never later than the block the
        // transaction lands in, so it is safe as the start of a log scan. The broadcast receipt
        // gives the exact block.
        d.controllerDeployBlock = block.number;

        _requirePostConditions(d, predicted, c, deployer);
    }

    /// @dev The registry pinned for `chainId`, or zero when the chain has none.
    function _expectedRegistry(uint256 chainId) internal view virtual returns (address) {
        if (chainId == CHAIN_ARC_MAINNET) return REGISTRY_ARC_MAINNET;
        if (chainId == CHAIN_ARC_TESTNET) return REGISTRY_ARC_TESTNET;
        return address(0);
    }

    function _requirePreConditions(Config memory c, address deployer) internal view {
        require(c.chainId == block.chainid, "CHAIN_ID does not match the connected chain");
        address expected = _expectedRegistry(block.chainid);
        require(expected != address(0), "no identity registry is pinned for this chain");
        require(c.registry == expected, "IDENTITY_REGISTRY is not the registry pinned for this chain");
        require(c.registry.code.length > 0, "IDENTITY_REGISTRY is not a contract");
        require(c.admin != address(0) && c.executor != address(0), "admin and executor are required");
        require(c.admin != c.executor, "admin and executor must differ");
        require(deployer != c.admin && deployer != c.executor, "the deployer must hold no role");
        if (block.chainid == CHAIN_ARC_MAINNET) {
            // A zero delay lets a mistaken or stolen admin hand the role over at once. An oversized
            // one cannot be undone quickly: shortening the delay waits out the difference between
            // the current and the new value. Testnet keeps no bound.
            require(c.adminDelay >= 1 hours, "CONTROLLER_ADMIN_DELAY is under 1 hour");
            require(c.adminDelay <= 30 days, "CONTROLLER_ADMIN_DELAY is over 30 days (a value in milliseconds?)");
        }
    }

    function _requirePostConditions(Deployment memory d, address predicted, Config memory c, address deployer)
        internal
        view
    {
        NoviController controller = d.controller;
        LegalBodyFactory factory = d.factory;

        require(address(controller) == predicted, "controller address prediction failed");
        require(factory.owner() == address(controller), "factory owner is not the controller");
        require(factory.pendingOwner() == address(0), "factory has a pending owner");
        require(factory.implementation() == address(d.implementation), "factory implementation");
        require(address(factory.identityRegistry()) == c.registry, "factory registry");

        bytes4[] memory minimal = ControllerSelectors.minimalGrants();
        for (uint256 i = 0; i < minimal.length; i++) {
            require(controller.boundTarget(minimal[i]) == address(factory), "minimal selector not pinned to the factory");
            require(controller.hasRole(bytes32(minimal[i]), c.executor), "executor lacks a minimal grant");
            require(!controller.hasRole(bytes32(minimal[i]), deployer), "deployer holds a minimal grant");
            require(!controller.hasRole(bytes32(minimal[i]), c.admin), "admin holds a minimal grant");
        }
        bytes4[] memory full = ControllerSelectors.granted();
        for (uint256 i = 0; i < full.length; i++) {
            require(!controller.hasRole(bytes32(full[i]), c.executor), "executor holds a full-product grant");
            require(controller.boundTarget(full[i]) == address(0), "a full-product selector is pinned");
        }

        bytes32 wildcard = controller.WILDCARD_ROLE();
        require(
            !controller.hasRole(wildcard, c.admin) && !controller.hasRole(wildcard, c.executor)
                && !controller.hasRole(wildcard, deployer),
            "WILDCARD_ROLE is held"
        );
        require(controller.defaultAdmin() == c.admin, "default admin is not CONTROLLER_ADMIN");
        require(controller.defaultAdminDelay() == c.adminDelay, "default admin delay");
        (address pendingAdmin,) = controller.pendingDefaultAdmin();
        require(pendingAdmin == address(0), "a default admin handover is pending");
        bytes32 adminRole = controller.DEFAULT_ADMIN_ROLE();
        require(
            !controller.hasRole(adminRole, deployer) && !controller.hasRole(adminRole, c.executor),
            "DEFAULT_ADMIN_ROLE is held by the deployer or the executor"
        );
    }

    /// @dev Prints the inputs the deploy will use, so the operator checks them before a broadcast.
    function _printInputs(Config memory c) internal view {
        console2.log("Inputs:");
        console2.log("  chain id (connected):", block.chainid);
        console2.log("  deployer (from PRIVATE_KEY):", vm.addr(c.deployerKey));
        console2.log("  CONTROLLER_ADMIN, compare with the hardware wallet's screen:", c.admin);
        console2.log("  CONTROLLER_EXECUTOR:", c.executor);
        console2.log("  CONTROLLER_ADMIN_DELAY (seconds):", uint256(c.adminDelay));
        console2.log("  IDENTITY_REGISTRY:", c.registry);
    }

    /// @dev Prints the block to copy into addresses.arc-mainnet.json (or the testnet file).
    function _printAddresses(Deployment memory d) internal view {
        console2.log("All post-conditions hold. Addresses for the addresses file:");
        console2.log("{");
        console2.log('  "ours": {');
        console2.log(string.concat('    "legalManagerImpl": "', vm.toString(address(d.implementation)), '",'));
        console2.log(string.concat('    "legalBodyFactory": "', vm.toString(address(d.factory)), '",'));
        console2.log(string.concat('    "noviController": "', vm.toString(address(d.controller)), '",'));
        console2.log(string.concat('    "controllerDeployBlock": "', vm.toString(d.controllerDeployBlock), '"'));
        console2.log("  },");
        console2.log(string.concat('  "reused": { "identityRegistry": "', vm.toString(address(d.factory.identityRegistry())), '" }'));
        console2.log("}");
        console2.log("controllerDeployBlock is the simulated block, a lower bound; take the exact block");
        console2.log("from the controller's receipt in the broadcast log after --broadcast.");
    }
}
