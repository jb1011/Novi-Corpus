// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ControllerRelayHarness} from "./helpers/ControllerRelayHarness.sol";
import {LegalBody} from "../src/LegalBody.sol";
import {LegalBodyFactory} from "../src/LegalBodyFactory.sol";
import {LegalManager} from "../src/LegalManager.sol";
import {NoviController} from "../src/NoviController.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";

/// @notice A dress rehearsal of a release against a factory that is already deployed, run on a
///         fork of its chain before the real ceremony. It publishes the candidate version the way
///         the administrator will, creates fresh legal bodies, moves them to the candidate with
///         a guardian's signature, and checks that each body ends on the candidate's number with
///         its guardian, delay, manager and identity unchanged and its functions still working.
///         Nothing is broadcast.
/// @dev    Skipped unless REHEARSAL_FACTORY is set. Env:
///           REHEARSAL_RPC_URL          the chain to fork
///           REHEARSAL_FACTORY          the deployed LegalBodyFactory
///           REHEARSAL_EXECUTOR         the address that holds the factory's create grant
///           REHEARSAL_IMPLEMENTATION   the candidate, already deployed on that chain, or
///           REHEARSAL_CANDIDATE        the candidate's build artifact from `forge build`, for
///                                      example "out/LegalBodyV2.sol/LegalBodyV2.json", which
///                                      the test deploys on the fork
///         Rehearse the deployed address before the ceremony: it is the code bodies will run.
contract LegalBodyReleaseRehearsalTest is ControllerRelayHarness {
    bytes32 internal constant OA = keccak256("rehearsal-operating-agreement");

    LegalBodyFactory internal factory;
    IIdentityRegistry internal registry;
    address internal candidate;
    uint256 internal candidateVersion;
    bool internal rehearsing;

    address internal guardian;
    uint256 internal guardianPk;
    address internal idOwner;
    uint256 internal idOwnerPk;
    address internal stranger = makeAddr("rehearsalStranger");
    uint256 internal delay;

    modifier onlyRehearsal() {
        vm.skip(!rehearsing);
        _;
    }

    function setUp() public {
        address factory_ = vm.envOr("REHEARSAL_FACTORY", address(0));
        if (factory_ == address(0)) return;
        vm.createSelectFork(vm.envString("REHEARSAL_RPC_URL"));
        rehearsing = true;

        factory = LegalBodyFactory(factory_);
        require(factory_.code.length > 0, "REHEARSAL_FACTORY is not a contract on this chain");
        controller = NoviController(factory.owner());
        admin = controller.defaultAdmin();
        executor = vm.envAddress("REHEARSAL_EXECUTOR");
        require(
            controller.hasRole(bytes32(LegalBodyFactory.createLegalBody.selector), executor),
            "REHEARSAL_EXECUTOR does not hold the create grant"
        );
        registry = factory.identityRegistry();
        delay = factory.MIN_AMENDMENT_DELAY();

        candidate = vm.envOr("REHEARSAL_IMPLEMENTATION", address(0));
        if (candidate == address(0)) candidate = deployCode(vm.envString("REHEARSAL_CANDIDATE"));
        require(candidate.code.length > 0, "the candidate is not a contract on this chain");
        candidateVersion = factory.versionCount() + 1;

        (guardian, guardianPk) = makeAddrAndKey("rehearsalGuardian");
        (idOwner, idOwnerPk) = makeAddrAndKey("rehearsalIdentityOwner");
    }

    function _sig(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev A fresh identity and a fresh body for it, created through the controller the way
    ///      the backend creates one.
    function _createBody(string memory uri) internal returns (address body) {
        vm.prank(idOwner);
        uint256 agentId = registry.register(uri);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory link = _sig(idOwnerPk, factory.linkDigest(agentId, guardian, delay, OA, deadline));
        bytes memory ret = _relayOk(
            executor,
            address(factory),
            abi.encodeCall(LegalBodyFactory.createLegalBody, (agentId, guardian, delay, OA, deadline, link))
        );
        body = abi.decode(ret, (address));
    }

    /// @dev The administrator's ceremony: a single-use helper holds the selector for one call.
    function _publishCandidate() internal {
        bytes memory ret = _breakGlass(address(factory), abi.encodeCall(LegalBodyFactory.publishVersion, (candidate)));
        assertEq(abi.decode(ret, (uint256)), candidateVersion, "the number the candidate is listed under");
        assertEq(factory.versionInfo(candidateVersion).implementation, candidate);
    }

    /// @dev The guardian signs, a stranger schedules, the delay passes, a stranger executes.
    function _moveTo(address body, uint256 version) internal {
        uint256 deadline = block.timestamp + 1 hours;
        address implementation = factory.versionInfo(version).implementation;
        bytes memory sig = _sig(
            guardianPk, factory.upgradeDigest(body, version, implementation, factory.upgradeNonce(body), deadline)
        );
        vm.prank(stranger);
        factory.scheduleLegalBodyUpgrade(body, version, deadline, sig);
        vm.warp(block.timestamp + delay);
        vm.prank(stranger);
        factory.executeLegalBodyUpgrade(body);
    }

    /// @dev What must hold for a body that has just moved to `version`.
    function _assertOnVersion(address body, uint256 version, uint256 agentId) internal view {
        assertEq(factory.versionOf(body), version, "the factory's record of the body's version");
        assertEq(
            address(uint160(uint256(vm.load(body, ERC1967Utils.IMPLEMENTATION_SLOT)))),
            factory.versionInfo(version).implementation,
            "the code the body points at"
        );
        assertEq(LegalBody(payable(body)).initializedVersion(), version, "the body's counter");

        LegalManager lm = LegalManager(payable(body));
        assertEq(lm.manager(), address(factory), "the manager");
        assertEq(lm.guardian(), guardian, "the guardian");
        assertEq(lm.amendmentDelay(), delay, "the delay");
        assertEq(uint8(lm.status()), uint8(LegalManager.Status.Active), "the status");
        (,, bytes32 oa, uint256 id) = lm.meta();
        assertEq(oa, OA, "the operating agreement hash");
        assertEq(id, agentId, "the identity");
        (address recordedGuardian, uint64 recordedDelay,) = factory.bodyRecord(body);
        assertEq(recordedGuardian, guardian, "the factory's record of the guardian");
        assertEq(recordedDelay, delay, "the factory's record of the delay");
    }

    /// @dev The body's own functions still work on the new code: a guardian-signed amendment
    ///      goes through, and the guardian can start and cancel a dissolution.
    function _assertStillWorks(address body) internal {
        bytes32 newHash = keccak256("rehearsal-operating-agreement-2");
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig =
            _sig(guardianPk, factory.amendmentDigest(body, newHash, factory.amendmentNonce(body), deadline));
        _relayOk(
            executor,
            address(factory),
            abi.encodeCall(LegalBodyFactory.scheduleOperatingAgreementUpdate, (body, newHash, deadline, sig))
        );
        vm.warp(block.timestamp + delay);
        vm.prank(stranger);
        factory.executeOperatingAgreementUpdate(body, newHash);
        (,, bytes32 oa,) = LegalManager(payable(body)).meta();
        assertEq(oa, newHash, "the amendment took effect");

        LegalManager lm = LegalManager(payable(body));
        vm.prank(guardian);
        lm.initiateDissolution();
        assertEq(uint8(lm.status()), uint8(LegalManager.Status.WindingDown));
        vm.prank(guardian);
        lm.cancelDissolution();
        assertEq(uint8(lm.status()), uint8(LegalManager.Status.Active));
    }

    /// A body on version 1 moves straight to the candidate, skipping whatever lies between.
    function test_rehearsal_bodyMovesFromVersionOne() public onlyRehearsal {
        address body = _createBody("ipfs://release-rehearsal-from-one");
        (,,, uint256 agentId) = LegalManager(payable(body)).meta();
        _publishCandidate();
        assertEq(factory.versionOf(body), 1, "publishing moves no body");

        _moveTo(body, candidateVersion);
        _assertOnVersion(body, candidateVersion, agentId);
        _assertStillWorks(body);
    }

    /// A body on the version before the candidate moves to it. Skipped when the candidate is
    /// version 2, which the test from version 1 already covers, or when the version before it
    /// is withdrawn.
    function test_rehearsal_bodyMovesFromThePreviousVersion() public onlyRehearsal {
        uint256 previous = candidateVersion - 1;
        vm.skip(previous < 2 || factory.versionInfo(previous).withdrawn);

        address body = _createBody("ipfs://release-rehearsal-from-previous");
        (,,, uint256 agentId) = LegalManager(payable(body)).meta();
        _moveTo(body, previous);
        _publishCandidate();

        _moveTo(body, candidateVersion);
        _assertOnVersion(body, candidateVersion, agentId);
        _assertStillWorks(body);
    }

    /// The administrator can withdraw the candidate afterwards; a body on it stays on it.
    function test_rehearsal_candidateCanBeWithdrawn() public onlyRehearsal {
        address body = _createBody("ipfs://release-rehearsal-withdraw");
        _publishCandidate();
        _moveTo(body, candidateVersion);

        _breakGlass(address(factory), abi.encodeCall(LegalBodyFactory.withdrawVersion, (candidateVersion)));
        assertTrue(factory.versionInfo(candidateVersion).withdrawn);
        assertEq(factory.versionOf(body), candidateVersion);
    }
}
