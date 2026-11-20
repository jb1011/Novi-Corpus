// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {LegalManager} from "./LegalManager.sol";

/// @title LegalBody
/// @notice The logic contract behind every legal body a LegalBodyFactory creates: LegalManager,
///         unchanged, plus the UUPS upgrade entry point. Each body is an ERC-1967 proxy that
///         keeps one address for life and points at the version of this code it runs.
/// @dev    The only code here is the lock, and a read of the initialisation counter the
///         factory checks after every upgrade: the body accepts an upgrade from its manager and
///         from no one else. The manager of a factory-created body is the factory, which
///         upgrades a body only to a version it lists and only with the signature of that
///         body's guardian (see LegalBodyFactory). This contract adds no storage: its layout
///         is LegalManager's.
///         No function below is `virtual`, so a later version that inherits this contract
///         cannot replace the lock, the entry point it guards or the counter it reports. A later version
///         must also never write the ERC-1967 implementation slot itself.
contract LegalBody is LegalManager, UUPSUpgradeable {
    /// @notice Move this body to `newImplementation` and run `data` on it. Manager only, and
    ///         only through a proxy.
    /// @dev    Restated only to seal it: the behaviour is OpenZeppelin's.
    function upgradeToAndCall(address newImplementation, bytes memory data) public payable override {
        super.upgradeToAndCall(newImplementation, data);
    }

    /// @notice The number of the last initialisation step this body ran: 1 after creation, N
    ///         after the one-time step of version N.
    /// @dev    The factory reads it after every upgrade and refuses an upgrade that leaves it
    ///         different from the version's number. On the logic contract itself it is the
    ///         largest value, because the logic contract is locked.
    function initializedVersion() external view returns (uint64) {
        return _getInitializedVersion();
    }

    /// @dev The lock. `onlyManager` is the whole check.
    function _authorizeUpgrade(address) internal view override onlyManager {}
}
