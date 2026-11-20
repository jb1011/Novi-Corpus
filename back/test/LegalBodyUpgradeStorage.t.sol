// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {LegalBody} from "../src/LegalBody.sol";
import {LegalManager} from "../src/LegalManager.sol";
import {LegalBodyUpgradeTestBase} from "./helpers/LegalBodyUpgradeBase.sol";
import {
    LegalBodyV2Mock,
    LegalBodyV3Mock,
    LegalBodyFaultyMock,
    LegalBodyNumberedMock
} from "./mocks/LegalBodyVersions.sol";

/// @dev Reads a contract's storage layout from its build artifact. Each entry carries the type's
///      readable label rather than the compiler's type id, which embeds an AST id that changes
///      whenever unrelated sources change. Struct members are listed after their struct as
///      `struct.member`, at their absolute slot, so reordering a struct's members is caught too.
abstract contract StorageLayoutReader is Test {
    struct Entry {
        string label;
        uint256 slot;
        uint256 offset;
        string typeLabel;
    }

    string internal constant LEGAL_BODY = "out/LegalBody.sol/LegalBody.json";
    string internal constant LEGAL_MANAGER = "out/LegalManager.sol/LegalManager.json";

    function _versionArtifact(string memory name) internal pure returns (string memory) {
        return string.concat("out/LegalBodyVersions.sol/", name, ".json");
    }

    function _layout(string memory artifact) internal view returns (Entry[] memory entries) {
        string memory json = vm.readFile(artifact);
        entries = new Entry[](128);
        uint256 n;
        for (uint256 i;; ++i) {
            string memory at = string.concat(".storageLayout.storage[", vm.toString(i), "]");
            if (!vm.keyExistsJson(json, at)) break;
            Entry memory e = _entry(json, at, "", 0);
            entries[n++] = e;
            string memory typePath =
                string.concat(".storageLayout.types['", vm.parseJsonString(json, string.concat(at, ".type")), "']");
            for (uint256 j;; ++j) {
                string memory member = string.concat(typePath, ".members[", vm.toString(j), "]");
                if (!vm.keyExistsJson(json, member)) break;
                entries[n++] = _entry(json, member, string.concat(e.label, "."), e.slot);
            }
        }
        assembly {
            mstore(entries, n)
        }
    }

    function _entry(string memory json, string memory at, string memory prefix, uint256 baseSlot)
        private
        pure
        returns (Entry memory e)
    {
        string memory typeId = vm.parseJsonString(json, string.concat(at, ".type"));
        e.label = string.concat(prefix, vm.parseJsonString(json, string.concat(at, ".label")));
        e.slot = baseSlot + vm.parseUint(vm.parseJsonString(json, string.concat(at, ".slot")));
        e.offset = vm.parseJsonUint(json, string.concat(at, ".offset"));
        e.typeLabel = vm.parseJsonString(json, string.concat(".storageLayout.types['", typeId, "'].label"));
    }

    function _assertEntryEq(Entry memory actual, Entry memory expected, string memory context) internal pure {
        assertEq(actual.label, expected.label, string.concat(context, ": label"));
        assertEq(actual.slot, expected.slot, string.concat(context, ": slot of ", expected.label));
        assertEq(actual.offset, expected.offset, string.concat(context, ": offset of ", expected.label));
        assertEq(actual.typeLabel, expected.typeLabel, string.concat(context, ": type of ", expected.label));
    }

    /// @dev Fails unless `newerArtifact`'s layout begins with every entry of `olderArtifact`'s,
    ///      unchanged and in order: a later version may only append storage.
    function _assertExtends(string memory olderArtifact, string memory newerArtifact) internal view {
        Entry[] memory older = _layout(olderArtifact);
        Entry[] memory newer = _layout(newerArtifact);
        assertGt(older.length, 0, string.concat(olderArtifact, " has no storage layout"));
        assertGe(newer.length, older.length, string.concat(newerArtifact, " dropped storage"));
        for (uint256 i; i < older.length; ++i) {
            _assertEntryEq(newer[i], older[i], string.concat(newerArtifact, " entry ", vm.toString(i)));
        }
    }

    string internal constant V1_SNAPSHOT = "test/layout/LegalBody.v1.json";

    /// @dev Version 1's committed layout. Each entry's `type` is already the readable label.
    function _v1Snapshot() internal view returns (Entry[] memory s) {
        string memory json = vm.readFile(V1_SNAPSHOT);
        s = new Entry[](128);
        uint256 n;
        for (uint256 i;; ++i) {
            string memory at = string.concat(".storage[", vm.toString(i), "]");
            if (!vm.keyExistsJson(json, at)) break;
            s[n++] = Entry({
                label: vm.parseJsonString(json, string.concat(at, ".label")),
                slot: vm.parseUint(vm.parseJsonString(json, string.concat(at, ".slot"))),
                offset: vm.parseJsonUint(json, string.concat(at, ".offset")),
                typeLabel: vm.parseJsonString(json, string.concat(at, ".type"))
            });
        }
        assembly {
            mstore(s, n)
        }
    }
}

contract LegalBodyStorageLayoutTest is StorageLayoutReader {
    function test_layout_legalBodyMatchesVersionOneSnapshot() public view {
        Entry[] memory actual = _layout(LEGAL_BODY);
        Entry[] memory expected = _v1Snapshot();
        assertEq(actual.length, expected.length, "number of storage entries");
        for (uint256 i; i < expected.length; ++i) {
            _assertEntryEq(actual[i], expected[i], string.concat("LegalBody entry ", vm.toString(i)));
        }
    }

    function test_layout_legalBodyAddsNoStorageToLegalManager() public view {
        Entry[] memory body = _layout(LEGAL_BODY);
        Entry[] memory manager = _layout(LEGAL_MANAGER);
        assertEq(body.length, manager.length, "number of storage entries");
        for (uint256 i; i < manager.length; ++i) {
            _assertEntryEq(body[i], manager[i], string.concat("LegalBody against LegalManager, entry ", vm.toString(i)));
        }
    }

    function test_layout_v2ExtendsLegalBody() public view {
        _assertExtends(LEGAL_BODY, _versionArtifact("LegalBodyV2Mock"));
    }

    function test_layout_v3ExtendsV2() public view {
        _assertExtends(_versionArtifact("LegalBodyV2Mock"), _versionArtifact("LegalBodyV3Mock"));
    }

    function test_layout_faultyExtendsLegalBody() public view {
        _assertExtends(LEGAL_BODY, _versionArtifact("LegalBodyFaultyMock"));
    }

    function test_layout_noMigrateExtendsLegalBody() public view {
        _assertExtends(LEGAL_BODY, _versionArtifact("LegalBodyNoMigrateMock"));
    }

    function test_layout_revertingMigrateExtendsLegalBody() public view {
        _assertExtends(LEGAL_BODY, _versionArtifact("LegalBodyRevertingMigrateMock"));
    }

    function test_layout_movesManagerExtendsLegalBody() public view {
        _assertExtends(LEGAL_BODY, _versionArtifact("LegalBodyMovesManagerMock"));
    }

    function test_layout_numberedExtendsLegalBody() public view {
        _assertExtends(LEGAL_BODY, _versionArtifact("LegalBodyNumberedMock"));
    }

    /// @dev The check can fail on an entry: V3 is longer than the registry mock's layout but
    ///      does not start with it.
    function test_layout_assertExtendsRefusesALayoutThatDoesNotStartWithTheOlder() public {
        vm.expectRevert(bytes("out/LegalBodyVersions.sol/LegalBodyV3Mock.json entry 0: label: manager != _name"));
        this.assertExtendsExternal(
            "out/MockIdentityRegistry.sol/MockIdentityRegistry.json", _versionArtifact("LegalBodyV3Mock")
        );
    }

    /// @dev The check can fail on length: a later version cannot drop storage.
    function test_layout_assertExtendsRefusesAShorterLayout() public {
        vm.expectRevert(bytes("out/LegalBody.sol/LegalBody.json dropped storage: 13 < 16"));
        this.assertExtendsExternal(_versionArtifact("LegalBodyV3Mock"), LEGAL_BODY);
    }

    /// @dev The snapshot comparison can fail: one entry moved by a slot is caught.
    function test_layout_snapshotComparisonCatchesAMovedEntry() public {
        vm.expectRevert(bytes("LegalBody entry 11: slot of dissolutionInitiator: 10 != 12"));
        this.assertMatchesTamperedSnapshot();
    }

    function assertExtendsExternal(string memory older, string memory newer) external view {
        _assertExtends(older, newer);
    }

    function assertMatchesTamperedSnapshot() external view {
        Entry[] memory actual = _layout(LEGAL_BODY);
        Entry[] memory expected = _v1Snapshot();
        expected[11].slot = 12;
        for (uint256 i; i < expected.length; ++i) {
            _assertEntryEq(actual[i], expected[i], string.concat("LegalBody entry ", vm.toString(i)));
        }
    }
}

contract LegalBodyStoragePreservationTest is LegalBodyUpgradeTestBase {
    bytes32 internal constant PENDING_HASH = keccak256("amendment-pending");
    bytes32 internal constant VETOED_HASH = keccak256("amendment-vetoed");
    string internal constant EIN = "98-7654321";
    uint64 internal constant FORMATION_DATE = 1_690_000_000;
    uint256 internal constant META_SLOT = 4;

    // Slots of the state a migration may write, past LegalManager's twelve.
    uint256 internal constant ADDED_SLOT = 12;
    uint256 internal constant MIGRATIONS_SLOT = 13;
    uint256 internal constant ADDED_THREE_SLOT = 14;

    struct BodyState {
        address manager;
        address guardian;
        uint256 amendmentDelay;
        LegalManager.Status status;
        string ein;
        uint64 formationDate;
        bytes32 operatingAgreementHash;
        uint256 agentId;
        uint256 pendingScheduledAt;
        bool vetoedFlag;
        address dissolutionInitiator;
        uint256 dissolutionExecutableAt;
    }

    struct Protected {
        address guardian;
        uint256 amendmentDelay;
        uint256 agentId;
        LegalManager.Status status;
        bytes32 operatingAgreementHash;
    }

    /// @dev A body with every LegalManager field holding a non-default value: an amendment
    ///      scheduled, another hash vetoed, a dissolution initiated by the guardian.
    function _filledBody() internal returns (address body) {
        body = _create();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig =
            _sign(guardianPk, factory.amendmentDigest(body, PENDING_HASH, factory.amendmentNonce(body), deadline));
        vm.prank(novi);
        factory.scheduleOperatingAgreementUpdate(body, PENDING_HASH, deadline, sig);
        vm.startPrank(guardian);
        LegalManager(payable(body)).cancelOperatingAgreementUpdate(VETOED_HASH);
        LegalManager(payable(body)).initiateDissolution();
        vm.stopPrank();
        // The factory creates every body with an empty EIN and a zero formation date. Written
        // directly so the struct's first two members hold values that a shifted layout would lose.
        vm.store(body, bytes32(META_SLOT), bytes32(bytes(EIN)) | bytes32(bytes(EIN).length * 2));
        vm.store(body, bytes32(META_SLOT + 1), bytes32(uint256(FORMATION_DATE)));
    }

    function _read(address body) internal view returns (BodyState memory s) {
        LegalManager lm = LegalManager(payable(body));
        s.manager = lm.manager();
        s.guardian = lm.guardian();
        s.amendmentDelay = lm.amendmentDelay();
        s.status = lm.status();
        (s.ein, s.formationDate, s.operatingAgreementHash, s.agentId) = lm.meta();
        s.pendingScheduledAt = lm.scheduledAt(PENDING_HASH);
        s.vetoedFlag = lm.vetoed(VETOED_HASH);
        s.dissolutionInitiator = lm.dissolutionInitiator();
        s.dissolutionExecutableAt = lm.dissolutionExecutableAt();
    }

    function _protected(address body) internal view returns (Protected memory p) {
        LegalManager lm = LegalManager(payable(body));
        p.guardian = lm.guardian();
        p.amendmentDelay = lm.amendmentDelay();
        p.status = lm.status();
        (,, p.operatingAgreementHash, p.agentId) = lm.meta();
    }

    /// @dev Which of the fields no migration may touch differ between `a` and `b`, in the order
    ///      guardian, amendment delay, agent id, status, operating-agreement hash.
    function _changed(Protected memory a, Protected memory b) internal pure returns (bool[5] memory c) {
        c[0] = a.guardian != b.guardian;
        c[1] = a.amendmentDelay != b.amendmentDelay;
        c[2] = a.agentId != b.agentId;
        c[3] = a.status != b.status;
        c[4] = a.operatingAgreementHash != b.operatingAgreementHash;
    }

    function _assertNothingChanged(Protected memory before, Protected memory afterwards) internal pure {
        bool[5] memory c = _changed(before, afterwards);
        assertFalse(c[0], "guardian changed");
        assertFalse(c[1], "amendment delay changed");
        assertFalse(c[2], "agent id changed");
        assertFalse(c[3], "status changed");
        assertFalse(c[4], "operating-agreement hash changed");
    }

    /// @dev OpenZeppelin's namespaced slot: keccak256(abi.encode(uint256(keccak256(id)) - 1)) & ~0xff.
    function _namespacedSlot(string memory id) internal pure returns (bytes32) {
        return keccak256(abi.encode(uint256(keccak256(bytes(id))) - 1)) & ~bytes32(uint256(0xff));
    }

    /// @dev Every storage word a body can hold in these tests: LegalManager's twelve slots, the
    ///      mocks' appended slots, the two mapping entries, the initializer and reentrancy
    ///      namespaces and the implementation slot.
    function _rawState(address body) internal view returns (bytes32[] memory words) {
        words = new bytes32[](20);
        for (uint256 i; i <= ADDED_THREE_SLOT; ++i) {
            words[i] = vm.load(body, bytes32(i));
        }
        words[15] = vm.load(body, keccak256(abi.encode(PENDING_HASH, uint256(8))));
        words[16] = vm.load(body, keccak256(abi.encode(VETOED_HASH, uint256(9))));
        words[17] = vm.load(body, _namespacedSlot("openzeppelin.storage.Initializable"));
        words[18] = vm.load(body, _namespacedSlot("openzeppelin.storage.ReentrancyGuard"));
        words[19] = vm.load(body, ERC1967Utils.IMPLEMENTATION_SLOT);
    }

    function _assertWordsEq(bytes32[] memory actual, bytes32[] memory expected, uint256 skip) internal pure {
        assertEq(actual.length, expected.length, "word count");
        for (uint256 i; i < expected.length; ++i) {
            if (i == skip) continue;
            assertEq(actual[i], expected[i], string.concat("word ", vm.toString(i)));
        }
    }

    // ------------------------------------------------------------------
    // Every field survives an upgrade
    // ------------------------------------------------------------------

    function test_upgrade_preservesEveryField() public {
        address body = _filledBody();
        BodyState memory before = _read(body);

        // Every field holds a non-default value, so a field lost or shifted by the upgrade shows.
        assertEq(before.manager, address(factory));
        assertEq(before.guardian, guardian);
        assertEq(before.amendmentDelay, DELAY);
        assertEq(uint8(before.status), uint8(LegalManager.Status.WindingDown));
        assertEq(before.ein, EIN);
        assertEq(before.formationDate, FORMATION_DATE);
        assertEq(before.operatingAgreementHash, OA);
        assertEq(before.agentId, agentId);
        assertEq(before.pendingScheduledAt, block.timestamp + DELAY);
        assertTrue(before.vetoedFlag);
        assertEq(before.dissolutionInitiator, guardian);
        assertEq(before.dissolutionExecutableAt, block.timestamp + DELAY);

        LegalBodyV2Mock v2 = _publishV2();
        _upgrade(body, 2);
        assertEq(_implementationOf(body), address(v2));

        BodyState memory afterwards = _read(body);
        assertEq(afterwards.manager, before.manager, "manager");
        assertEq(afterwards.guardian, before.guardian, "guardian");
        assertEq(afterwards.amendmentDelay, before.amendmentDelay, "amendmentDelay");
        assertEq(uint8(afterwards.status), uint8(before.status), "status");
        assertEq(afterwards.ein, before.ein, "meta.ein");
        assertEq(afterwards.formationDate, before.formationDate, "meta.formationDate");
        assertEq(afterwards.operatingAgreementHash, before.operatingAgreementHash, "meta.operatingAgreementHash");
        assertEq(afterwards.agentId, before.agentId, "meta.agentId");
        assertEq(afterwards.pendingScheduledAt, before.pendingScheduledAt, "scheduledAt");
        assertEq(afterwards.vetoedFlag, before.vetoedFlag, "vetoed");
        assertEq(afterwards.dissolutionInitiator, before.dissolutionInitiator, "dissolutionInitiator");
        assertEq(afterwards.dissolutionExecutableAt, before.dissolutionExecutableAt, "dissolutionExecutableAt");
        // The appended variable starts on a fresh slot, not on top of LegalManager's.
        assertEq(LegalBodyV2Mock(payable(body)).added(), 42);
    }

    // ------------------------------------------------------------------
    // Routes between versions
    // ------------------------------------------------------------------

    function test_route_oneToTwo_writesOnlyTheNewVersionsState() public {
        address body = _filledBody();
        LegalBodyV2Mock v2 = _publishV2();
        bytes32[] memory before = _rawState(body);

        _upgrade(body, 2);
        bytes32[] memory afterwards = _rawState(body);

        bytes32[] memory expected = before;
        expected[ADDED_SLOT] = bytes32(uint256(42));
        expected[MIGRATIONS_SLOT] = bytes32(uint256(1));
        expected[17] = bytes32(uint256(2)); // initialized at version 2
        expected[19] = bytes32(uint256(uint160(address(v2))));
        _assertWordsEq(afterwards, expected, type(uint256).max);
    }

    function test_route_twoToThree_writesOnlyTheNewVersionsState() public {
        address body = _filledBody();
        _publishV2();
        LegalBodyV3Mock v3 = _publishV3();
        _upgrade(body, 2);
        bytes32[] memory before = _rawState(body);

        _upgrade(body, 3);
        bytes32[] memory afterwards = _rawState(body);

        bytes32[] memory expected = before;
        expected[MIGRATIONS_SLOT] = bytes32(uint256(2));
        expected[ADDED_THREE_SLOT] = bytes32(uint256(7));
        expected[17] = bytes32(uint256(3));
        expected[19] = bytes32(uint256(uint160(address(v3))));
        _assertWordsEq(afterwards, expected, type(uint256).max);
        // Version 2's step did not run again for a body that already took it.
        assertEq(LegalBodyV3Mock(payable(body)).added(), 42);
    }

    function test_route_oneToThreeDirect_equalsOneToTwoToThree() public {
        address body = _filledBody();
        _publishV2();
        _publishV3();
        uint256 snapshot = vm.snapshotState();

        _upgrade(body, 3);
        bytes32[] memory direct = _rawState(body);
        assertEq(LegalBodyV3Mock(payable(body)).migrations(), 1);

        vm.revertToState(snapshot);
        _upgrade(body, 2);
        _upgrade(body, 3);
        bytes32[] memory stepwise = _rawState(body);
        assertEq(LegalBodyV3Mock(payable(body)).migrations(), 2);

        // The migration counter records how many steps ran, so it is the one word that may differ.
        _assertWordsEq(stepwise, direct, MIGRATIONS_SLOT);
        assertEq(direct[ADDED_SLOT], bytes32(uint256(42)));
        assertEq(direct[ADDED_THREE_SLOT], bytes32(uint256(7)));
    }

    // ------------------------------------------------------------------
    // A migration leaves the protected fields alone
    // ------------------------------------------------------------------

    function test_migration_v2KeepsProtectedFields() public {
        address body = _filledBody();
        _publishV2();
        Protected memory before = _protected(body);
        _upgrade(body, 2);
        _assertNothingChanged(before, _protected(body));
    }

    function test_migration_v3KeepsProtectedFields() public {
        address body = _filledBody();
        _publishV2();
        _publishV3();
        Protected memory before = _protected(body);
        _upgrade(body, 3);
        _assertNothingChanged(before, _protected(body));
    }

    function test_migration_numberedKeepsProtectedFields() public {
        address body = _filledBody();
        _publish(address(new LegalBodyNumberedMock(2)));
        Protected memory before = _protected(body);
        _upgrade(body, 2);
        _assertNothingChanged(before, _protected(body));
        assertEq(LegalBodyNumberedMock(payable(body)).migrations(), 1);
    }

    function test_migration_comparisonCatchesTheFaultyVersion() public {
        address body = _filledBody();
        LegalBodyFaultyMock faulty = new LegalBodyFaultyMock();
        _publish(address(faulty));
        Protected memory before = _protected(body);
        _upgrade(body, 2);
        Protected memory afterwards = _protected(body);

        bool[5] memory c = _changed(before, afterwards);
        assertTrue(c[0], "guardian change not caught");
        assertTrue(c[1], "amendment delay change not caught");
        assertFalse(c[2], "agent id");
        assertFalse(c[3], "status");
        assertFalse(c[4], "operating-agreement hash");
        assertEq(afterwards.guardian, faulty.WRONG_GUARDIAN());
        assertEq(afterwards.amendmentDelay, faulty.WRONG_DELAY());
    }
}
