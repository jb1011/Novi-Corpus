// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LegalBodyFactory} from "../src/LegalBodyFactory.sol";
import {LegalManager} from "../src/LegalManager.sol";
import {LegalBodyUpgradeTestBase} from "./helpers/LegalBodyUpgradeBase.sol";
import {LegalBodyNumberedMock} from "./mocks/LegalBodyVersions.sol";
import {MockERC1271Wallet} from "./mocks/MockERC1271Wallet.sol";

contract LegalBodyUpgradeFuzzTest is LegalBodyUpgradeTestBase {
    address internal body;

    function setUp() public override {
        super.setUp();
        body = _create();
    }

    /// @dev A body for `g` with `delay`; `oa` keeps each link digest distinct.
    function _createFor(address g, uint256 delay, bytes32 oa) internal returns (address lb) {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signLink(ownerPk, agentId, g, delay, oa, deadline);
        vm.prank(novi);
        lb = factory.createLegalBody(agentId, g, delay, oa, deadline, sig);
    }

    /// @dev Publishes `LegalBodyNumberedMock`s until `count` versions are listed.
    function _publishNumberedUpTo(uint256 count) internal {
        for (uint256 n = factory.versionCount() + 1; n <= count; n++) {
            // forge-lint: disable-next-line(unsafe-typecast)
            _publish(address(new LegalBodyNumberedMock(uint64(n))));
        }
    }

    function _expectScheduleRevert(address lb, uint256 version, uint256 deadline, bytes memory sig, bytes memory err)
        internal
    {
        vm.prank(stranger);
        vm.expectRevert(err);
        factory.scheduleLegalBodyUpgrade(lb, version, deadline, sig);
    }

    // ------------------------------------------------------------------
    // Execute: the window decides, the caller never does
    // ------------------------------------------------------------------

    /// Execution succeeds exactly inside [executableAt, executableAt + window] and reverts with
    /// the error naming the side it missed, whoever sends it.
    function testFuzz_executeSucceedsExactlyInsideWindow(address caller, uint256 offset) public {
        _publishV2();
        uint256 executableAt = _schedule(body, 2);
        uint256 windowEnd = executableAt + factory.UPGRADE_EXECUTION_WINDOW();
        offset = bound(offset, 0, windowEnd - block.timestamp + 365 days);
        vm.warp(block.timestamp + offset);

        vm.prank(caller);
        if (block.timestamp < executableAt) {
            vm.expectRevert(LegalBodyFactory.UpgradeTooEarly.selector);
            factory.executeLegalBodyUpgrade(body);
        } else if (block.timestamp > windowEnd) {
            vm.expectRevert(LegalBodyFactory.UpgradeExpired.selector);
            factory.executeLegalBodyUpgrade(body);
        } else {
            factory.executeLegalBodyUpgrade(body);
            assertEq(factory.versionOf(body), 2);
            assertEq(_implementationOf(body), factory.versionInfo(2).implementation);
            assertEq(_pendingVersion(body), 0);
            return;
        }
        // A refused execute leaves the body where it was and the upgrade waiting.
        assertEq(factory.versionOf(body), 1);
        assertEq(_implementationOf(body), address(impl));
        assertEq(_pendingVersion(body), 2);
        assertEq(_executableAt(body), executableAt);
    }

    // ------------------------------------------------------------------
    // Schedule: only the guardian's key over the current nonce
    // ------------------------------------------------------------------

    /// Any key other than the guardian's is refused, and the refusal uses up no nonce: the
    /// guardian's own signature over the same nonce still works afterwards.
    function testFuzz_scheduleRefusesAnyOtherKey(uint256 pk) public {
        pk = boundPrivateKey(pk);
        vm.assume(pk != guardianPk);
        _publishV2();
        uint256 deadline = block.timestamp + 1 hours;

        _expectScheduleRevert(
            body,
            2,
            deadline,
            _signUpgrade(pk, body, 2, deadline),
            abi.encodeWithSelector(LegalBodyFactory.BadSignature.selector)
        );
        assertEq(factory.upgradeNonce(body), 0);
        assertEq(_pendingVersion(body), 0);

        vm.prank(stranger);
        factory.scheduleLegalBodyUpgrade(body, 2, deadline, _signUpgrade(guardianPk, body, 2, deadline));
        assertEq(factory.upgradeNonce(body), 1);
        assertEq(_pendingVersion(body), 2);
    }

    /// The guardian's own key over any nonce but the current one is refused.
    function testFuzz_scheduleRefusesGuardianKeyOverOtherNonce(uint256 nonce) public {
        vm.assume(nonce != 0);
        _publishV2();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig =
            _sign(guardianPk, factory.upgradeDigest(body, 2, factory.versionInfo(2).implementation, nonce, deadline));
        _expectScheduleRevert(body, 2, deadline, sig, abi.encodeWithSelector(LegalBodyFactory.BadSignature.selector));
        assertEq(factory.upgradeNonce(body), 0);
    }

    /// Arbitrary bytes are refused with BadSignature, never with an ECDSA library error: the
    /// factory recovers with `tryRecover`, which reports malformed input instead of reverting.
    function testFuzz_scheduleRefusesArbitrarySignatureBytes(bytes memory sig) public {
        _publishV2();
        _expectScheduleRevert(
            body, 2, block.timestamp + 1 hours, sig, abi.encodeWithSelector(LegalBodyFactory.BadSignature.selector)
        );
    }

    /// The guardian's valid signature with any single bit flipped is refused.
    function testFuzz_scheduleRefusesGuardianSignatureWithOneBitFlipped(uint256 bit) public {
        _publishV2();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signUpgrade(guardianPk, body, 2, deadline);
        bit = bound(bit, 0, sig.length * 8 - 1);
        sig[bit / 8] = sig[bit / 8] ^ bytes1(uint8(1) << uint8(bit % 8));
        _expectScheduleRevert(body, 2, deadline, sig, abi.encodeWithSelector(LegalBodyFactory.BadSignature.selector));
    }

    /// With an ERC-1271 guardian, a signature from any key but the wallet's signer is refused,
    /// and the signer's own signature is accepted.
    function testFuzz_scheduleErc1271GuardianRefusesOtherKeys(uint256 pk) public {
        uint256 walletSignerPk = 0xC0DE;
        pk = boundPrivateKey(pk);
        vm.assume(pk != walletSignerPk);
        MockERC1271Wallet wallet = new MockERC1271Wallet(vm.addr(walletSignerPk));
        address lb = _createFor(address(wallet), DELAY, keccak256("oa-1271"));
        _publishV2();
        uint256 deadline = block.timestamp + 1 hours;

        _expectScheduleRevert(
            lb,
            2,
            deadline,
            _signUpgrade(pk, lb, 2, deadline),
            abi.encodeWithSelector(LegalBodyFactory.BadSignature.selector)
        );

        vm.prank(stranger);
        factory.scheduleLegalBodyUpgrade(lb, 2, deadline, _signUpgrade(walletSignerPk, lb, 2, deadline));
        assertEq(_pendingVersion(lb), 2);
    }

    // ------------------------------------------------------------------
    // Schedule: only a published, live, later version
    // ------------------------------------------------------------------

    /// Six versions are listed, the body runs `current`, and version `withdrawnVersion` is
    /// withdrawn. Scheduling `version` succeeds exactly when it is listed, not withdrawn and
    /// later than `current`; otherwise it fails with the first rule it breaks.
    function testFuzz_scheduleOnlyPublishedLiveLaterVersion(uint256 current, uint256 withdrawnVersion, uint256 version)
        public
    {
        uint256 count = 6;
        _publishNumberedUpTo(count);
        current = bound(current, 1, count - 1);
        withdrawnVersion = bound(withdrawnVersion, 2, count);
        version = bound(version, 0, count + 2);
        if (current > 1) _upgrade(body, current);
        vm.prank(novi);
        factory.withdrawVersion(withdrawnVersion);

        uint256 deadline = block.timestamp + 1 hours;
        address implementation_ =
            (version == 0 || version > count) ? address(0) : factory.versionInfo(version).implementation;
        bytes memory sig = _sign(
            guardianPk, factory.upgradeDigest(body, version, implementation_, factory.upgradeNonce(body), deadline)
        );
        uint256 nonceBefore = factory.upgradeNonce(body);

        bytes memory err;
        if (version == 0 || version > count) {
            err = abi.encodeWithSelector(LegalBodyFactory.UnknownVersion.selector, version);
        } else if (version == withdrawnVersion) {
            err = abi.encodeWithSelector(LegalBodyFactory.VersionIsWithdrawn.selector, version);
        } else if (version <= current) {
            err = abi.encodeWithSelector(LegalBodyFactory.NotNewerVersion.selector, version);
        }

        if (err.length != 0) {
            _expectScheduleRevert(body, version, deadline, sig, err);
            assertEq(_pendingVersion(body), 0);
            assertEq(factory.upgradeNonce(body), nonceBefore);
        } else {
            vm.prank(stranger);
            factory.scheduleLegalBodyUpgrade(body, version, deadline, sig);
            assertEq(_pendingVersion(body), version);
            assertEq(factory.upgradeNonce(body), nonceBefore + 1);
        }
    }

    /// A version number far beyond the list is unknown.
    function testFuzz_scheduleRefusesUnlistedVersion(uint256 version) public {
        vm.assume(version == 0 || version > factory.versionCount());
        bytes memory sig =
            _sign(guardianPk, factory.upgradeDigest(body, version, address(0), 0, block.timestamp + 1 hours));
        _expectScheduleRevert(
            body,
            version,
            block.timestamp + 1 hours,
            sig,
            abi.encodeWithSelector(LegalBodyFactory.UnknownVersion.selector, version)
        );
    }

    // ------------------------------------------------------------------
    // The delay recorded at creation
    // ------------------------------------------------------------------

    /// For any delay the factory accepts, the record holds it, the body holds it, and an upgrade
    /// scheduled at any later time becomes executable exactly that long after.
    function testFuzz_executableAtIsNowPlusRecordedDelay(uint256 delay, uint256 later) public {
        delay = bound(delay, factory.MIN_AMENDMENT_DELAY(), factory.MAX_AMENDMENT_DELAY());
        later = bound(later, 0, 3650 days);
        address lb = _createFor(guardian, delay, keccak256(abi.encode("oa", delay)));
        LegalBodyNumberedMock v2 = new LegalBodyNumberedMock(2);
        _publish(address(v2));

        (address recordedGuardian, uint64 recordedDelay, uint32 recordedVersion) = factory.bodyRecord(lb);
        assertEq(recordedGuardian, guardian);
        assertEq(recordedDelay, delay);
        assertEq(recordedVersion, 1);
        assertEq(LegalManager(payable(lb)).amendmentDelay(), delay);

        vm.warp(block.timestamp + later);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signUpgrade(guardianPk, lb, 2, deadline);
        vm.expectEmit(true, true, true, true, address(factory));
        emit LegalBodyFactory.LegalBodyUpgradeScheduled(lb, 2, address(v2), block.timestamp + delay);
        vm.prank(stranger);
        factory.scheduleLegalBodyUpgrade(lb, 2, deadline, sig);
        assertEq(_executableAt(lb), block.timestamp + delay);
    }
}
