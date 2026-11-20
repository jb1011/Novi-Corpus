// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ILegalBodyVersion
/// @notice What every version of the legal body's code after the first must implement.
interface ILegalBodyVersion {
    /// @notice The one-time step that brings a body's storage to this version. The factory
    ///         calls it inside the upgrade itself, so the two are one atomic step.
    /// @dev    Implement it as `onlyManager reinitializer(N)`, N being the number the factory
    ///         lists this version under, even when there is nothing to set. The factory checks
    ///         the body's initialisation counter after the upgrade and refuses any other
    ///         number. Versions can be skipped, so the step is cumulative: run every earlier
    ///         version's step that `fromVersion` has not had.
    /// @param fromVersion the version the body is leaving
    function migrate(uint256 fromVersion) external;
}
