// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {LegalBody} from "../src/LegalBody.sol";
import {LegalBodyFactory} from "../src/LegalBodyFactory.sol";
import {LegalManager} from "../src/LegalManager.sol";
import {LegalBodyUpgradeTestBase} from "./helpers/LegalBodyUpgradeBase.sol";
import {LegalBodyNumberedMock} from "./mocks/LegalBodyVersions.sol";

/// @dev Drives random sequences of every upgrade, amendment and dissolution action over several
///      bodies with different guardians and delays. Inputs are bounded so most calls succeed;
///      reverts are swallowed so the engine keeps exploring. Every action records, for each
///      existing body, whether its implementation slot moved outside an execute and whether its
///      version went down.
contract UpgradeHandler is Test {
    LegalBodyFactory public factory;
    address public novi;
    address public stranger;
    uint256 public ownerPk;
    uint256 public agentId;

    uint256 internal constant MAX_BODIES = 6;
    uint256 internal constant MAX_VERSIONS = 16;

    uint256[] internal guardianPks;
    address[] public bodies;

    // What each body was created with, to compare against for life.
    mapping(address => address) public guardianOf;
    mapping(address => uint256) public delayOf;

    // ghost state
    mapping(address => uint256) public lastVersion;
    mapping(uint256 => bool) public withdrawn;
    bool public implementationMovedOutsideExecute;
    bool public versionDecreased;
    bool public movedToWithdrawnVersion;
    bool public executeLandedElsewhere;

    // successful calls per action
    uint256 public createOk;
    uint256 public publishOk;
    uint256 public withdrawOk;
    uint256 public scheduleOk;
    uint256 public cancelDirectOk;
    uint256 public cancelBySigOk;
    uint256 public executeOk;
    uint256 public warpOk;
    uint256 public scheduleAmendmentOk;
    uint256 public executeAmendmentOk;
    uint256 public initiateDissolutionOk;
    uint256 public cancelDissolutionOk;
    uint256 public finalizeDissolutionOk;

    constructor(
        LegalBodyFactory factory_,
        address novi_,
        address stranger_,
        uint256 ownerPk_,
        uint256 agentId_,
        uint256[] memory guardianPks_
    ) {
        factory = factory_;
        novi = novi_;
        stranger = stranger_;
        ownerPk = ownerPk_;
        agentId = agentId_;
        guardianPks = guardianPks_;
    }

    /// @dev Snapshots every existing body before the action; afterwards flags an implementation
    ///      slot that moved on a body other than `mayMove`, and a version that went down.
    modifier tracked(address mayMove) {
        uint256 n = bodies.length;
        address[] memory implBefore = new address[](n);
        uint256[] memory versionBefore = new uint256[](n);
        for (uint256 i; i < n; i++) {
            implBefore[i] = implementationOf(bodies[i]);
            versionBefore[i] = factory.versionOf(bodies[i]);
        }
        _;
        for (uint256 i; i < n; i++) {
            address b = bodies[i];
            if (b != mayMove && implementationOf(b) != implBefore[i]) implementationMovedOutsideExecute = true;
            uint256 v = factory.versionOf(b);
            if (v < versionBefore[i] || v < lastVersion[b]) versionDecreased = true;
            lastVersion[b] = v;
        }
    }

    function bodyCount() external view returns (uint256) {
        return bodies.length;
    }

    function implementationOf(address b) public view returns (address) {
        return address(uint160(uint256(vm.load(b, ERC1967Utils.IMPLEMENTATION_SLOT))));
    }

    function _body(uint256 seed) internal view returns (address) {
        return bodies[seed % bodies.length];
    }

    function _guardianPk(address b) internal view returns (uint256 pk) {
        for (uint256 i; i < guardianPks.length; i++) {
            if (vm.addr(guardianPks[i]) == guardianOf[b]) return guardianPks[i];
        }
        revert("unknown guardian");
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    // ------------------------------------------------------------------
    // Actions
    // ------------------------------------------------------------------

    /// Creates a body for one of the guardians with a delay in the factory's range. Also called
    /// from setUp, which is how the run starts with three bodies.
    function create(uint256 guardianSeed, uint256 delaySeed) public tracked(address(0)) {
        if (bodies.length >= MAX_BODIES) return;
        address g = vm.addr(guardianPks[guardianSeed % guardianPks.length]);
        uint256 delay = bound(delaySeed, factory.MIN_AMENDMENT_DELAY(), factory.MAX_AMENDMENT_DELAY());
        bytes32 oa = keccak256(abi.encode("oa", bodies.length));
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(ownerPk, factory.linkDigest(agentId, g, delay, oa, deadline));
        vm.prank(novi);
        try factory.createLegalBody(agentId, g, delay, oa, deadline, sig) returns (address b) {
            bodies.push(b);
            guardianOf[b] = g;
            delayOf[b] = delay;
            lastVersion[b] = factory.versionOf(b);
            createOk++;
        } catch {}
    }

    /// Publishes a numbered version under the number it will get.
    function publish() public tracked(address(0)) {
        uint256 next = factory.versionCount() + 1;
        if (next > MAX_VERSIONS) return;
        // forge-lint: disable-next-line(unsafe-typecast)
        LegalBodyNumberedMock v = new LegalBodyNumberedMock(uint64(next));
        vm.prank(novi);
        try factory.publishVersion(address(v)) {
            publishOk++;
        } catch {}
    }

    /// Withdraws the first live version at or after the seed's pick. Never withdraws the last
    /// live later version, so scheduling stays possible for most of a run.
    function withdraw(uint256 seed) external tracked(address(0)) {
        uint256 count = factory.versionCount();
        if (count < 3) return;
        uint256 live;
        for (uint256 v = 2; v <= count; v++) {
            if (!withdrawn[v]) live++;
        }
        if (live < 2) return;
        uint256 start = 2 + seed % (count - 1);
        for (uint256 k; k < count - 1; k++) {
            uint256 v = 2 + (start - 2 + k) % (count - 1);
            if (withdrawn[v]) continue;
            vm.prank(novi);
            try factory.withdrawVersion(v) {
                withdrawn[v] = true;
                withdrawOk++;
            } catch {}
            return;
        }
    }

    /// The body's guardian signs an upgrade to a live version later than the body's; a stranger
    /// sends it.
    function schedule(uint256 bodySeed, uint256 versionSeed) external tracked(address(0)) {
        address b = _body(bodySeed);
        uint256 count = factory.versionCount();
        uint256 current = factory.versionOf(b);
        if (current >= count) return;
        uint256 span = count - current;
        uint256 version;
        uint256 first = versionSeed % span;
        for (uint256 k; k < span; k++) {
            uint256 v = current + 1 + (first + k) % span;
            if (!withdrawn[v]) {
                version = v;
                break;
            }
        }
        if (version == 0) return;
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(
            _guardianPk(b),
            factory.upgradeDigest(
                b, version, factory.versionInfo(version).implementation, factory.upgradeNonce(b), deadline
            )
        );
        vm.prank(stranger);
        try factory.scheduleLegalBodyUpgrade(b, version, deadline, sig) {
            scheduleOk++;
        } catch {}
    }

    function cancelDirect(uint256 bodySeed) external tracked(address(0)) {
        address b = _body(bodySeed);
        vm.prank(guardianOf[b]);
        try factory.cancelLegalBodyUpgrade(b) {
            cancelDirectOk++;
        } catch {}
    }

    function cancelBySig(uint256 bodySeed) external tracked(address(0)) {
        address b = _body(bodySeed);
        (uint64 version,) = factory.pendingUpgrade(b);
        if (version == 0) return;
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig =
            _sign(_guardianPk(b), factory.upgradeCancelDigest(b, version, factory.upgradeNonce(b), deadline));
        vm.prank(stranger);
        try factory.cancelLegalBodyUpgradeBySig(b, deadline, sig) {
            cancelBySigOk++;
        } catch {}
    }

    /// Waits until a point in or just past the execution window (never back in time), then has
    /// `caller` execute.
    function execute(uint256 bodySeed, uint256 waitSeed, address caller) external tracked(_body(bodySeed)) {
        address b = _body(bodySeed);
        (uint64 version, uint64 executableAt) = factory.pendingUpgrade(b);
        if (version != 0) {
            uint256 target = uint256(executableAt) + bound(waitSeed, 0, factory.UPGRADE_EXECUTION_WINDOW() + 2 days);
            if (target > block.timestamp) vm.warp(target);
        }
        bool wasWithdrawn = withdrawn[version];
        vm.prank(caller);
        try factory.executeLegalBodyUpgrade(b) {
            executeOk++;
            if (wasWithdrawn) movedToWithdrawnVersion = true;
            if (factory.versionOf(b) != version) executeLandedElsewhere = true;
            if (implementationOf(b) != factory.versionInfo(version).implementation) executeLandedElsewhere = true;
        } catch {}
    }

    function warp(uint256 dt) external tracked(address(0)) {
        vm.warp(block.timestamp + bound(dt, 0, 10 days));
        warpOk++;
    }

    function scheduleAmendment(uint256 bodySeed, uint256 hashSeed) external tracked(address(0)) {
        address b = _body(bodySeed);
        bytes32 newHash = keccak256(abi.encode("amendment", hashSeed));
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig =
            _sign(_guardianPk(b), factory.amendmentDigest(b, newHash, factory.amendmentNonce(b), deadline));
        vm.prank(novi);
        try factory.scheduleOperatingAgreementUpdate(b, newHash, deadline, sig) {
            scheduleAmendmentOk++;
        } catch {}
    }

    /// Waits out the pending amendment's delay if needed, then has a stranger execute it.
    function executeAmendment(uint256 bodySeed) external tracked(address(0)) {
        address b = _body(bodySeed);
        bytes32 newHash = factory.pendingAmendment(b);
        if (newHash == bytes32(0)) return;
        uint256 at = LegalManager(payable(b)).scheduledAt(newHash);
        if (at > block.timestamp) vm.warp(at);
        vm.prank(stranger);
        try factory.executeOperatingAgreementUpdate(b, newHash) {
            executeAmendmentOk++;
        } catch {}
    }

    function initiateDissolution(uint256 bodySeed) external tracked(address(0)) {
        address b = _body(bodySeed);
        vm.prank(guardianOf[b]);
        try LegalManager(payable(b)).initiateDissolution() {
            initiateDissolutionOk++;
        } catch {}
    }

    function cancelDissolution(uint256 bodySeed) external tracked(address(0)) {
        address b = _body(bodySeed);
        vm.prank(guardianOf[b]);
        try LegalManager(payable(b)).cancelDissolution() {
            cancelDissolutionOk++;
        } catch {}
    }

    /// Waits out the dissolution delay if needed, then finalizes as the guardian.
    function finalizeDissolution(uint256 bodySeed) external tracked(address(0)) {
        address b = _body(bodySeed);
        LegalManager lm = LegalManager(payable(b));
        if (lm.status() != LegalManager.Status.WindingDown) return;
        uint256 at = lm.dissolutionExecutableAt();
        if (at > block.timestamp) vm.warp(at);
        vm.prank(guardianOf[b]);
        try lm.finalizeDissolution() {
            finalizeDissolutionOk++;
        } catch {}
    }
}

/// @dev A run is capped at 100 calls. The handler stops creating bodies at six and publishing at
///      sixteen versions, so a longer run mostly repeats calls that can no longer change anything.
/// forge-config: default.invariant.depth = 100
contract LegalBodyUpgradeInvariantTest is LegalBodyUpgradeTestBase {
    UpgradeHandler internal handler;

    /// @dev OpenZeppelin's `Initializable` storage location, computed the way its ERC-7201
    ///      annotation defines it.
    bytes32 internal constant INITIALIZABLE_SLOT =
        keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.Initializable")) - 1)) & ~bytes32(uint256(0xff));

    function setUp() public override {
        super.setUp();
        uint256[] memory pks = new uint256[](3);
        pks[0] = guardianPk;
        pks[1] = 0xB0B2;
        pks[2] = 0xB0B3;
        handler = new UpgradeHandler(factory, novi, stranger, ownerPk, agentId, pks);

        // Three bodies, one per guardian, each with its own delay.
        handler.create(0, DELAY);
        handler.create(1, 3 days);
        handler.create(2, 7 days);
        assertEq(handler.bodyCount(), 3);
        // Two later versions, so scheduling can succeed from the first call.
        handler.publish();
        handler.publish();
        assertEq(factory.versionCount(), 3);
        // The slot is right: a fresh body reports version 1 there.
        assertEq(_initializedOf(handler.bodies(0)), 1);

        bytes4[] memory selectors = new bytes4[](13);
        selectors[0] = UpgradeHandler.create.selector;
        selectors[1] = UpgradeHandler.publish.selector;
        selectors[2] = UpgradeHandler.withdraw.selector;
        selectors[3] = UpgradeHandler.schedule.selector;
        selectors[4] = UpgradeHandler.cancelDirect.selector;
        selectors[5] = UpgradeHandler.cancelBySig.selector;
        selectors[6] = UpgradeHandler.execute.selector;
        selectors[7] = UpgradeHandler.warp.selector;
        selectors[8] = UpgradeHandler.scheduleAmendment.selector;
        selectors[9] = UpgradeHandler.executeAmendment.selector;
        selectors[10] = UpgradeHandler.initiateDissolution.selector;
        selectors[11] = UpgradeHandler.cancelDissolution.selector;
        selectors[12] = UpgradeHandler.finalizeDissolution.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function _initializedOf(address b) internal view returns (uint64) {
        return uint64(uint256(vm.load(b, INITIALIZABLE_SLOT)));
    }

    /// A body's implementation slot always holds the implementation of the version the factory
    /// records for it.
    function invariant_implementationSlotMatchesVersion() public view {
        for (uint256 i; i < handler.bodyCount(); i++) {
            address b = handler.bodies(i);
            assertEq(_implementationOf(b), factory.versionInfo(factory.versionOf(b)).implementation);
        }
    }

    /// A body's version never goes down.
    function invariant_versionNeverDecreases() public view {
        assertFalse(handler.versionDecreased());
        for (uint256 i; i < handler.bodyCount(); i++) {
            address b = handler.bodies(i);
            assertGe(factory.versionOf(b), handler.lastVersion(b));
        }
    }

    /// Only an execute moves a body's code, and only the body it names, to the version pending.
    function invariant_implementationMovesOnlyOnExecute() public view {
        assertFalse(handler.implementationMovedOutsideExecute());
        assertFalse(handler.executeLandedElsewhere());
    }

    /// The factory stays every body's manager; the body's guardian, delay and agent id, and the
    /// factory's record of the guardian and delay, never change.
    function invariant_bodyConfigNeverChanges() public view {
        for (uint256 i; i < handler.bodyCount(); i++) {
            address b = handler.bodies(i);
            LegalManager lm = LegalManager(payable(b));
            assertEq(lm.manager(), address(factory));
            assertEq(lm.guardian(), handler.guardianOf(b));
            assertEq(lm.amendmentDelay(), handler.delayOf(b));
            (,,, uint256 id) = lm.meta();
            assertEq(id, agentId);
            (address recordedGuardian, uint64 recordedDelay,) = factory.bodyRecord(b);
            assertEq(recordedGuardian, handler.guardianOf(b));
            assertEq(recordedDelay, handler.delayOf(b));
        }
    }

    /// No execute ever moves a body to a version that was withdrawn before it.
    function invariant_neverMovesToWithdrawnVersion() public view {
        assertFalse(handler.movedToWithdrawnVersion());
    }

    /// A pending upgrade names a listed version later than the body's.
    function invariant_pendingUpgradeIsListedAndNewer() public view {
        for (uint256 i; i < handler.bodyCount(); i++) {
            address b = handler.bodies(i);
            uint256 pending = _pendingVersion(b);
            if (pending != 0) {
                assertLe(pending, factory.versionCount());
                assertGt(pending, factory.versionOf(b));
            }
        }
    }

    /// The body's initialisation counter equals its version: every migration ran exactly once,
    /// under the number its version was published with. Read both from the storage slot and
    /// through the body's own getter, which is what the factory checks.
    function invariant_initializedEqualsVersion() public view {
        for (uint256 i; i < handler.bodyCount(); i++) {
            address b = handler.bodies(i);
            assertEq(_initializedOf(b), factory.versionOf(b));
            assertEq(LegalBody(payable(b)).initializedVersion(), factory.versionOf(b));
        }
    }
}
