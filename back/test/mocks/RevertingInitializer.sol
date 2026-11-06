// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev A contract that looks like a LegalManager with no manager set but whose `initialize`
///      reverts with an error other than `InvalidInitialization`. It is the stand-in for a
///      target whose initialisers were never locked in the way a real implementation's are:
///      the factory must refuse it, because the refusal depends on WHICH error comes back.
contract RevertingInitializer {
    error Nope();

    function manager() external pure returns (address) {
        return address(0);
    }

    function initialize(address, address, uint256, uint256, string calldata, uint64, bytes32) external pure {
        revert Nope();
    }
}
