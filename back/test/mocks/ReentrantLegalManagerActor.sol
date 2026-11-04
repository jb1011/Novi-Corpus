// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {LegalManager} from "../../src/LegalManager.sol";

/// @dev ERC-20 that is also the LegalManager's guardian, so a re-entrant `sweep` made from its
///      transfer hook passes the role check and can only be stopped by the reentrancy guard.
///      Deploy the LegalManager with this token's address as `guardian`.
///
///      The re-entry fires at most once, and only for a transfer out of the armed LegalManager,
///      so setup mints are unaffected.
contract ReentrantGuardianToken is ERC20 {
    address public lm;
    bool private _armed;

    constructor() ERC20("ReentrantGuardianToken", "RGT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address lm_) external {
        lm = lm_;
        _armed = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (_armed && from == lm) {
            _armed = false; // one re-entry attempt is enough and avoids unbounded recursion
            address[] memory tokens = new address[](1);
            tokens[0] = address(this);
            LegalManager(payable(lm)).sweep(tokens, address(0xBEEF));
        }
    }
}

/// @dev LegalManager guardian whose `receive` re-enters `sweepNative` when it is paid by the
///      armed LegalManager. By the time the payment arrives the LegalManager's native balance is
///      already zero, so without the reentrancy guard the nested call would succeed as a no-op.
contract ReentrantGuardianPayee {
    address public lm;
    bool private _armed;

    function arm(address lm_) external {
        lm = lm_;
        _armed = true;
    }

    receive() external payable {
        if (_armed && msg.sender == lm) {
            _armed = false; // one re-entry attempt is enough and avoids unbounded recursion
            LegalManager(payable(lm)).sweepNative(address(this));
        }
    }
}
