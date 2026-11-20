// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ControllerRelayHarness} from "./helpers/ControllerRelayHarness.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";
import {DeployMinimal} from "../script/DeployMinimal.s.sol";
import {ControllerSelectors} from "../src/libraries/ControllerSelectors.sol";
import {NoviController} from "../src/NoviController.sol";
import {LegalBody} from "../src/LegalBody.sol";
import {LegalBodyFactory} from "../src/LegalBodyFactory.sol";
import {LegalManager} from "../src/LegalManager.sol";
import {LegalManagerFactory} from "../src/LegalManagerFactory.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";
import {LegalBodyV2Mock} from "./mocks/LegalBodyVersions.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";

/// @dev The shipped script accepts only the registry pinned for Arc mainnet or Arc testnet. A
///      local chain (id 31337) has neither, so this subclass accepts the mock registry there and
///      only there; every other chain still goes through the script's own pins.
contract DeployMinimalLocal is DeployMinimal {
    address internal immutable LOCAL_REGISTRY;

    constructor(address localRegistry) {
        LOCAL_REGISTRY = localRegistry;
    }

    function _expectedRegistry(uint256 chainId) internal view override returns (address) {
        if (chainId == 31337) return LOCAL_REGISTRY;
        return super._expectedRegistry(chainId);
    }
}

/// @notice Shared checks for the Minimal deploy, used by the local suite and the fork suite: the
///         script's post-conditions asserted again from outside it, and the relay helpers that
///         exercise the deployed controller the way the backend does.
abstract contract DeployMinimalChecks is ControllerRelayHarness {
    bytes32 internal constant OA = keccak256("oa-manifest-v1");
    uint256 internal constant DELAY = 48 hours;

    address internal deployer;
    uint256 internal deployerPk;
    address internal idOwner;
    uint256 internal idOwnerPk;
    address internal guardian;
    uint256 internal guardianPk;

    DeployMinimal.Deployment internal d;

    function _makeKeys() internal {
        (deployer, deployerPk) = makeAddrAndKey("minimalDeployer");
        (idOwner, idOwnerPk) = makeAddrAndKey("minimalIdentityOwner");
        (guardian, guardianPk) = makeAddrAndKey("minimalGuardian");
        vm.deal(deployer, 100 ether);
    }

    function _config(uint256 chainId, address registry) internal view returns (DeployMinimal.Config memory) {
        return DeployMinimal.Config({
            deployerKey: deployerPk,
            chainId: chainId,
            registry: registry,
            admin: admin,
            executor: executor,
            adminDelay: 24 hours
        });
    }

    function _assertDeployment(address registry) internal view {
        LegalBodyFactory factory = d.factory;
        assertGt(address(d.implementation).code.length, 0, "implementation deployed");
        assertEq(factory.owner(), address(controller), "factory owned by the controller");
        assertEq(factory.pendingOwner(), address(0), "no pending factory owner");
        assertEq(factory.implementation(), address(d.implementation), "factory implementation");
        assertEq(address(factory.identityRegistry()), registry, "factory registry");
        assertEq(d.implementation.manager(), address(0), "implementation is uninitialised");

        bytes4[] memory minimal = ControllerSelectors.minimalGrants();
        assertEq(minimal.length, 2);
        for (uint256 i = 0; i < minimal.length; i++) {
            assertEq(controller.boundTarget(minimal[i]), address(factory), "minimal selector pinned to the factory");
            assertTrue(controller.hasRole(bytes32(minimal[i]), executor), "executor holds the minimal grant");
            assertFalse(controller.hasRole(bytes32(minimal[i]), deployer), "deployer holds no minimal grant");
            assertFalse(controller.hasRole(bytes32(minimal[i]), admin), "admin holds no minimal grant");
        }
        bytes4[] memory full = ControllerSelectors.granted();
        assertEq(full.length, 7);
        for (uint256 i = 0; i < full.length; i++) {
            assertFalse(controller.hasRole(bytes32(full[i]), executor), "no full-product grant");
            assertEq(controller.boundTarget(full[i]), address(0), "no full-product pin");
        }

        bytes4[] memory release = ControllerSelectors.minimalReleaseSelectors();
        assertEq(release.length, 2);
        for (uint256 i = 0; i < release.length; i++) {
            assertEq(controller.boundTarget(release[i]), address(factory), "release selector pinned to the factory");
            assertFalse(controller.hasRole(bytes32(release[i]), executor), "executor holds no release selector");
            assertFalse(controller.hasRole(bytes32(release[i]), admin), "admin holds no release selector");
            assertFalse(controller.hasRole(bytes32(release[i]), deployer), "deployer holds no release selector");
        }

        assertEq(factory.versionCount(), 1, "one version listed");
        LegalBodyFactory.Version memory first = factory.versionInfo(1);
        assertEq(first.implementation, address(d.implementation), "version 1 is the implementation");
        assertEq(first.codehash, address(d.implementation).codehash, "version 1 code hash");
        assertFalse(first.withdrawn, "version 1 is live");
        assertEq(
            factory.proxyInitCodeHash(),
            keccak256(
                abi.encodePacked(type(ERC1967Proxy).creationCode, abi.encode(address(d.implementation), bytes("")))
            ),
            "the proxy the factory predicts addresses for"
        );

        bytes32 wildcard = controller.WILDCARD_ROLE();
        assertFalse(controller.hasRole(wildcard, admin), "admin holds no wildcard");
        assertFalse(controller.hasRole(wildcard, executor), "executor holds no wildcard");
        assertFalse(controller.hasRole(wildcard, deployer), "deployer holds no wildcard");

        assertEq(controller.defaultAdmin(), admin, "default admin");
        assertEq(controller.defaultAdminDelay(), 24 hours, "default admin delay");
        bytes32 adminRole = controller.DEFAULT_ADMIN_ROLE();
        assertTrue(controller.hasRole(adminRole, admin));
        assertFalse(controller.hasRole(adminRole, deployer), "deployer is not an admin");
        assertFalse(controller.hasRole(adminRole, executor), "executor is not an admin");
        assertLe(d.controllerDeployBlock, block.number, "deploy block is not in the future");
    }

    function _sig(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _createBodyViaExecutor(uint256 agentId) internal returns (address body) {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory link = _sig(idOwnerPk, d.factory.linkDigest(agentId, guardian, DELAY, OA, deadline));
        bytes memory ret = _relayOk(
            executor,
            address(d.factory),
            abi.encodeCall(LegalBodyFactory.createLegalBody, (agentId, guardian, DELAY, OA, deadline, link))
        );
        body = abi.decode(ret, (address));
    }

    function _assertExecutorCannotRelayFullProduct(address registry, uint256 agentId) internal {
        bytes4 createEntity = LegalManagerFactory.createEntity.selector;
        (bool ok, bytes memory ret) =
            _relay(executor, address(d.factory), abi.encodeWithSelector(createEntity, address(controller)));
        assertFalse(ok, "createEntity relayed");
        assertEq(ret, abi.encodeWithSelector(NoviController.NotAuthorized.selector, createEntity, executor));

        bytes4 setMetadata = IIdentityRegistry.setMetadata.selector;
        (ok, ret) =
            _relay(executor, registry, abi.encodeCall(IIdentityRegistry.setMetadata, (agentId, "legalBody", "")));
        assertFalse(ok, "setMetadata relayed");
        assertEq(ret, abi.encodeWithSelector(NoviController.NotAuthorized.selector, setMetadata, executor));
    }

    /// @dev Neither the executor nor the administrator can relay a release selector as deployed:
    ///      nobody holds either one.
    function _assertNobodyCanRelayRelease() internal {
        bytes memory publish = abi.encodeCall(LegalBodyFactory.publishVersion, (address(d.implementation)));
        bytes memory withdraw = abi.encodeCall(LegalBodyFactory.withdrawVersion, (1));
        address[2] memory callers = [executor, admin];
        for (uint256 i = 0; i < callers.length; i++) {
            (bool ok, bytes memory ret) = _relay(callers[i], address(d.factory), publish);
            assertFalse(ok, "publishVersion relayed");
            assertEq(
                ret,
                abi.encodeWithSelector(
                    NoviController.NotAuthorized.selector, LegalBodyFactory.publishVersion.selector, callers[i]
                )
            );
            (ok, ret) = _relay(callers[i], address(d.factory), withdraw);
            assertFalse(ok, "withdrawVersion relayed");
            assertEq(
                ret,
                abi.encodeWithSelector(
                    NoviController.NotAuthorized.selector, LegalBodyFactory.withdrawVersion.selector, callers[i]
                )
            );
        }
    }

    /// @dev A whole release on the deployed contracts: the administrator publishes a version 2
    ///      through a single-use helper, the guardian signs, a stranger schedules, the guardian
    ///      cancels, signs again, the delay passes, a stranger executes, and the administrator
    ///      withdraws the version afterwards. The body ends on version 2 with its record intact.
    function _assertReleaseAndGuardianUpgrade(address body) internal {
        LegalBodyFactory factory = d.factory;
        address stranger = makeAddr("releaseStranger");
        LegalBodyV2Mock v2 = new LegalBodyV2Mock();

        bytes memory ret = _breakGlass(address(factory), abi.encodeCall(LegalBodyFactory.publishVersion, (address(v2))));
        assertEq(abi.decode(ret, (uint256)), 2, "published as version 2");
        assertEq(factory.versionCount(), 2);
        assertEq(factory.versionOf(body), 1, "publishing moves no body");

        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sig(guardianPk, factory.upgradeDigest(body, 2, address(v2), 0, deadline));
        vm.prank(stranger);
        factory.scheduleLegalBodyUpgrade(body, 2, deadline, sig);
        vm.prank(guardian);
        factory.cancelLegalBodyUpgrade(body);
        (uint64 pending,) = factory.pendingUpgrade(body);
        assertEq(pending, 0, "cancelled");

        // The cancel used up a nonce, so the second signature carries the body's current one.
        assertEq(factory.upgradeNonce(body), 2);
        sig = _sig(guardianPk, factory.upgradeDigest(body, 2, address(v2), 2, deadline));
        vm.prank(stranger);
        factory.scheduleLegalBodyUpgrade(body, 2, deadline, sig);
        vm.warp(block.timestamp + DELAY);
        vm.prank(stranger);
        factory.executeLegalBodyUpgrade(body);

        assertEq(factory.versionOf(body), 2);
        assertEq(address(uint160(uint256(vm.load(body, ERC1967Utils.IMPLEMENTATION_SLOT)))), address(v2));
        assertEq(LegalBody(payable(body)).initializedVersion(), 2);
        assertEq(LegalBodyV2Mock(payable(body)).added(), 42, "the version's one-time step ran");
        assertEq(LegalManager(payable(body)).guardian(), guardian);
        assertEq(LegalManager(payable(body)).manager(), address(factory));
        (address recordedGuardian, uint64 recordedDelay, uint32 recordedVersion) = factory.bodyRecord(body);
        assertEq(recordedGuardian, guardian);
        assertEq(recordedDelay, DELAY);
        assertEq(recordedVersion, 2);

        _breakGlass(address(factory), abi.encodeCall(LegalBodyFactory.withdrawVersion, (2)));
        assertTrue(factory.versionInfo(2).withdrawn, "withdrawn");
        assertEq(factory.versionOf(body), 2, "a body already on a withdrawn version stays on it");
    }

    function _assertGuardianInitiatesAndCancels(address body) internal {
        LegalManager lm = LegalManager(payable(body));
        assertEq(uint8(lm.status()), uint8(LegalManager.Status.Active));
        vm.prank(guardian);
        lm.initiateDissolution();
        assertEq(uint8(lm.status()), uint8(LegalManager.Status.WindingDown));
        vm.prank(guardian);
        lm.cancelDissolution();
        assertEq(uint8(lm.status()), uint8(LegalManager.Status.Active), "back to Active");
    }
}

/// @notice The Minimal deploy on a local chain against the mock registry: the script's own
///         post-conditions, the resulting controller used end to end, and every pre-check refusal.
contract DeployMinimalTest is DeployMinimalChecks {
    MockIdentityRegistry internal registry;
    DeployMinimalLocal internal script;
    uint256 internal agentId;

    function setUp() public {
        vm.warp(1_700_000_000);
        _makeKeys();
        registry = new MockIdentityRegistry();
        vm.prank(makeAddr("burn")); // keeps the test identity off id 0
        registry.register("ipfs://burn-id-0");
        vm.prank(idOwner);
        agentId = registry.register("ipfs://agent");

        script = new DeployMinimalLocal(address(registry));
        d = script.deploy(_config(block.chainid, address(registry)));
        controller = d.controller;
    }

    function test_deploy_postConditionsHold() public view {
        _assertDeployment(address(registry));
    }

    function test_deploy_contractsComeFromTheDeployerInOrder() public view {
        // The deployer starts at nonce 0 here: implementation, factory, controller.
        assertEq(address(d.implementation), vm.computeCreateAddress(deployer, 0));
        assertEq(address(d.factory), vm.computeCreateAddress(deployer, 1));
        assertEq(address(d.controller), vm.computeCreateAddress(deployer, 2));
        assertEq(vm.getNonce(deployer), 3);
    }

    function test_deploy_predictionHoldsFromANonZeroNonce() public {
        // A second deploy from the same key starts at nonce 3: the prediction must follow it.
        d = script.deploy(_config(block.chainid, address(registry)));
        assertEq(address(d.controller), vm.computeCreateAddress(deployer, 5));
        controller = d.controller;
        _assertDeployment(address(registry));
    }

    function test_executorRelaysCreateLegalBody_andPointerLinks() public {
        address body = _createBodyViaExecutor(agentId);
        assertEq(LegalManager(payable(body)).manager(), address(d.factory));
        assertEq(d.factory.identityOwnerAtCreation(body), idOwner);

        bytes memory pointer = d.factory.encodePointer(body); // read before the prank
        vm.prank(idOwner);
        registry.setMetadata(agentId, "legalBody", pointer);
        assertEq(d.factory.linkedLegalBody(agentId), body);
    }

    function test_guardianInitiatesAndCancelsDissolution() public {
        _assertGuardianInitiatesAndCancels(_createBodyViaExecutor(agentId));
    }

    function test_executorCannotRelayFullProductSelectors() public {
        _assertExecutorCannotRelayFullProduct(address(registry), agentId);
    }

    function test_nobodyCanRelayReleaseSelectors() public {
        _assertNobodyCanRelayRelease();
    }

    function test_releaseCeremonyThenGuardianUpgrade() public {
        _assertReleaseAndGuardianUpgrade(_createBodyViaExecutor(agentId));
    }

    function test_run_readsTheEnvironment() public {
        (, uint256 pk) = makeAddrAndKey("envDeployer");
        vm.deal(vm.addr(pk), 100 ether);
        vm.setEnv("PRIVATE_KEY", vm.toString(bytes32(pk)));
        vm.setEnv("CHAIN_ID", vm.toString(block.chainid));
        vm.setEnv("IDENTITY_REGISTRY", vm.toString(address(registry)));
        vm.setEnv("CONTROLLER_ADMIN", vm.toString(admin));
        vm.setEnv("CONTROLLER_EXECUTOR", vm.toString(executor));
        vm.setEnv("CONTROLLER_ADMIN_DELAY", "172800");
        DeployMinimal.Deployment memory e = script.run();
        assertEq(e.controller.defaultAdmin(), admin);
        assertEq(e.controller.defaultAdminDelay(), 2 days);
        assertEq(address(e.factory.identityRegistry()), address(registry));
        assertEq(e.controller.boundTarget(LegalBodyFactory.createLegalBody.selector), address(e.factory));
    }

    // ── read-back of a deployed triple ───────────────────────────────────

    /// @dev Sets the env verify() reads. The admin, executor and delay match the values
    ///      test_run_readsTheEnvironment sets, because environment variables are shared by tests
    ///      running in parallel; a wrong admin is exercised with a deployment instead.
    function _setVerifyEnv() internal {
        vm.setEnv("CONTROLLER_ADMIN", vm.toString(admin));
        vm.setEnv("CONTROLLER_EXECUTOR", vm.toString(executor));
        vm.setEnv("CONTROLLER_ADMIN_DELAY", "172800");
        vm.setEnv("DEPLOYER", vm.toString(deployer));
    }

    function _deployWithTwoDayDelay(address admin_) internal returns (DeployMinimal.Deployment memory e) {
        DeployMinimal.Config memory c = _config(block.chainid, address(registry));
        c.admin = admin_;
        c.adminDelay = 2 days;
        e = script.deploy(c);
    }

    function test_verify_passesOnTheDeployedContracts() public {
        DeployMinimal.Deployment memory e = _deployWithTwoDayDelay(admin);
        _setVerifyEnv();
        script.verify(address(e.implementation), address(e.factory), address(e.controller));
    }

    function test_verify_revertsOnAWrongTriple() public {
        DeployMinimal.Deployment memory e = _deployWithTwoDayDelay(admin);
        _setVerifyEnv();
        vm.expectRevert(bytes("factory owner is not the controller"));
        script.verify(address(e.implementation), address(e.factory), address(e.factory));
        vm.expectRevert(bytes("factory implementation"));
        script.verify(address(d.implementation), address(e.factory), address(e.controller));
        // The setUp deployment's controller pins the setUp factory, not this one.
        vm.expectRevert(bytes("factory owner is not the controller"));
        script.verify(address(e.implementation), address(e.factory), address(d.controller));
    }

    function test_verify_revertsWhenTheAdminDiffersFromTheEnvironment() public {
        DeployMinimal.Deployment memory e = _deployWithTwoDayDelay(makeAddr("anotherAdmin"));
        _setVerifyEnv();
        vm.expectRevert(bytes("default admin is not CONTROLLER_ADMIN"));
        script.verify(address(e.implementation), address(e.factory), address(e.controller));
    }

    function test_verify_revertsWhenAReleaseSelectorIsGranted() public {
        DeployMinimal.Deployment memory e = _deployWithTwoDayDelay(admin);
        _setVerifyEnv();
        vm.prank(admin);
        e.controller.grantRole(bytes32(LegalBodyFactory.publishVersion.selector), executor);
        vm.expectRevert(bytes("a release selector is granted"));
        script.verify(address(e.implementation), address(e.factory), address(e.controller));
    }

    function test_verify_revertsWhenAReleaseSelectorIsUnpinned() public {
        DeployMinimal.Deployment memory e = _deployWithTwoDayDelay(admin);
        _setVerifyEnv();
        vm.prank(admin);
        e.controller.setBoundTarget(LegalBodyFactory.withdrawVersion.selector, address(0));
        vm.expectRevert(bytes("release selector not pinned to the factory"));
        script.verify(address(e.implementation), address(e.factory), address(e.controller));
    }

    /// The read-back is for a fresh deployment: once a second version is listed it no longer
    /// passes, and says why.
    function test_verify_revertsOnceASecondVersionIsListed() public {
        DeployMinimal.Deployment memory e = _deployWithTwoDayDelay(admin);
        _setVerifyEnv();
        controller = e.controller;
        _breakGlass(address(e.factory), abi.encodeCall(LegalBodyFactory.publishVersion, (address(new LegalBodyV2Mock()))));
        vm.expectRevert(bytes("the factory does not list exactly one version"));
        script.verify(address(e.implementation), address(e.factory), address(e.controller));
    }

    // ── pre-check refusals ───────────────────────────────────────────────

    function test_revert_chainIdMismatch() public {
        vm.expectRevert(bytes("CHAIN_ID does not match the connected chain"));
        script.deploy(_config(5042, address(registry)));
    }

    function test_revert_registryNotPinnedForTestnet() public {
        vm.chainId(5042002);
        vm.expectRevert(bytes("IDENTITY_REGISTRY is not the registry pinned for this chain"));
        script.deploy(_config(5042002, address(registry)));
    }

    function test_revert_registryNotPinnedForMainnet() public {
        vm.chainId(5042);
        vm.expectRevert(bytes("IDENTITY_REGISTRY is not the registry pinned for this chain"));
        script.deploy(_config(5042, address(registry)));
    }

    function test_revert_pinnedRegistryWithoutCode() public {
        // The right address on a chain where nothing is deployed there.
        vm.chainId(5042);
        vm.expectRevert(bytes("IDENTITY_REGISTRY is not a contract"));
        script.deploy(_config(5042, 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432));
    }

    function test_revert_unpinnedChain() public {
        vm.chainId(1);
        vm.expectRevert(bytes("no identity registry is pinned for this chain"));
        script.deploy(_config(1, address(registry)));
    }

    /// The shipped script has no local allowance: on chain 31337 it accepts no registry at all.
    function test_revert_shippedScriptAcceptsNoLocalRegistry() public {
        DeployMinimal shipped = new DeployMinimal();
        vm.expectRevert(bytes("no identity registry is pinned for this chain"));
        shipped.deploy(_config(block.chainid, address(registry)));
    }

    function test_revert_adminEqualsExecutor() public {
        DeployMinimal.Config memory c = _config(block.chainid, address(registry));
        c.executor = c.admin;
        vm.expectRevert(bytes("admin and executor must differ"));
        script.deploy(c);
    }

    function test_revert_zeroAdminOrExecutor() public {
        DeployMinimal.Config memory c = _config(block.chainid, address(registry));
        c.admin = address(0);
        vm.expectRevert(bytes("admin and executor are required"));
        script.deploy(c);
        c = _config(block.chainid, address(registry));
        c.executor = address(0);
        vm.expectRevert(bytes("admin and executor are required"));
        script.deploy(c);
    }

    function test_revert_deployerIsAdmin() public {
        DeployMinimal.Config memory c = _config(block.chainid, address(registry));
        c.admin = deployer;
        vm.expectRevert(bytes("the deployer must hold no role"));
        script.deploy(c);
    }

    // ── the admin delay on Arc mainnet ───────────────────────────────────

    address internal constant REGISTRY_ARC_MAINNET = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address internal constant REGISTRY_ARC_TESTNET = 0x8004A818BFB912233c491871b3d84c89A494BD9e;

    /// @dev Switches to `chainId` and places the mock registry's code at that chain's pinned
    ///      registry, so the shipped pins accept it and only the delay decides.
    function _onChainWithRegistry(uint256 chainId, address pinned) internal returns (DeployMinimal.Config memory c) {
        vm.chainId(chainId);
        vm.etch(pinned, address(registry).code);
        c = _config(chainId, pinned);
    }

    function test_revert_mainnetAdminDelayUnderOneHour() public {
        DeployMinimal.Config memory c = _onChainWithRegistry(5042, REGISTRY_ARC_MAINNET);
        c.adminDelay = 0;
        vm.expectRevert(bytes("CONTROLLER_ADMIN_DELAY is under 1 hour"));
        script.deploy(c);
        c.adminDelay = 1 hours - 1;
        vm.expectRevert(bytes("CONTROLLER_ADMIN_DELAY is under 1 hour"));
        script.deploy(c);
    }

    function test_revert_mainnetAdminDelayOverThirtyDays() public {
        DeployMinimal.Config memory c = _onChainWithRegistry(5042, REGISTRY_ARC_MAINNET);
        c.adminDelay = 30 days + 1;
        vm.expectRevert(bytes("CONTROLLER_ADMIN_DELAY is over 30 days (a value in milliseconds?)"));
        script.deploy(c);
        // 24 hours entered in milliseconds.
        c.adminDelay = 86_400_000;
        vm.expectRevert(bytes("CONTROLLER_ADMIN_DELAY is over 30 days (a value in milliseconds?)"));
        script.deploy(c);
    }

    function test_deploy_mainnetAcceptsTheDefaultDelayAndBothBounds() public {
        DeployMinimal.Config memory c = _onChainWithRegistry(5042, REGISTRY_ARC_MAINNET);
        assertEq(c.adminDelay, 24 hours);
        d = script.deploy(c);
        controller = d.controller;
        _assertDeployment(REGISTRY_ARC_MAINNET);

        c.adminDelay = 1 hours;
        assertEq(script.deploy(c).controller.defaultAdminDelay(), 1 hours);
        c.adminDelay = 30 days;
        assertEq(script.deploy(c).controller.defaultAdminDelay(), 30 days);
    }

    function test_deploy_testnetAcceptsAZeroDelay() public {
        DeployMinimal.Config memory c = _onChainWithRegistry(5042002, REGISTRY_ARC_TESTNET);
        c.adminDelay = 0;
        DeployMinimal.Deployment memory e = script.deploy(c);
        assertEq(e.controller.defaultAdminDelay(), 0);
        assertEq(e.controller.defaultAdmin(), admin);
    }

    function test_revert_deployerIsExecutor() public {
        DeployMinimal.Config memory c = _config(block.chainid, address(registry));
        c.executor = deployer;
        vm.expectRevert(bytes("the deployer must hold no role"));
        script.deploy(c);
    }
}
