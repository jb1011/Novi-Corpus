// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgentTreasury} from "../AgentTreasury.sol";
import {LegalManager} from "../LegalManager.sol";
import {LegalManagerFactory} from "../LegalManagerFactory.sol";
import {IIdentityRegistry} from "../interfaces/IIdentityRegistry.sol";
import {LegalBodyFactory} from "../LegalBodyFactory.sol";

/// @title ControllerSelectors
/// @notice THE definition of the NoviController executor's standing grant set (design §3).
/// @dev    One source imported by the deploy script AND both test suites: a selector added in one
///         place and not another would mean the tests pass against a grant set that is not what
///         mainnet deploys — the exact drift the design's test plan exists to prevent. Computed
///         from the ABIs, never hardcoded hex, so a signature change moves everything together.
library ControllerSelectors {
    function granted() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](7);
        s[0] = AgentTreasury.schedulePolicyUpdate.selector;
        s[1] = AgentTreasury.executePolicyUpdate.selector;
        s[2] = LegalManager.scheduleOperatingAgreementUpdate.selector;
        s[3] = LegalManager.executeOperatingAgreementUpdate.selector;
        s[4] = LegalManagerFactory.createEntity.selector;
        s[5] = IIdentityRegistry.setAgentWallet.selector;
        s[6] = IIdentityRegistry.setMetadata.selector;
    }

    /// @notice The executor's grants for legal bodies whose identities the customer owns. Both
    ///         must be pinned to the LegalBodyFactory BEFORE they are granted, so there is never
    ///         a moment where they are relayable to another target: use {minimalPins}, which
    ///         pairs each selector with its target, rather than these bare selectors. They are
    ///         not part of `granted()`, which is the controller's constructor set for the full
    ///         product.
    function minimalGrants() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](2);
        s[0] = LegalBodyFactory.createLegalBody.selector;
        s[1] = LegalBodyFactory.scheduleOperatingAgreementUpdate.selector;
    }

    /// @notice The factory's release selectors: publishing and withdrawing a version of the legal
    ///         body's code. They are pinned to the LegalBodyFactory like the Minimal grants and
    ///         granted to no one. The executor never holds them: a release is a one-off ceremony
    ///         of the role administrator, who grants the selector to a single-use helper for one
    ///         call.
    function minimalReleaseSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](2);
        s[0] = LegalBodyFactory.publishVersion.selector;
        s[1] = LegalBodyFactory.withdrawVersion.selector;
    }

    /// @notice Every Minimal selector the controller pins, paired with its only target: the
    ///         selectors of `minimalGrants()` first, then those of `minimalReleaseSelectors()`,
    ///         each exactly once and each pinned to `factory`. No deploy script or test can grant
    ///         one of them without naming where it may go. They can be passed to the controller's
    ///         constructor as its pin arrays when the factory exists first.
    /// @dev    These are the PINS, not the grants: only `minimalGrants()` is ever granted to the
    ///         executor.
    function minimalPins(address factory) internal pure returns (bytes4[] memory selectors, address[] memory targets) {
        bytes4[] memory grants = minimalGrants();
        bytes4[] memory release = minimalReleaseSelectors();
        selectors = new bytes4[](grants.length + release.length);
        targets = new address[](selectors.length);
        for (uint256 i = 0; i < grants.length; i++) {
            selectors[i] = grants[i];
        }
        for (uint256 i = 0; i < release.length; i++) {
            selectors[grants.length + i] = release[i];
        }
        for (uint256 i = 0; i < selectors.length; i++) {
            targets[i] = factory;
        }
    }
}
