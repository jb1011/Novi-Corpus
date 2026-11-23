// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {LegalBodyFactory} from "../../src/LegalBodyFactory.sol";
import {LegalBodyFactoryTestBase} from "../LegalBodyFactory.t.sol";
import {LegalBodyV2Mock, LegalBodyV3Mock} from "../mocks/LegalBodyVersions.sol";

/// @dev The shared fixture of the upgrade tests: the factory fixture, plus publishing a version
///      as the owner and signing, scheduling and executing an upgrade as the guardian.
abstract contract LegalBodyUpgradeTestBase is LegalBodyFactoryTestBase {
    /// @dev Publishes `implementation_` as the factory's owner.
    function _publish(address implementation_) internal returns (uint256 version) {
        vm.prank(novi);
        version = factory.publishVersion(implementation_);
    }

    function _publishV2() internal returns (LegalBodyV2Mock v2) {
        v2 = new LegalBodyV2Mock();
        _publish(address(v2));
    }

    function _publishV3() internal returns (LegalBodyV3Mock v3) {
        v3 = new LegalBodyV3Mock();
        _publish(address(v3));
    }

    /// @dev The implementation a body's ERC-1967 slot holds.
    function _implementationOf(address body) internal view returns (address) {
        return address(uint160(uint256(vm.load(body, ERC1967Utils.IMPLEMENTATION_SLOT))));
    }

    function _pendingVersion(address body) internal view returns (uint256 version) {
        (version,) = factory.pendingUpgrade(body);
    }

    function _executableAt(address body) internal view returns (uint256 executableAt) {
        (, executableAt) = factory.pendingUpgrade(body);
    }

    /// @dev `pk`'s signature for moving `body` to the published `version`, over the body's
    ///      current upgrade nonce. Reverts for a version the factory does not list: build the
    ///      digest by hand for that case.
    function _signUpgrade(uint256 pk, address body, uint256 version, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        LegalBodyFactory.Version memory v = factory.versionInfo(version);
        return _sign(pk, factory.upgradeDigest(body, version, v.implementation, factory.upgradeNonce(body), deadline));
    }

    /// @dev `pk`'s signature for cancelling the pending upgrade of `body`, over the body's
    ///      current upgrade nonce.
    function _signCancel(uint256 pk, address body, uint256 deadline) internal view returns (bytes memory) {
        return _sign(pk, factory.upgradeCancelDigest(body, _pendingVersion(body), factory.upgradeNonce(body), deadline));
    }

    /// @dev The guardian signs, a stranger sends. Returns when the upgrade becomes executable.
    function _schedule(address body, uint256 version) internal returns (uint256 executableAt) {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signUpgrade(guardianPk, body, version, deadline);
        vm.prank(stranger);
        factory.scheduleLegalBodyUpgrade(body, version, deadline, sig);
        executableAt = _executableAt(body);
    }

    /// @dev Schedules, waits out the delay exactly, and has a stranger execute.
    function _upgrade(address body, uint256 version) internal {
        vm.warp(_schedule(body, version));
        vm.prank(stranger);
        factory.executeLegalBodyUpgrade(body);
    }
}
