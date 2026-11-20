// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LegalBody} from "../src/LegalBody.sol";
import {LegalBodyFactory} from "../src/LegalBodyFactory.sol";
import {LegalManager} from "../src/LegalManager.sol";
import {ILegalBodyVersion} from "../src/interfaces/ILegalBodyVersion.sol";
import {LegalBodyUpgradeTestBase} from "./helpers/LegalBodyUpgradeBase.sol";
import {
    LegalBodyV2Mock,
    LegalBodyV3Mock,
    LegalBodyFaultyMock,
    LegalBodyNoMigrateMock,
    LegalBodyRevertingMigrateMock,
    LegalBodyMovesManagerMock,
    LegalBodyNumberedMock,
    LegalBodyUncountedMigrateMock
} from "./mocks/LegalBodyVersions.sol";
import {MockERC1271Wallet} from "./mocks/MockERC1271Wallet.sol";
import {RevertingInitializer} from "./mocks/RevertingInitializer.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC1967} from "@openzeppelin/contracts/interfaces/IERC1967.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {Errors} from "@openzeppelin/contracts/utils/Errors.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @dev Looks like a locked logic contract on every check but one: its `initialize` succeeds.
contract OpenInitializeLogic {
    function manager() external pure returns (address) {
        return address(0);
    }

    function initialize(address, address, uint256, uint256, string calldata, uint64, bytes32) external {}

    function proxiableUUID() external pure returns (bytes32) {
        return ERC1967Utils.IMPLEMENTATION_SLOT;
    }
}

/// @dev Looks like a locked logic contract on every check but one: its UUPS slot is not ERC-1967's.
contract WrongSlotLogic {
    function manager() external pure returns (address) {
        return address(0);
    }

    function initialize(address, address, uint256, uint256, string calldata, uint64, bytes32) external pure {
        revert Initializable.InvalidInitialization();
    }

    function proxiableUUID() external pure returns (bytes32) {
        return bytes32(uint256(1));
    }
}

/// @dev A faulty version 2 that names a guardian whose key the test holds, so the test can show
///      that guardian's real signature is still refused.
contract LegalBodyKnownWrongGuardianMock is LegalBody, ILegalBodyVersion {
    address public immutable NEW_GUARDIAN;

    constructor(address newGuardian_) {
        NEW_GUARDIAN = newGuardian_;
    }

    function migrate(uint256) external onlyManager reinitializer(2) {
        guardian = NEW_GUARDIAN;
        amendmentDelay = 1 hours;
    }
}

abstract contract LegalBodyUpgradeUnitBase is LegalBodyUpgradeTestBase {
    address internal body;

    function setUp() public virtual override {
        super.setUp();
        body = _create();
    }

    /// @dev A body of this factory for the same identity, with guardian `g`.
    function _createFor(address g, uint256 deadline) internal returns (address created) {
        bytes memory sig = _signLink(ownerPk, agentId, g, DELAY, OA, deadline);
        vm.prank(novi);
        created = factory.createLegalBody(agentId, g, DELAY, OA, deadline, sig);
    }

    function _record(address b) internal view returns (address g, uint64 delay, uint32 version) {
        return factory.bodyRecord(b);
    }

    /// @dev Sends a guardian-signed schedule for `version` and expects `err`. The signature is
    ///      valid unless `sig` is given.
    function _expectScheduleRevert(address b, uint256 version, uint256 deadline, bytes memory sig, bytes memory err)
        internal
    {
        vm.prank(stranger);
        vm.expectRevert(err);
        factory.scheduleLegalBodyUpgrade(b, version, deadline, sig);
    }

    function _point(address b) internal {
        bytes memory pointer = factory.encodePointer(b);
        vm.prank(idOwner);
        registry.setMetadata(agentId, "legalBody", pointer);
    }
}

contract LegalBodyUpgradeCreationTest is LegalBodyUpgradeUnitBase {
    function test_creation_bodyIsProxyOfVersionOne() public view {
        assertEq(_implementationOf(body), address(impl));
        assertEq(factory.versionOf(body), 1);
    }

    function test_creation_predictedAddressMatches() public {
        uint256 deadline = block.timestamp + 2 hours;
        address predicted = factory.predictLegalBody(factory.linkDigest(agentId, guardian, DELAY, OA, deadline));
        assertEq(_createWith(deadline), predicted);
    }

    function test_creation_predictionUnmovedByPublication() public {
        uint256 deadline = block.timestamp + 2 hours;
        bytes32 digest = factory.linkDigest(agentId, guardian, DELAY, OA, deadline);
        address before = factory.predictLegalBody(digest);
        _publishV2();
        assertEq(factory.predictLegalBody(digest), before);
        address created = _createWith(deadline);
        assertEq(created, before);
        assertEq(_implementationOf(created), address(impl), "created on version 1 after a publication");
        assertEq(factory.versionOf(created), 1);
    }

    function test_creation_bodiesShareCodeHash() public {
        address second = _createWith(block.timestamp + 2 hours);
        assertTrue(second != body);
        assertEq(second.codehash, body.codehash);
    }

    function test_creation_recordHoldsGuardianDelayAndVersionOne() public view {
        (address g, uint64 delay, uint32 version) = _record(body);
        assertEq(g, guardian);
        assertEq(delay, DELAY);
        assertEq(version, 1);
        assertEq(factory.versionOf(address(0xB0D1)), 0);
    }

    function test_constructor_publishesVersionOne() public {
        address expected = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.expectEmit(true, true, true, true, expected);
        emit LegalBodyFactory.VersionPublished(1, address(impl), address(impl).codehash);
        LegalBodyFactory f = new LegalBodyFactory(address(impl), address(registry), novi);
        assertEq(address(f), expected);
        assertEq(f.versionCount(), 1);
        LegalBodyFactory.Version memory v = f.versionInfo(1);
        assertEq(v.implementation, address(impl));
        assertEq(v.codehash, address(impl).codehash);
        assertEq(v.publishedAt, block.timestamp);
        assertFalse(v.withdrawn);
        assertEq(f.versionOfImplementation(address(impl)), 1);
    }
}

contract LegalBodyUpgradePublishTest is LegalBodyUpgradeUnitBase {
    function _expectPublishRevert(address target, bytes memory err) internal {
        vm.prank(novi);
        vm.expectRevert(err);
        factory.publishVersion(target);
    }

    function _notImplementation(address target) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(LegalBodyFactory.NotImplementation.selector, target);
    }

    function test_publish_ownerOnly() public {
        LegalBodyV2Mock v2 = new LegalBodyV2Mock();
        address[3] memory callers = [stranger, guardian, idOwner];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, callers[i]));
            factory.publishVersion(address(v2));
        }
        assertEq(factory.versionCount(), 1);
    }

    function test_publish_refusesAddressWithoutCode() public {
        address empty = makeAddr("empty");
        _expectPublishRevert(empty, abi.encodeWithSelector(LegalBodyFactory.NotContract.selector, empty));
    }

    function test_publish_refusesDuplicate() public {
        LegalBodyV2Mock v2 = _publishV2();
        _expectPublishRevert(address(v2), abi.encodeWithSelector(LegalBodyFactory.VersionExists.selector, address(v2)));
        _expectPublishRevert(
            address(impl), abi.encodeWithSelector(LegalBodyFactory.VersionExists.selector, address(impl))
        );
    }

    /// A locked LegalManager has no `proxiableUUID`: a body moved to it could never leave it.
    function test_publish_refusesPlainLegalManager() public {
        LegalManager plain = new LegalManager();
        _expectPublishRevert(address(plain), _notImplementation(address(plain)));
    }

    /// Its `initialize` succeeds; the refusal rolls that initialisation back.
    function test_publish_refusesUninitialisedERC1967Proxy() public {
        address proxy = address(new ERC1967Proxy(address(impl), ""));
        _expectPublishRevert(proxy, _notImplementation(proxy));
        assertEq(LegalManager(payable(proxy)).manager(), address(0), "the probe left no trace");
    }

    function test_publish_refusesLiveBody() public {
        _expectPublishRevert(body, _notImplementation(body));
    }

    function test_publish_refusesUninitialisedBeaconProxy() public {
        UpgradeableBeacon beacon = new UpgradeableBeacon(address(impl), address(this));
        address proxy = address(new BeaconProxy(address(beacon), ""));
        _expectPublishRevert(proxy, _notImplementation(proxy));
        assertEq(LegalManager(payable(proxy)).manager(), address(0), "the probe left no trace");
    }

    function test_publish_refusesContractWhoseInitializeSucceeds() public {
        OpenInitializeLogic open = new OpenInitializeLogic();
        _expectPublishRevert(address(open), _notImplementation(address(open)));
    }

    function test_publish_refusesInitializeRevertingOtherwise() public {
        RevertingInitializer bad = new RevertingInitializer();
        _expectPublishRevert(address(bad), _notImplementation(address(bad)));
    }

    function test_publish_refusesWrongProxiableSlot() public {
        WrongSlotLogic wrong = new WrongSlotLogic();
        _expectPublishRevert(address(wrong), _notImplementation(address(wrong)));
    }

    /// The registry has no `manager()`: the probe's call itself reverts, with no factory error.
    function test_publish_refusesNonLegalManager() public {
        vm.prank(novi);
        vm.expectRevert();
        factory.publishVersion(address(registry));
        assertEq(factory.versionCount(), 1);
    }

    function test_publish_emitsAndStores() public {
        vm.warp(block.timestamp + 5 days);
        LegalBodyV2Mock v2 = new LegalBodyV2Mock();
        vm.expectEmit(true, true, true, true, address(factory));
        emit LegalBodyFactory.VersionPublished(2, address(v2), address(v2).codehash);
        vm.prank(novi);
        uint256 version = factory.publishVersion(address(v2));

        assertEq(version, 2);
        assertEq(factory.versionCount(), 2);
        LegalBodyFactory.Version memory v = factory.versionInfo(2);
        assertEq(v.implementation, address(v2));
        assertEq(v.codehash, address(v2).codehash);
        assertEq(v.publishedAt, block.timestamp);
        assertFalse(v.withdrawn);
        assertEq(factory.versionOfImplementation(address(v2)), 2);
    }

    function test_publish_changesNoBody() public {
        _publishV2();
        _publishV3();
        assertEq(factory.versionOf(body), 1);
        assertEq(_implementationOf(body), address(impl));
        (,, uint32 version) = _record(body);
        assertEq(version, 1);
        assertEq(_pendingVersion(body), 0);
    }
}

contract LegalBodyUpgradeWithdrawTest is LegalBodyUpgradeUnitBase {
    LegalBodyV2Mock internal v2;

    function setUp() public override {
        super.setUp();
        v2 = _publishV2();
    }

    function _withdraw(uint256 version) internal {
        vm.prank(novi);
        factory.withdrawVersion(version);
    }

    function _expectWithdrawRevert(uint256 version, bytes memory err) internal {
        vm.prank(novi);
        vm.expectRevert(err);
        factory.withdrawVersion(version);
    }

    function test_withdraw_ownerOnly() public {
        address[3] memory callers = [stranger, guardian, idOwner];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, callers[i]));
            factory.withdrawVersion(2);
        }
        assertFalse(factory.versionInfo(2).withdrawn);
    }

    function test_withdraw_refusesVersionOne() public {
        _expectWithdrawRevert(1, abi.encodeWithSelector(LegalBodyFactory.FirstVersionCannotBeWithdrawn.selector));
    }

    function test_withdraw_refusesUnknownVersion() public {
        _expectWithdrawRevert(0, abi.encodeWithSelector(LegalBodyFactory.UnknownVersion.selector, 0));
        _expectWithdrawRevert(3, abi.encodeWithSelector(LegalBodyFactory.UnknownVersion.selector, 3));
    }

    function test_withdraw_refusesTwice() public {
        _withdraw(2);
        _expectWithdrawRevert(2, abi.encodeWithSelector(LegalBodyFactory.VersionIsWithdrawn.selector, 2));
    }

    function test_withdraw_emitsAndMarks() public {
        vm.expectEmit(true, true, true, true, address(factory));
        emit LegalBodyFactory.VersionWithdrawn(2, address(v2));
        _withdraw(2);
        LegalBodyFactory.Version memory v = factory.versionInfo(2);
        assertTrue(v.withdrawn);
        assertEq(v.implementation, address(v2), "the entry stays listed");
        assertEq(factory.versionCount(), 2);
    }

    function test_withdraw_stopsWaitingUpgrade() public {
        uint256 executableAt = _schedule(body, 2);
        _withdraw(2);
        vm.warp(executableAt);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(LegalBodyFactory.VersionIsWithdrawn.selector, 2));
        factory.executeLegalBodyUpgrade(body);
        assertEq(_implementationOf(body), address(impl));
        assertEq(factory.versionOf(body), 1);
    }

    function test_withdraw_stopsScheduling() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signUpgrade(guardianPk, body, 2, deadline);
        _withdraw(2);
        _expectScheduleRevert(
            body, 2, deadline, sig, abi.encodeWithSelector(LegalBodyFactory.VersionIsWithdrawn.selector, 2)
        );
        assertEq(factory.upgradeNonce(body), 0);
    }

    function test_withdraw_bodyOnItStaysAndCanMoveOn() public {
        _upgrade(body, 2);
        _withdraw(2);
        assertEq(factory.versionOf(body), 2);
        assertEq(_implementationOf(body), address(v2));

        LegalBodyV3Mock v3 = _publishV3();
        _upgrade(body, 3);
        assertEq(factory.versionOf(body), 3);
        assertEq(_implementationOf(body), address(v3));
    }
}

contract LegalBodyUpgradeScheduleTest is LegalBodyUpgradeUnitBase {
    LegalBodyV2Mock internal v2;
    LegalBodyV3Mock internal v3;
    uint256 internal deadline;

    function setUp() public override {
        super.setUp();
        v2 = _publishV2();
        v3 = _publishV3();
        deadline = block.timestamp + 1 hours;
    }

    function _badSignature() internal pure returns (bytes memory) {
        return abi.encodeWithSelector(LegalBodyFactory.BadSignature.selector);
    }

    function test_schedule_refusesStrangerSignature() public {
        bytes memory sig = _signUpgrade(0xDEAD, body, 2, deadline);
        _expectScheduleRevert(body, 2, deadline, sig, _badSignature());
    }

    function test_schedule_refusesIdentityOwnerSignature() public {
        bytes memory sig = _signUpgrade(ownerPk, body, 2, deadline);
        _expectScheduleRevert(body, 2, deadline, sig, _badSignature());
    }

    function test_schedule_refusesUsedNonce() public {
        bytes memory sig = _signUpgrade(guardianPk, body, 2, deadline);
        vm.prank(stranger);
        factory.scheduleLegalBodyUpgrade(body, 2, deadline, sig);
        _expectScheduleRevert(body, 2, deadline, sig, _badSignature());
        assertEq(factory.upgradeNonce(body), 1);
    }

    function test_schedule_refusesSignatureForAnotherBody() public {
        address second = _createWith(block.timestamp + 2 hours);
        bytes memory sig = _signUpgrade(guardianPk, second, 2, deadline);
        _expectScheduleRevert(body, 2, deadline, sig, _badSignature());
    }

    function test_schedule_refusesSignatureForAnotherVersion() public {
        bytes memory sig = _signUpgrade(guardianPk, body, 3, deadline);
        _expectScheduleRevert(body, 2, deadline, sig, _badSignature());
    }

    function test_schedule_refusesPastDeadline() public {
        uint256 past = block.timestamp - 1;
        bytes memory sig = _signUpgrade(guardianPk, body, 2, past);
        _expectScheduleRevert(body, 2, past, sig, abi.encodeWithSelector(LegalBodyFactory.BadDeadline.selector));
    }

    function test_schedule_refusesDeadlineTooFar() public {
        uint256 far = block.timestamp + 24 hours + 1;
        bytes memory sig = _signUpgrade(guardianPk, body, 2, far);
        _expectScheduleRevert(body, 2, far, sig, abi.encodeWithSelector(LegalBodyFactory.BadDeadline.selector));
    }

    function test_schedule_acceptsDeadlineBounds() public {
        bytes memory sig = _signUpgrade(guardianPk, body, 2, block.timestamp + 24 hours);
        vm.prank(stranger);
        factory.scheduleLegalBodyUpgrade(body, 2, block.timestamp + 24 hours, sig);
        sig = _signUpgrade(guardianPk, body, 3, block.timestamp);
        vm.prank(stranger);
        factory.scheduleLegalBodyUpgrade(body, 3, block.timestamp, sig);
        assertEq(_pendingVersion(body), 3);
    }

    function test_schedule_refusesUnpublishedVersion() public {
        address unpublished = address(new LegalBodyNumberedMock(4));
        bytes memory sig = _sign(guardianPk, factory.upgradeDigest(body, 4, unpublished, 0, deadline));
        _expectScheduleRevert(
            body, 4, deadline, sig, abi.encodeWithSelector(LegalBodyFactory.UnknownVersion.selector, 4)
        );
        sig = _sign(guardianPk, factory.upgradeDigest(body, 0, address(0), 0, deadline));
        _expectScheduleRevert(
            body, 0, deadline, sig, abi.encodeWithSelector(LegalBodyFactory.UnknownVersion.selector, 0)
        );
    }

    function test_schedule_refusesCurrentVersion() public {
        bytes memory sig = _signUpgrade(guardianPk, body, 1, deadline);
        _expectScheduleRevert(
            body, 1, deadline, sig, abi.encodeWithSelector(LegalBodyFactory.NotNewerVersion.selector, 1)
        );
    }

    function test_schedule_refusesOlderVersion() public {
        _upgrade(body, 3);
        uint256 d = block.timestamp + 1 hours;
        bytes memory sig = _signUpgrade(guardianPk, body, 2, d);
        _expectScheduleRevert(body, 2, d, sig, abi.encodeWithSelector(LegalBodyFactory.NotNewerVersion.selector, 2));
        sig = _signUpgrade(guardianPk, body, 3, d);
        _expectScheduleRevert(body, 3, d, sig, abi.encodeWithSelector(LegalBodyFactory.NotNewerVersion.selector, 3));
    }

    function test_schedule_refusesBodyOfAnotherFactory() public {
        LegalBodyFactory other = new LegalBodyFactory(address(impl), address(registry), novi);
        bytes memory link = _sign(ownerPk, other.linkDigest(agentId, guardian, DELAY, OA, deadline));
        vm.prank(novi);
        address foreign = other.createLegalBody(agentId, guardian, DELAY, OA, deadline, link);
        bytes memory sig = _sign(guardianPk, factory.upgradeDigest(foreign, 2, address(v2), 0, deadline));
        _expectScheduleRevert(
            foreign, 2, deadline, sig, abi.encodeWithSelector(LegalBodyFactory.NotLegalBody.selector, foreign)
        );
    }

    function test_schedule_refusesNonBody() public {
        address notBody = address(impl);
        bytes memory sig = _sign(guardianPk, factory.upgradeDigest(notBody, 2, address(v2), 0, deadline));
        _expectScheduleRevert(
            notBody, 2, deadline, sig, abi.encodeWithSelector(LegalBodyFactory.NotLegalBody.selector, notBody)
        );
    }

    function test_schedule_refusesMalformedSignature() public {
        bytes memory sig = _signUpgrade(guardianPk, body, 2, deadline);
        bytes memory shortSig = new bytes(64);
        for (uint256 i = 0; i < 64; i++) {
            shortSig[i] = sig[i];
        }
        _expectScheduleRevert(body, 2, deadline, shortSig, _badSignature());
        _expectScheduleRevert(body, 2, deadline, abi.encodePacked(sig, uint8(0)), _badSignature());
    }

    function test_schedule_acceptsERC1271Guardian() public {
        uint256 walletPk = 0xC0FFEE;
        MockERC1271Wallet wallet = new MockERC1271Wallet(vm.addr(walletPk));
        address walletBody = _createFor(address(wallet), block.timestamp + 2 hours);
        bytes memory sig = _sign(walletPk, factory.upgradeDigest(walletBody, 2, address(v2), 0, deadline));
        vm.prank(stranger);
        factory.scheduleLegalBodyUpgrade(walletBody, 2, deadline, sig);
        assertEq(_pendingVersion(walletBody), 2);
    }

    function test_schedule_acceptsEIP7702Guardian() public {
        _delegate7702(guardian);
        bytes memory sig = _signUpgrade(guardianPk, body, 2, deadline);
        vm.prank(stranger);
        factory.scheduleLegalBodyUpgrade(body, 2, deadline, sig);
        assertEq(_pendingVersion(body), 2);
    }

    function test_schedule_sentByAnyoneRecordsAndEmits() public {
        bytes memory sig = _signUpgrade(guardianPk, body, 2, deadline);
        vm.expectEmit(true, true, true, true, address(factory));
        emit LegalBodyFactory.LegalBodyUpgradeScheduled(body, 2, address(v2), block.timestamp + DELAY);
        vm.prank(address(0xCAFE));
        factory.scheduleLegalBodyUpgrade(body, 2, deadline, sig);

        (uint64 version, uint64 executableAt) = factory.pendingUpgrade(body);
        assertEq(version, 2);
        assertEq(executableAt, block.timestamp + DELAY);
        assertEq(factory.upgradeNonce(body), 1);
        assertEq(_implementationOf(body), address(impl), "scheduling moves nothing");
    }

    function test_schedule_secondReplacesFirstAndRestartsDelay() public {
        _schedule(body, 2);
        vm.warp(block.timestamp + 1 days);
        uint256 executableAt = _schedule(body, 3);
        assertEq(_pendingVersion(body), 3);
        assertEq(executableAt, block.timestamp + DELAY);
        assertEq(factory.upgradeNonce(body), 2);
    }

    function test_upgradeDigest_matchesIndependentEncoding() public view {
        bytes32 typeHash = keccak256(
            "LegalBodyUpgrade(address legalBody,uint256 version,address implementation,uint256 nonce,uint256 deadline)"
        );
        bytes32 structHash = keccak256(abi.encode(typeHash, body, uint256(2), address(v2), uint256(5), deadline));
        bytes32 expected = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        assertEq(factory.upgradeDigest(body, 2, address(v2), 5, deadline), expected);
        assertEq(factory.UPGRADE_TYPEHASH(), typeHash);
    }

    function test_upgradeCancelDigest_matchesIndependentEncoding() public view {
        bytes32 typeHash =
            keccak256("LegalBodyUpgradeCancel(address legalBody,uint256 version,uint256 nonce,uint256 deadline)");
        bytes32 structHash = keccak256(abi.encode(typeHash, body, uint256(2), uint256(5), deadline));
        bytes32 expected = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        assertEq(factory.upgradeCancelDigest(body, 2, 5, deadline), expected);
        assertEq(factory.UPGRADE_CANCEL_TYPEHASH(), typeHash);
    }

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("Novi LegalBodyFactory")),
                keccak256(bytes("1")),
                block.chainid,
                address(factory)
            )
        );
    }
}

contract LegalBodyUpgradeCancelTest is LegalBodyUpgradeUnitBase {
    function setUp() public override {
        super.setUp();
        _publishV2();
    }

    function test_cancel_guardianOnly() public {
        _schedule(body, 2);
        address[3] memory callers = [novi, idOwner, stranger];
        assertTrue(idOwner != guardian);
        for (uint256 i = 0; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(LegalBodyFactory.NotGuardian.selector);
            factory.cancelLegalBodyUpgrade(body);
        }
        assertEq(_pendingVersion(body), 2);
    }

    function test_cancel_refusesNonBody() public {
        vm.prank(guardian);
        vm.expectRevert(LegalBodyFactory.NotGuardian.selector);
        factory.cancelLegalBodyUpgrade(makeAddr("notABody"));
    }

    function test_cancel_refusesNothingPending() public {
        vm.prank(guardian);
        vm.expectRevert(LegalBodyFactory.NoPendingUpgrade.selector);
        factory.cancelLegalBodyUpgrade(body);
    }

    function test_cancel_emitsAndClears() public {
        _schedule(body, 2);
        vm.expectEmit(true, true, true, true, address(factory));
        emit LegalBodyFactory.LegalBodyUpgradeCancelled(body, 2);
        vm.prank(guardian);
        factory.cancelLegalBodyUpgrade(body);
        (uint64 version, uint64 executableAt) = factory.pendingUpgrade(body);
        assertEq(version, 0);
        assertEq(executableAt, 0);
    }

    function test_cancel_thenExecuteRefused() public {
        uint256 executableAt = _schedule(body, 2);
        vm.prank(guardian);
        factory.cancelLegalBodyUpgrade(body);
        vm.warp(executableAt);
        vm.expectRevert(LegalBodyFactory.NoPendingUpgrade.selector);
        factory.executeLegalBodyUpgrade(body);
        assertEq(_implementationOf(body), address(impl));
    }

    function test_cancel_keepsNonceAndNewSignatureWorks() public {
        _schedule(body, 2);
        vm.prank(guardian);
        factory.cancelLegalBodyUpgrade(body);
        assertEq(factory.upgradeNonce(body), 1, "a direct cancel uses no nonce");
        _upgrade(body, 2);
        assertEq(factory.versionOf(body), 2);
        assertEq(factory.upgradeNonce(body), 2);
    }
}

contract LegalBodyUpgradeCancelBySigTest is LegalBodyUpgradeUnitBase {
    uint256 internal deadline;

    function setUp() public override {
        super.setUp();
        _publishV2();
        _publishV3();
        deadline = block.timestamp + 1 hours;
    }

    function _expectCancelRevert(address b, uint256 d, bytes memory sig, bytes memory err) internal {
        vm.prank(stranger);
        vm.expectRevert(err);
        factory.cancelLegalBodyUpgradeBySig(b, d, sig);
    }

    function test_cancelBySig_sentByStrangerUsesNonce() public {
        _schedule(body, 2);
        bytes memory sig = _signCancel(guardianPk, body, deadline);
        vm.expectEmit(true, true, true, true, address(factory));
        emit LegalBodyFactory.LegalBodyUpgradeCancelled(body, 2);
        vm.prank(stranger);
        factory.cancelLegalBodyUpgradeBySig(body, deadline, sig);
        assertEq(_pendingVersion(body), 0);
        assertEq(factory.upgradeNonce(body), 2);
    }

    function test_cancelBySig_refusesWrongSigner() public {
        _schedule(body, 2);
        bytes memory sig = _signCancel(ownerPk, body, deadline);
        _expectCancelRevert(body, deadline, sig, abi.encodeWithSelector(LegalBodyFactory.BadSignature.selector));
        assertEq(_pendingVersion(body), 2);
    }

    function test_cancelBySig_refusesPastDeadline() public {
        _schedule(body, 2);
        uint256 past = block.timestamp - 1;
        bytes memory sig = _signCancel(guardianPk, body, past);
        _expectCancelRevert(body, past, sig, abi.encodeWithSelector(LegalBodyFactory.BadDeadline.selector));
    }

    function test_cancelBySig_refusesDeadlineTooFar() public {
        _schedule(body, 2);
        uint256 far = block.timestamp + 24 hours + 1;
        bytes memory sig = _signCancel(guardianPk, body, far);
        _expectCancelRevert(body, far, sig, abi.encodeWithSelector(LegalBodyFactory.BadDeadline.selector));
    }

    function test_cancelBySig_refusesReuse() public {
        _schedule(body, 2);
        bytes memory sig = _signCancel(guardianPk, body, deadline);
        vm.prank(stranger);
        factory.cancelLegalBodyUpgradeBySig(body, deadline, sig);
        _expectCancelRevert(body, deadline, sig, abi.encodeWithSelector(LegalBodyFactory.NoPendingUpgrade.selector));
        // Same version pending again: the used nonce still kills the old signature.
        _schedule(body, 2);
        _expectCancelRevert(body, deadline, sig, abi.encodeWithSelector(LegalBodyFactory.BadSignature.selector));
        assertEq(_pendingVersion(body), 2);
    }

    function test_cancelBySig_signatureDeadAfterNewSchedule() public {
        _schedule(body, 2);
        bytes memory sig = _signCancel(guardianPk, body, deadline);
        _schedule(body, 2);
        _expectCancelRevert(body, deadline, sig, abi.encodeWithSelector(LegalBodyFactory.BadSignature.selector));
        assertEq(_pendingVersion(body), 2);
    }

    function test_cancelBySig_refusesSignatureForAnotherBody() public {
        address second = _createWith(block.timestamp + 2 hours);
        _schedule(body, 2);
        _schedule(second, 2);
        bytes memory sig = _signCancel(guardianPk, second, deadline);
        _expectCancelRevert(body, deadline, sig, abi.encodeWithSelector(LegalBodyFactory.BadSignature.selector));
        assertEq(_pendingVersion(body), 2);
    }

    /// Checked before the deadline and the signature: an empty signature and a zero deadline
    /// still give this error.
    function test_cancelBySig_refusesNothingPending() public {
        _expectCancelRevert(body, 0, "", abi.encodeWithSelector(LegalBodyFactory.NoPendingUpgrade.selector));
    }

    function test_cancelBySig_refusesNonBody() public {
        address notBody = makeAddr("notABody");
        _expectCancelRevert(
            notBody, deadline, "", abi.encodeWithSelector(LegalBodyFactory.NotLegalBody.selector, notBody)
        );
    }
}

contract LegalBodyUpgradeExecuteTest is LegalBodyUpgradeUnitBase {
    LegalBodyV2Mock internal v2;
    LegalBodyV3Mock internal v3;

    function setUp() public override {
        super.setUp();
        v2 = _publishV2();
        v3 = _publishV3();
    }

    function _execute(address caller) internal {
        vm.prank(caller);
        factory.executeLegalBodyUpgrade(body);
    }

    function _expectExecuteRevert(bytes memory err) internal {
        vm.prank(stranger);
        vm.expectRevert(err);
        factory.executeLegalBodyUpgrade(body);
    }

    function _assertOnVersionOne() internal view {
        assertEq(_implementationOf(body), address(impl));
        assertEq(factory.versionOf(body), 1);
    }

    function test_execute_refusesOneSecondEarly() public {
        uint256 executableAt = _schedule(body, 2);
        vm.warp(executableAt - 1);
        _expectExecuteRevert(abi.encodeWithSelector(LegalBodyFactory.UpgradeTooEarly.selector));
        _assertOnVersionOne();
    }

    function test_execute_atDelay() public {
        uint256 executableAt = _schedule(body, 2);
        vm.warp(executableAt);
        _execute(stranger);
        assertEq(factory.versionOf(body), 2);
    }

    function test_execute_atLastSecondOfWindow() public {
        uint256 executableAt = _schedule(body, 2);
        vm.warp(executableAt + factory.UPGRADE_EXECUTION_WINDOW());
        _execute(stranger);
        assertEq(factory.versionOf(body), 2);
    }

    function test_execute_refusesAfterWindow() public {
        uint256 executableAt = _schedule(body, 2);
        vm.warp(executableAt + 30 days + 1);
        _expectExecuteRevert(abi.encodeWithSelector(LegalBodyFactory.UpgradeExpired.selector));
        _assertOnVersionOne();
        assertEq(_pendingVersion(body), 2);
    }

    function test_execute_byAnyone() public {
        vm.warp(_schedule(body, 2));
        _execute(address(0xCAFE));
        assertEq(_implementationOf(body), address(v2));
    }

    function test_execute_refusesTwice() public {
        vm.warp(_schedule(body, 2));
        _execute(stranger);
        _expectExecuteRevert(abi.encodeWithSelector(LegalBodyFactory.NoPendingUpgrade.selector));
        assertEq(LegalBodyV2Mock(payable(body)).migrations(), 1);
    }

    function test_execute_refusesNothingPending() public {
        _expectExecuteRevert(abi.encodeWithSelector(LegalBodyFactory.NoPendingUpgrade.selector));
    }

    function test_execute_supersededVersionNeverApplied() public {
        _schedule(body, 3);
        uint256 executableAt = _schedule(body, 2);
        vm.warp(executableAt);
        _execute(stranger);
        assertEq(factory.versionOf(body), 2);
        assertEq(_implementationOf(body), address(v2));
        _expectExecuteRevert(abi.encodeWithSelector(LegalBodyFactory.NoPendingUpgrade.selector));
        assertEq(_implementationOf(body), address(v2));
    }

    function test_execute_refusesChangedCode() public {
        uint256 executableAt = _schedule(body, 2);
        vm.etch(address(v2), address(v3).code);
        vm.warp(executableAt);
        _expectExecuteRevert(abi.encodeWithSelector(LegalBodyFactory.VersionCodeChanged.selector, 2));
        _assertOnVersionOne();
    }

    function test_execute_revertingMigrationLeavesBodyAndPending() public {
        LegalBodyRevertingMigrateMock bad = new LegalBodyRevertingMigrateMock();
        uint256 version = _publish(address(bad));
        uint256 executableAt = _schedule(body, version);
        vm.warp(executableAt);
        _expectExecuteRevert(abi.encodeWithSelector(LegalBodyRevertingMigrateMock.MigrationFailed.selector));
        _assertOnVersionOne();
        (,, uint32 recorded) = _record(body);
        assertEq(recorded, 1);
        (uint64 pendingVersion, uint64 pendingAt) = factory.pendingUpgrade(body);
        assertEq(pendingVersion, version);
        assertEq(pendingAt, executableAt);
    }

    function test_execute_emitsBothEventsAndMoves() public {
        vm.warp(_schedule(body, 2));
        vm.expectEmit(true, true, true, true, body);
        emit IERC1967.Upgraded(address(v2));
        vm.expectEmit(true, true, true, true, address(factory));
        emit LegalBodyFactory.LegalBodyUpgraded(body, 2, address(v2));
        _execute(stranger);

        assertEq(factory.versionOf(body), 2);
        assertEq(_implementationOf(body), address(v2));
        (address g, uint64 delay, uint32 version) = _record(body);
        assertEq(version, 2);
        assertEq(g, guardian);
        assertEq(delay, DELAY);
        assertEq(_pendingVersion(body), 0);
        assertEq(LegalBodyV2Mock(payable(body)).versionLabel(), "v2");
    }
}

contract LegalBodyUpgradeMigrationTest is LegalBodyUpgradeUnitBase {
    function test_migrate_stepwiseAndSkipEndAlike() public {
        _publishV2();
        _publishV3();
        address skipper = _createWith(block.timestamp + 2 hours);

        _upgrade(body, 2);
        _upgrade(body, 3);
        _upgrade(skipper, 3);

        LegalBodyV3Mock stepwise = LegalBodyV3Mock(payable(body));
        LegalBodyV3Mock skipped = LegalBodyV3Mock(payable(skipper));
        assertEq(stepwise.added(), 42);
        assertEq(stepwise.addedThree(), 7);
        assertEq(skipped.added(), 42);
        assertEq(skipped.addedThree(), 7);
        assertEq(stepwise.migrations(), 2);
        assertEq(skipped.migrations(), 1);
    }

    function test_migrate_stepNeverRunsTwice() public {
        _publishV2();
        _publishV3();
        _upgrade(body, 2);
        assertEq(LegalBodyV2Mock(payable(body)).added(), 42);
        assertEq(LegalBodyV2Mock(payable(body)).migrations(), 1);
        _upgrade(body, 3);
        assertEq(LegalBodyV3Mock(payable(body)).added(), 42, "version 2's step is not run again");
        assertEq(LegalBodyV3Mock(payable(body)).migrations(), 2);
    }

    function test_migrate_versionWithoutMigrateNeverApplies() public {
        LegalBodyNoMigrateMock noMigrate = new LegalBodyNoMigrateMock();
        uint256 version = _publish(address(noMigrate));
        uint256 executableAt = _schedule(body, version);
        vm.warp(executableAt);
        vm.prank(stranger);
        vm.expectRevert(Errors.FailedCall.selector);
        factory.executeLegalBodyUpgrade(body);
        assertEq(_implementationOf(body), address(impl));
        assertEq(factory.versionOf(body), 1);
        assertEq(_pendingVersion(body), version);
    }

    /// The body's counter follows its version, whether it moves one version at a time or skips.
    function test_migrate_counterFollowsTheVersion() public {
        _publishV2();
        _publishV3();
        address skipper = _createWith(block.timestamp + 2 hours);
        assertEq(LegalBody(payable(body)).initializedVersion(), 1);

        _upgrade(body, 2);
        assertEq(LegalBody(payable(body)).initializedVersion(), 2);
        _upgrade(body, 3);
        assertEq(LegalBody(payable(body)).initializedVersion(), 3);
        _upgrade(skipper, 3);
        assertEq(LegalBody(payable(skipper)).initializedVersion(), 3);

        // The logic contracts themselves are locked at the largest value.
        assertEq(impl.initializedVersion(), type(uint64).max);
    }

    /// A version whose step is numbered above the number it is listed under cannot be applied:
    /// it would leave the body unable to take the next version.
    function test_migrate_refusesStepNumberedAboveTheVersion() public {
        uint256 version = _publish(address(new LegalBodyNumberedMock(3)));
        assertEq(version, 2);
        _expectMismatch(body, version, 3);
    }

    /// A version whose step is numbered below its listing passes `reinitializer` for a body that
    /// skips to it, and is refused all the same.
    function test_migrate_refusesStepNumberedBelowTheVersion() public {
        _publishV2();
        uint256 version = _publish(address(new LegalBodyNumberedMock(2)));
        assertEq(version, 3);
        _expectMismatch(body, version, 2);
    }

    /// A step that does not count itself leaves the counter where it was, and is refused.
    function test_migrate_refusesStepThatDoesNotCountItself() public {
        uint256 version = _publish(address(new LegalBodyUncountedMigrateMock()));
        _expectMismatch(body, version, 1);
    }

    /// Schedules `version` for `legalBody`, waits, and expects the execute to revert because the
    /// body's counter would be `initialized`; nothing moved and the upgrade is still pending.
    function _expectMismatch(address legalBody, uint256 version, uint256 initialized) internal {
        uint256 executableAt = _schedule(legalBody, version);
        vm.warp(executableAt);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(LegalBodyFactory.MigrationNumberMismatch.selector, version, initialized));
        factory.executeLegalBodyUpgrade(legalBody);
        assertEq(_implementationOf(legalBody), address(impl));
        assertEq(factory.versionOf(legalBody), 1);
        assertEq(_pendingVersion(legalBody), version);
        assertEq(LegalBody(payable(legalBody)).initializedVersion(), 1);
    }

    function test_migrate_directCallRefused() public {
        _publishV2();
        _upgrade(body, 2);
        address[4] memory callers = [guardian, novi, idOwner, stranger];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(LegalManager.NotManager.selector);
            LegalBodyV2Mock(payable(body)).migrate(1);
        }
        assertEq(LegalBodyV2Mock(payable(body)).added(), 42);
    }

    function test_migrate_secondRunByManagerRefused() public {
        _publishV2();
        _upgrade(body, 2);
        vm.prank(address(factory));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        LegalBodyV2Mock(payable(body)).migrate(1);
        assertEq(LegalBodyV2Mock(payable(body)).added(), 42);
        assertEq(LegalBodyV2Mock(payable(body)).migrations(), 1);
    }
}

contract LegalBodyUpgradeRecordTest is LegalBodyUpgradeUnitBase {
    address internal wrongGuardian;

    function setUp() public override {
        super.setUp();
        _publish(address(new LegalBodyFaultyMock()));
        _upgrade(body, 2);
        _publishV3();
        wrongGuardian = LegalManager(payable(body)).guardian();
    }

    function test_record_faultyVersionRewritesBodyNotRecord() public view {
        LegalBodyFaultyMock faulty = LegalBodyFaultyMock(payable(body));
        assertEq(wrongGuardian, faulty.WRONG_GUARDIAN());
        assertEq(LegalManager(payable(body)).amendmentDelay(), faulty.WRONG_DELAY());
        (address g, uint64 delay, uint32 version) = _record(body);
        assertEq(g, guardian);
        assertEq(delay, DELAY);
        assertEq(version, 2);
    }

    function test_record_nextUpgradeWaitsRecordedDelay() public {
        uint256 scheduledAt = block.timestamp;
        uint256 executableAt = _schedule(body, 3);
        assertEq(executableAt, scheduledAt + DELAY);
        vm.warp(scheduledAt + 1 hours);
        vm.expectRevert(LegalBodyFactory.UpgradeTooEarly.selector);
        factory.executeLegalBodyUpgrade(body);
        vm.warp(executableAt);
        factory.executeLegalBodyUpgrade(body);
        assertEq(factory.versionOf(body), 3);
    }

    function test_record_wrongGuardianCannotCancel() public {
        _schedule(body, 3);
        vm.prank(wrongGuardian);
        vm.expectRevert(LegalBodyFactory.NotGuardian.selector);
        factory.cancelLegalBodyUpgrade(body);
        vm.prank(guardian);
        factory.cancelLegalBodyUpgrade(body);
        assertEq(_pendingVersion(body), 0);
    }

    function test_record_wrongGuardianCannotSchedule() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signUpgrade(0xDEAD, body, 3, deadline);
        vm.prank(wrongGuardian);
        vm.expectRevert(LegalBodyFactory.BadSignature.selector);
        factory.scheduleLegalBodyUpgrade(body, 3, deadline, sig);
    }
}

/// @dev The body names a guardian whose key the test holds: that key's real signatures are
///      still refused, because the factory reads only its own record.
contract LegalBodyUpgradeRecordKnownKeyTest is LegalBodyUpgradeUnitBase {
    uint256 internal constant WRONG_PK = 0xBADBAD;

    function setUp() public override {
        super.setUp();
        _publish(address(new LegalBodyKnownWrongGuardianMock(vm.addr(WRONG_PK))));
        _upgrade(body, 2);
        _publishV3();
    }

    function test_record_bodyGuardianSignatureRefusedForSchedule() public {
        assertEq(LegalManager(payable(body)).guardian(), vm.addr(WRONG_PK));
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signUpgrade(WRONG_PK, body, 3, deadline);
        _expectScheduleRevert(body, 3, deadline, sig, abi.encodeWithSelector(LegalBodyFactory.BadSignature.selector));
        sig = _signUpgrade(guardianPk, body, 3, deadline);
        vm.prank(stranger);
        factory.scheduleLegalBodyUpgrade(body, 3, deadline, sig);
        assertEq(_executableAt(body), block.timestamp + DELAY);
    }

    function test_record_bodyGuardianSignatureRefusedForCancel() public {
        _schedule(body, 3);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signCancel(WRONG_PK, body, deadline);
        vm.prank(stranger);
        vm.expectRevert(LegalBodyFactory.BadSignature.selector);
        factory.cancelLegalBodyUpgradeBySig(body, deadline, sig);
        assertEq(_pendingVersion(body), 3);
    }
}

contract LegalBodyUpgradeLockTest is LegalBodyUpgradeUnitBase {
    /// @dev Every party but the manager is refused a direct upgrade of `b`.
    function _assertLocked(address b) internal {
        address target = address(new LegalBodyV3Mock());
        address[5] memory callers = [guardian, novi, idOwner, stranger, LegalManager(payable(b)).guardian()];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(LegalManager.NotManager.selector);
            LegalBody(payable(b)).upgradeToAndCall(target, "");
        }
    }

    function test_lock_versionOne() public {
        _assertLocked(body);
    }

    function test_lock_afterV2AndMovesOn() public {
        _publishV2();
        _upgrade(body, 2);
        _assertLocked(body);
        LegalBodyV3Mock v3 = _publishV3();
        _upgrade(body, 3);
        assertEq(_implementationOf(body), address(v3));
    }

    function test_lock_afterV3AndMovesOn() public {
        _publishV2();
        _publishV3();
        _upgrade(body, 3);
        _assertLocked(body);
        LegalBodyNumberedMock v4 = new LegalBodyNumberedMock(4);
        _publish(address(v4));
        _upgrade(body, 4);
        assertEq(_implementationOf(body), address(v4));
    }

    function test_lock_afterFaultyAndMovesOn() public {
        _publish(address(new LegalBodyFaultyMock()));
        _upgrade(body, 2);
        _assertLocked(body);
        LegalBodyV3Mock v3 = _publishV3();
        _upgrade(body, 3);
        assertEq(_implementationOf(body), address(v3));
    }

    function test_lock_afterNumberedAndMovesOn() public {
        _publish(address(new LegalBodyNumberedMock(2)));
        _upgrade(body, 2);
        _assertLocked(body);
        LegalBodyNumberedMock v3 = new LegalBodyNumberedMock(3);
        _publish(address(v3));
        _upgrade(body, 3);
        assertEq(_implementationOf(body), address(v3));
        assertEq(LegalBodyNumberedMock(payable(body)).lastFromVersion(), 2);
    }

    /// Once the manager moved, the factory is refused like everyone else.
    function test_lock_afterManagerMoved() public {
        address newManager = makeAddr("laterFactory");
        _publish(address(new LegalBodyMovesManagerMock(newManager)));
        _upgrade(body, 2);
        assertEq(LegalManager(payable(body)).manager(), newManager);
        _assertLocked(body);
        _publishV3();
        vm.warp(_schedule(body, 3));
        vm.expectRevert(LegalManager.NotManager.selector);
        factory.executeLegalBodyUpgrade(body);
    }
}

contract LegalBodyUpgradeStatusTest is LegalBodyUpgradeUnitBase {
    LegalBodyV2Mock internal v2;

    function setUp() public override {
        super.setUp();
        v2 = _publishV2();
    }

    function _status() internal view returns (LegalManager.Status) {
        return LegalManager(payable(body)).status();
    }

    function test_status_upgradeWhileWindingDown() public {
        vm.prank(guardian);
        LegalManager(payable(body)).initiateDissolution();
        _upgrade(body, 2);
        assertEq(_implementationOf(body), address(v2));
        assertEq(uint8(_status()), uint8(LegalManager.Status.WindingDown));
    }

    function test_status_upgradeWhileDissolved() public {
        vm.prank(guardian);
        LegalManager(payable(body)).initiateDissolution();
        vm.warp(block.timestamp + DELAY);
        vm.prank(guardian);
        LegalManager(payable(body)).finalizeDissolution();
        _upgrade(body, 2);
        assertEq(_implementationOf(body), address(v2));
        assertEq(uint8(_status()), uint8(LegalManager.Status.Dissolved));
    }

    function test_status_dissolutionDuringDelayDoesNotStopUpgrade() public {
        uint256 executableAt = _schedule(body, 2);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(guardian);
        LegalManager(payable(body)).initiateDissolution();
        vm.warp(executableAt);
        factory.executeLegalBodyUpgrade(body);
        assertEq(_implementationOf(body), address(v2));
        assertEq(uint8(_status()), uint8(LegalManager.Status.WindingDown));
    }
}

contract LegalBodyUpgradeCoexistenceTest is LegalBodyUpgradeUnitBase {
    bytes32 internal constant NEW = keccak256("oa-manifest-v2");
    LegalBodyV2Mock internal v2;

    function setUp() public override {
        super.setUp();
        v2 = _publishV2();
    }

    function _scheduleAmendment(bytes32 h) internal {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(guardianPk, factory.amendmentDigest(body, h, factory.amendmentNonce(body), deadline));
        vm.prank(novi);
        factory.scheduleOperatingAgreementUpdate(body, h, deadline, sig);
    }

    function _oa() internal view returns (bytes32 h) {
        (,, h,) = LegalManager(payable(body)).meta();
    }

    function test_coexist_upgradeThenAmendment() public {
        _scheduleAmendment(NEW);
        uint256 amendmentAt = LegalManager(payable(body)).scheduledAt(NEW);
        uint256 executableAt = _schedule(body, 2);
        vm.warp(executableAt);
        factory.executeLegalBodyUpgrade(body);

        assertEq(factory.pendingAmendment(body), NEW, "the factory still holds the amendment");
        assertEq(LegalManager(payable(body)).scheduledAt(NEW), amendmentAt, "the body still holds its time");
        factory.executeOperatingAgreementUpdate(body, NEW);
        assertEq(_oa(), NEW);
        assertEq(_implementationOf(body), address(v2));
    }

    function test_coexist_amendmentThenUpgrade() public {
        _scheduleAmendment(NEW);
        uint256 executableAt = _schedule(body, 2);
        vm.warp(executableAt);
        factory.executeOperatingAgreementUpdate(body, NEW);
        assertEq(_oa(), NEW);
        factory.executeLegalBodyUpgrade(body);
        assertEq(_implementationOf(body), address(v2));
        assertEq(_oa(), NEW, "the upgrade keeps the amended agreement");
    }
}

contract LegalBodyUpgradeBodyTest is LegalBodyUpgradeUnitBase {
    function test_body_upgradeRefusedToNonManagers() public {
        LegalBodyV2Mock v2 = new LegalBodyV2Mock();
        address[3] memory callers = [guardian, novi, stranger];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(LegalManager.NotManager.selector);
            LegalBody(payable(body)).upgradeToAndCall(address(v2), "");
        }
        assertEq(_implementationOf(body), address(impl));
    }

    function test_body_logicContractRefusesUpgrade() public {
        LegalBodyV2Mock v2 = new LegalBodyV2Mock();
        vm.prank(address(factory));
        vm.expectRevert(UUPSUpgradeable.UUPSUnauthorizedCallContext.selector);
        impl.upgradeToAndCall(address(v2), "");
    }

    function test_body_initializeRefused() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(address(1), address(2), 1 hours, 0, "", 0, bytes32(0));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        LegalManager(payable(body)).initialize(address(1), address(2), 1 hours, 0, "", 0, bytes32(0));
    }
}

contract LegalBodyUpgradeLinkTest is LegalBodyUpgradeUnitBase {
    function test_linked_returnsBody() public {
        _point(body);
        assertEq(factory.linkedLegalBody(agentId), body);
    }

    function test_linked_zeroOnceManagerMoved() public {
        _point(body);
        assertEq(factory.linkedLegalBody(agentId), body);
        _publish(address(new LegalBodyMovesManagerMock(makeAddr("laterFactory"))));
        _upgrade(body, 2);
        assertEq(factory.linkedLegalBody(agentId), address(0));
    }

    function test_linked_survivesOrdinaryUpgrade() public {
        _point(body);
        _publishV2();
        _upgrade(body, 2);
        assertEq(factory.linkedLegalBody(agentId), body);
    }
}
