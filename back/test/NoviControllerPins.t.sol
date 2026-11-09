// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ControllerTestBase, Echo} from "./NoviController.t.sol";
import {NoviController} from "../src/NoviController.sol";

/// @dev Constructor pins: `address(0)` means "unpinned" in the relay, so the constructor must
///      refuse a zero target, a codeless target and a repeated selector. The admin's own
///      `setBoundTarget(selector, address(0))` stays the way to unpin.
contract NoviControllerConstructorPinsTest is ControllerTestBase {
    function _deployWithPins(bytes4[] memory selectors, address[] memory targets)
        internal
        returns (NoviController)
    {
        return new NoviController(ADMIN_DELAY, admin, executor, new bytes4[](0), selectors, targets);
    }

    function test_constructorRejectsZeroPinTarget() public {
        bytes4[] memory s = new bytes4[](1);
        s[0] = Echo.ping.selector;
        address[] memory t = new address[](1);
        t[0] = address(0);
        vm.expectRevert(NoviController.ZeroPinTarget.selector);
        _deployWithPins(s, t);
    }

    function test_constructorRejectsCodelessPinTarget() public {
        address eoa = makeAddr("eoa");
        bytes4[] memory s = new bytes4[](1);
        s[0] = Echo.ping.selector;
        address[] memory t = new address[](1);
        t[0] = eoa;
        vm.expectRevert(abi.encodeWithSelector(NoviController.PinTargetNotContract.selector, eoa));
        _deployWithPins(s, t);
    }

    function test_constructorRejectsDuplicatePin() public {
        bytes4[] memory s = new bytes4[](2);
        s[0] = Echo.ping.selector;
        s[1] = Echo.ping.selector;
        address[] memory t = new address[](2);
        t[0] = address(echo);
        t[1] = address(echo);
        vm.expectRevert(abi.encodeWithSelector(NoviController.DuplicatePin.selector, Echo.ping.selector));
        _deployWithPins(s, t);
    }

    function test_constructorAcceptsTwoSelectorsOneTarget() public {
        bytes4[] memory s = new bytes4[](2);
        s[0] = Echo.ping.selector;
        s[1] = Echo.noArgs.selector;
        address[] memory t = new address[](2);
        t[0] = address(echo);
        t[1] = address(echo);
        NoviController c = _deployWithPins(s, t);
        assertEq(c.boundTarget(Echo.ping.selector), address(echo));
        assertEq(c.boundTarget(Echo.noArgs.selector), address(echo));
    }

    function test_setBoundTargetStillUnpinsWithZero() public {
        Echo other = new Echo();
        _grant(Echo.ping.selector, executor);
        vm.prank(admin);
        controller.setBoundTarget(Echo.ping.selector, address(echo));
        (bool blocked,) = _relay(executor, address(other), abi.encodeCall(Echo.ping, (1)));
        assertFalse(blocked);

        vm.prank(admin);
        controller.setBoundTarget(Echo.ping.selector, address(0));
        assertEq(controller.boundTarget(Echo.ping.selector), address(0));
        _relayOk(executor, address(other), abi.encodeCall(Echo.ping, (1)));
        assertEq(other.lastX(), 1);
    }
}
