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

    /// @notice The Minimal grants paired with their only target. Every selector of
    ///         `minimalGrants()` appears exactly once, pinned to `factory`, so no deploy script or
    ///         test can grant one of them without naming where it may go. They can be passed to
    ///         the controller's constructor as its pin arrays when the factory exists first, and
    ///         they drive the printed admin ceremony otherwise (pins before grants).
    function minimalPins(address factory)
        internal
        pure
        returns (bytes4[] memory selectors, address[] memory targets)
    {
        selectors = minimalGrants();
        targets = new address[](selectors.length);
        for (uint256 i = 0; i < selectors.length; i++) {
            targets[i] = factory;
        }
    }
}
