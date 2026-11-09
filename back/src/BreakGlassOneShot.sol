// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NoviController} from "./NoviController.sol";

/// @title BreakGlassOneShot
/// @notice Single-use ceremony contract that makes a break-glass relay atomic under a
///         single-EOA controller admin: the grant is SPENT AND REVOKED in ONE transaction —
///         whether or not the action itself succeeded — so a dangerous grant never lives across
///         blocks.
/// @dev    Design §3. The full ceremony is exactly two admin transactions:
///           1. `controller.grantRole(bytes32(helper.selector()), helper)`  (or WILDCARD_ROLE)
///           2. `helper.execute()`                                          (relay + renounce)
///         Deliberately dumb: one target, one payload, one shot, fixed at construction. Deploy a
///         new helper per ceremony rather than making this contract configurable — a reusable
///         break-glass contract is a standing privilege waiting to be re-granted by mistake.
contract BreakGlassOneShot {
    NoviController public immutable controller;
    /// @notice The only address allowed to fire the ceremony: whoever deployed this helper.
    /// @dev    Separate from the controller admin on purpose — the deployer is the operator
    ///         running the runbook; the admin's authority is expressed by the grant in step 1,
    ///         which is what actually gates the power. Without the grant, `execute` reverts with
    ///         {NotGranted} and the helper stays unspent.
    address public immutable admin;
    address public immutable target;
    /// @notice Selector of {callData}; the role the controller must have granted this helper.
    bytes4 public immutable selector;

    /// @notice One-shot latch. Set before the external call (checks-effects-interactions), so a
    ///         reentrant `execute` is impossible even if the target calls back.
    bool public used;
    /// @notice The exact payload relayed. `bytes` cannot be `immutable`; it is written once in
    ///         the constructor and never again.
    bytes public callData;

    error NotAdmin();
    error AlreadyUsed();
    error CallDataTooShort();
    /// @dev The helper holds neither its selector role nor WILDCARD on the controller. Firing now
    ///      would spend the helper on a relay the controller is certain to refuse, and a grant made
    ///      later to the spent helper could never be renounced by it.
    error NotGranted();

    /// @notice The ceremony's receipt. `ok` is the ONLY success signal — `execute` itself does not
    ///         revert when the action fails, because reverting would roll the revocation back.
    /// @param data the target's return data when `ok`, otherwise its revert data verbatim
    ///        (the controller bubbles it through, so a failed ceremony still names its cause).
    event BreakGlassExecuted(address indexed target, bytes4 indexed selector, bool ok, bytes data);

    constructor(NoviController controller_, address target_, bytes memory callData_) {
        if (callData_.length < 4) revert CallDataTooShort();
        bytes4 sel;
        assembly {
            // First word of the bytes payload; a bytes4 assignment keeps the leading 4 bytes.
            sel := mload(add(callData_, 0x20))
        }
        controller = controller_;
        admin = msg.sender;
        target = target_;
        selector = sel;
        callData = callData_;
    }

    /// @notice Relay {callData} to {target} through the controller and give the roles back —
    ///         SUCCEED OR FAIL. The helper is spent (`used`) and both possible roles are renounced
    ///         on the controller in the SAME transaction, whatever the target did.
    /// @dev    Why this does not bubble the target's revert: reverting would roll back `used` AND
    ///         the renounces, leaving the dangerous grant standing on the controller after a
    ///         ceremony the admin believes is over — the failure mode is strictly worse than a
    ///         quiet one. So the failure is REPORTED, not thrown: the admin reads `ok` (or the
    ///         {BreakGlassExecuted} event, which carries the revert data). A failed action needs a
    ///         FRESH grant and a FRESH helper; this one can never fire again.
    ///
    ///         The renounces are unconditional: OZ's `renounceRole` -> `_revokeRole` is a no-op
    ///         for a role the account does not hold, so the helper needs no per-role check to
    ///         decide what to give back. The `NotGranted` pre-check only decides whether the
    ///         ceremony fires; once it fires, the helper is spent whatever the target does.
    /// @return ok   whether the relayed call succeeded — the ONLY success signal.
    /// @return data the target's return data, or its revert data when `ok` is false.
    function execute() external returns (bool ok, bytes memory data) {
        if (msg.sender != admin) revert NotAdmin();
        if (used) revert AlreadyUsed();
        if (
            !controller.hasRole(bytes32(selector), address(this))
                && !controller.hasRole(controller.WILDCARD_ROLE(), address(this))
        ) revert NotGranted();
        used = true;

        // Euler encoding: payload with the target appended as the trailing 20 bytes.
        (ok, data) = address(controller).call(abi.encodePacked(callData, target));

        // Give both roles back regardless of the outcome. `renounceRole` requires the caller to be
        // the account, which is exactly this contract.
        controller.renounceRole(bytes32(selector), address(this));
        controller.renounceRole(controller.WILDCARD_ROLE(), address(this));

        emit BreakGlassExecuted(target, selector, ok, data);
    }
}
