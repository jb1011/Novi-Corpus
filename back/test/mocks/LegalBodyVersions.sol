// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LegalBody} from "../../src/LegalBody.sol";
import {ILegalBodyVersion} from "../../src/interfaces/ILegalBodyVersion.sol";

// Stand-ins for later versions of the legal body's code, for the upgrade tests. Each inherits
// LegalBody, so none can replace the upgrade lock, and each appends state after LegalManager's.
//
// A version's `reinitializer(N)` number must be the number it is published under. A test that
// publishes these in another order than their numbers gets a migration that reverts.

/// @dev Version 2: one appended variable and a one-time step. `+=` and the counter make a step
///      that ran twice visible.
contract LegalBodyV2Mock is LegalBody, ILegalBodyVersion {
    uint256 public added;
    uint256 public migrations;

    function migrate(uint256 fromVersion) external virtual onlyManager reinitializer(2) {
        _stepTwo(fromVersion);
        migrations += 1;
    }

    function _stepTwo(uint256 fromVersion) internal {
        if (fromVersion < 2) added += 42;
    }

    function versionLabel() external pure virtual returns (string memory) {
        return "v2";
    }
}

/// @dev Version 3 carries version 2's step for a body that skips version 2.
contract LegalBodyV3Mock is LegalBodyV2Mock {
    uint256 public addedThree;

    function migrate(uint256 fromVersion) external override onlyManager reinitializer(3) {
        _stepTwo(fromVersion);
        if (fromVersion < 3) addedThree += 7;
        migrations += 1;
    }

    function versionLabel() external pure override returns (string memory) {
        return "v3";
    }
}

/// @dev A faulty version 2: its migration overwrites the guardian and the delay in the body.
contract LegalBodyFaultyMock is LegalBody, ILegalBodyVersion {
    address public constant WRONG_GUARDIAN = address(0xBAD);
    uint256 public constant WRONG_DELAY = 1 hours;

    function migrate(uint256) external onlyManager reinitializer(2) {
        guardian = WRONG_GUARDIAN;
        amendmentDelay = WRONG_DELAY;
    }
}

/// @dev A version with no `migrate`: it can be published and can never be applied.
contract LegalBodyNoMigrateMock is LegalBody {
    function hello() external pure returns (uint256) {
        return 1;
    }
}

/// @dev A version 2 whose migration always reverts.
contract LegalBodyRevertingMigrateMock is LegalBody, ILegalBodyVersion {
    error MigrationFailed();

    function migrate(uint256) external view onlyManager {
        revert MigrationFailed();
    }
}

/// @dev A version whose migration does not count itself: it has no `reinitializer`.
contract LegalBodyUncountedMigrateMock is LegalBody, ILegalBodyVersion {
    uint256 public migrations;

    function migrate(uint256) external onlyManager {
        migrations += 1;
    }
}

/// @dev A version 2 that hands the body to another manager, as a move to a later factory would.
contract LegalBodyMovesManagerMock is LegalBody, ILegalBodyVersion {
    address public immutable NEW_MANAGER;

    constructor(address newManager_) {
        NEW_MANAGER = newManager_;
    }

    function migrate(uint256) external onlyManager reinitializer(2) {
        manager = NEW_MANAGER;
    }
}

/// @dev A version whose number is chosen at deployment, for tests that publish many versions
///      (fuzz and invariant handlers). Deploy it with the number it will be published under.
///      Every instance has the same layout, so a body can move from one to a later one.
contract LegalBodyNumberedMock is LegalBody, ILegalBodyVersion {
    uint64 public immutable NUMBER;
    uint256 public migrations;
    uint256 public lastFromVersion;

    constructor(uint64 number_) {
        NUMBER = number_;
    }

    function migrate(uint256 fromVersion) external onlyManager reinitializer(NUMBER) {
        migrations += 1;
        lastFromVersion = fromVersion;
    }
}
