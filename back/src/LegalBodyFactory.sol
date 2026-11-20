// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC1822Proxiable} from "@openzeppelin/contracts/interfaces/draft-IERC1822.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {LegalBody} from "./LegalBody.sol";
import {LegalManager} from "./LegalManager.sol";
import {ILegalBodyVersion} from "./interfaces/ILegalBodyVersion.sol";
import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";

/// @title LegalBodyFactory
/// @notice Creates a legal body for an ERC-8004 identity that its customer owns and keeps.
///         Each body is an ERC-1967 proxy of the LegalBody logic contract, with no treasury.
///         It keeps one address for life. The identity owner authorises the creation with an
///         EIP-712 `LegalBodyLink`, and later writes a pointer to the body in their own
///         identity's metadata. This contract never holds, moves or is approved for any
///         identity.
/// @dev    This factory is the `manager` of every body it creates, on purpose. LegalManager
///         gives its manager the right to initiate or cancel a dissolution and to sweep assets.
///         This contract exposes none of those. It has two powers over a body and no other: to
///         schedule an operating-agreement amendment the body's guardian has signed, and to
///         carry out an upgrade of the body's code the body's guardian has signed. So no key
///         held by the platform (the owner of this factory, or any key granted roles on it)
///         can amend, dissolve, sweep or upgrade a body on its own. Only the guardian can
///         dissolve.
///         Bodies are deterministic proxies salted by the link digest: one signature can
///         create at most one body. Several bodies may exist for one identity over time. The
///         live one is the body the identity owner's pointer names (see `linkedLegalBody`).
///         Only the amendment scheduled last may execute, and only once: a new schedule
///         supersedes any older pending one. The body itself never forgets a scheduled hash,
///         so without this rule anyone could execute a superseded amendment later and roll the
///         anchored agreement back.
///         Upgrades take two keys. The owner publishes a version of the body's code, which
///         changes no body. A body moves to a published version only when its guardian signs
///         for that body and that version, the body's own delay has passed without the
///         guardian cancelling, and the version has not been withdrawn. The owner cannot move
///         a body without its guardian, and a guardian cannot move a body to code the owner
///         did not publish. Every body is created on version 1, the `implementation` this
///         factory was deployed with, and may stay on it for life.
contract LegalBodyFactory is Ownable2Step, EIP712 {
    bytes32 public constant LINK_TYPEHASH = keccak256(
        "LegalBodyLink(uint256 agentId,address guardian,uint256 amendmentDelay,bytes32 operatingAgreementHash,uint256 deadline)"
    );

    bytes32 public constant AMENDMENT_TYPEHASH =
        keccak256("OperatingAgreementUpdate(address legalBody,bytes32 newHash,uint256 nonce,uint256 deadline)");

    bytes32 public constant UPGRADE_TYPEHASH = keccak256(
        "LegalBodyUpgrade(address legalBody,uint256 version,address implementation,uint256 nonce,uint256 deadline)"
    );

    bytes32 public constant UPGRADE_CANCEL_TYPEHASH =
        keccak256("LegalBodyUpgradeCancel(address legalBody,uint256 version,uint256 nonce,uint256 deadline)");

    /// @notice Amendments and dissolutions wait at least this long, so the guardian always has
    ///         two days to react.
    uint256 public constant MIN_AMENDMENT_DELAY = 48 hours;
    /// @notice Upper bound: a very large delay would overflow the dissolution timestamp inside
    ///         LegalManager and leave the guardian unable to ever dissolve.
    uint256 public constant MAX_AMENDMENT_DELAY = 30 days;
    /// @notice A signature may be used at most this long before its deadline.
    uint256 public constant MAX_SIGNATURE_WINDOW = 24 hours;
    /// @notice A scheduled upgrade may be executed for this long once its delay has passed.
    ///         After that it lapses and the guardian must sign again.
    uint256 public constant UPGRADE_EXECUTION_WINDOW = 30 days;

    /// @notice The identity-metadata key the owner writes the pointer under.
    string public constant POINTER_KEY = "legalBody";
    uint8 public constant POINTER_VERSION = 1;
    uint256 private constant POINTER_LENGTH = 96;

    /// @notice One published version of the body's code. Ordered to take two storage slots.
    struct Version {
        address implementation;
        uint64 publishedAt;
        bool withdrawn;
        bytes32 codehash; // the implementation's code hash when it was published
    }

    /// @notice What this factory itself remembers about a body, in one storage slot. The
    ///         guardian and the delay are written at creation and never change. The upgrade
    ///         rules read this record and never the body, so no version of the body's code,
    ///         faulty or not, can change who approves its next upgrade or how long it waits.
    struct BodyRecord {
        address guardian;
        uint64 delay;
        uint32 version; // the version the body runs
    }

    struct PendingUpgrade {
        uint64 version;
        uint64 executableAt;
    }

    /// @notice Version 1 of the body's code: the logic contract every body is created on.
    address public immutable implementation;
    IIdentityRegistry public immutable identityRegistry;
    /// @notice The hash of a body's creation code, the same for every body of this factory.
    ///         With the link digest as salt it gives the body's address.
    bytes32 public immutable proxyInitCodeHash;

    /// @notice body => the identity owner who signed its LegalBodyLink. Non-zero means this
    ///         factory created the body.
    mapping(address => address) public identityOwnerAtCreation;

    /// @notice body => the nonce the guardian's next amendment signature must carry.
    mapping(address => uint256) public amendmentNonce;

    /// @notice body => the only amendment that may execute: the one scheduled last. A new
    ///         schedule supersedes any older pending one, and executing it clears this slot.
    mapping(address => bytes32) public pendingAmendment;

    /// @dev Version n is `_versions[n - 1]`. Version 1 is `implementation`.
    Version[] private _versions;

    /// @notice implementation => its version number, or 0 when it was never published.
    mapping(address => uint256) public versionOfImplementation;

    /// @notice body => this factory's own record of it.
    mapping(address => BodyRecord) public bodyRecord;

    /// @notice body => the nonce its guardian's next upgrade or cancel signature must carry.
    mapping(address => uint256) public upgradeNonce;

    /// @notice body => the only upgrade that may execute: the one scheduled last. A new
    ///         schedule supersedes it; executing or cancelling it clears this slot.
    /// @dev    An upgrade whose execution window has passed, or whose version was withdrawn,
    ///         stays here with no event until a new schedule or a cancel. To know whether it
    ///         can still execute, a reader also checks `executableAt + UPGRADE_EXECUTION_WINDOW`
    ///         and `versionInfo(version).withdrawn`.
    mapping(address => PendingUpgrade) public pendingUpgrade;

    event LegalBodyCreated(
        uint256 indexed agentId,
        address indexed legalBody,
        address indexed identityOwner,
        address guardian,
        bytes32 linkDigest
    );
    event LegalBodyUpgradeCancelled(address indexed legalBody, uint256 indexed version);
    event LegalBodyUpgradeScheduled(
        address indexed legalBody, uint256 indexed version, address indexed implementation, uint256 executableAt
    );
    event LegalBodyUpgraded(address indexed legalBody, uint256 indexed version, address indexed implementation);
    event VersionPublished(uint256 indexed version, address indexed implementation, bytes32 codehash);
    event VersionWithdrawn(uint256 indexed version, address indexed implementation);

    error BadDeadline();
    error BadDelay();
    error BadGuardian();
    error BadSignature();
    error FirstVersionCannotBeWithdrawn();
    error LegalBodyExists(address legalBody);
    error MigrationNumberMismatch(uint256 version, uint256 initialized);
    error NoPendingUpgrade();
    error NotContract(address account);
    error NotGuardian();
    error NotImplementation(address account);
    error NotLegalBody(address account);
    error NotNewerVersion(uint256 version);
    error NotPendingAmendment(bytes32 newHash);
    error OwnershipRenounceDisabled();
    error UnknownVersion(uint256 version);
    error UpgradeExpired();
    error UpgradeTooEarly();
    error VersionCodeChanged(uint256 version);
    error VersionExists(address implementation);
    error VersionIsWithdrawn(uint256 version);

    /// @param implementation_   the deployed, locked LegalBody logic contract every body is
    ///                          created on; it becomes version 1
    /// @param identityRegistry_ the ERC-8004 identity registry
    /// @param owner_            the platform controller; the only caller of the owner functions
    constructor(address implementation_, address identityRegistry_, address owner_)
        Ownable(owner_)
        EIP712("Novi LegalBodyFactory", "1")
    {
        if (implementation_.code.length == 0) revert NotContract(implementation_);
        if (identityRegistry_.code.length == 0) revert NotContract(identityRegistry_);
        _requireLockedImplementation(implementation_);
        implementation = implementation_;
        identityRegistry = IIdentityRegistry(identityRegistry_);
        // Empty init data, so the creation code is the same for every body and the address
        // depends on this factory, the link digest and version 1 only.
        proxyInitCodeHash =
            keccak256(abi.encodePacked(type(ERC1967Proxy).creationCode, abi.encode(implementation_, bytes(""))));
        _addVersion(implementation_);
    }

    // ------------------------------------------------------------------
    // Creation
    // ------------------------------------------------------------------

    /// @notice Create a legal body for `agentId`, authorised by its current owner's signature.
    /// @dev    The owner is read from the registry, never passed in, so a link signed before an
    ///         identity transfer stops working after it. The body is a deterministic proxy
    ///         salted by the link digest; the collision check before creating it turns a
    ///         replay into a cheap, explicit revert instead of a CREATE2 failure that burns the
    ///         gas. The proxy is created with no init data and initialised in the next line, in
    ///         the same transaction. It always starts on version 1, whatever was published
    ///         since: from its first block a body's code changes only with its guardian's
    ///         signature.
    function createLegalBody(
        uint256 agentId,
        address guardian,
        uint256 amendmentDelay,
        bytes32 operatingAgreementHash,
        uint256 deadline,
        bytes calldata signature
    ) external onlyOwner returns (address legalBody) {
        _checkDeadline(deadline);
        if (amendmentDelay < MIN_AMENDMENT_DELAY || amendmentDelay > MAX_AMENDMENT_DELAY) revert BadDelay();
        // A guardian that is the caller or this factory could never veto or dissolve.
        if (guardian == address(0) || guardian == msg.sender || guardian == address(this)) revert BadGuardian();

        address identityOwner = identityRegistry.ownerOf(agentId);
        bytes32 digest = linkDigest(agentId, guardian, amendmentDelay, operatingAgreementHash, deadline);
        if (!_isValidSignature(identityOwner, digest, signature)) revert BadSignature();

        address predicted = predictLegalBody(digest);
        if (predicted.code.length != 0) revert LegalBodyExists(predicted);

        legalBody = address(new ERC1967Proxy{salt: digest}(implementation, ""));
        LegalManager(payable(legalBody))
            .initialize(address(this), guardian, amendmentDelay, agentId, "", 0, operatingAgreementHash);
        identityOwnerAtCreation[legalBody] = identityOwner;
        // Safe: the delay was bounded to MAX_AMENDMENT_DELAY (30 days) above.
        // forge-lint: disable-next-line(unsafe-typecast)
        bodyRecord[legalBody] = BodyRecord({guardian: guardian, delay: uint64(amendmentDelay), version: 1});
        emit LegalBodyCreated(agentId, legalBody, identityOwner, guardian, digest);
    }

    // ------------------------------------------------------------------
    // Amendments: guardian-signed, platform-recorded, guardian-vetoable
    // ------------------------------------------------------------------

    /// @notice Schedule an operating-agreement amendment the body's guardian signed.
    /// @dev    Both parties are needed. The platform alone cannot amend (it needs the
    ///         guardian's signature), and the guardian alone cannot either (only the owner
    ///         schedules), so the anchored agreement changes only when both agree. The body
    ///         still enforces its delay, and the guardian can still veto during it. This hash
    ///         becomes the body's only pending amendment and supersedes any older one, which
    ///         can then never execute.
    function scheduleOperatingAgreementUpdate(
        address legalBody,
        bytes32 newHash,
        uint256 deadline,
        bytes calldata guardianSignature
    ) external onlyOwner {
        if (!isLegalBody(legalBody)) revert NotLegalBody(legalBody);
        _checkDeadline(deadline);
        uint256 nonce = amendmentNonce[legalBody];
        address guardian = LegalManager(payable(legalBody)).guardian();
        bytes32 digest = amendmentDigest(legalBody, newHash, nonce, deadline);
        if (!_isValidSignature(guardian, digest, guardianSignature)) revert BadSignature();
        amendmentNonce[legalBody] = nonce + 1;
        pendingAmendment[legalBody] = newHash;
        LegalManager(payable(legalBody)).scheduleOperatingAgreementUpdate(newHash);
    }

    /// @notice Execute the pending amendment once its delay has passed. Callable by anyone:
    ///         the body only executes a hash that was scheduled, not vetoed, and has waited out
    ///         the delay, so nobody can hold back a guardian-approved amendment.
    /// @dev    Only `pendingAmendment[legalBody]`, the hash scheduled last, may execute, and
    ///         only once. A superseded or already executed hash reverts, so no one can choose
    ///         the order of two approvals or replay an old one to roll the agreement back.
    function executeOperatingAgreementUpdate(address legalBody, bytes32 newHash) external {
        if (!isLegalBody(legalBody)) revert NotLegalBody(legalBody);
        if (newHash == bytes32(0) || pendingAmendment[legalBody] != newHash) revert NotPendingAmendment(newHash);
        delete pendingAmendment[legalBody];
        LegalManager(payable(legalBody)).executeOperatingAgreementUpdate(newHash);
    }

    /// @notice The EIP-712 digest the guardian signs to approve an amendment.
    function amendmentDigest(address legalBody, bytes32 newHash, uint256 nonce, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(AMENDMENT_TYPEHASH, legalBody, newHash, nonce, deadline)));
    }

    // ------------------------------------------------------------------
    // Versions: published and withdrawn by the owner
    // ------------------------------------------------------------------

    /// @notice Add a version of the body's code to the list. It changes no body: a body moves
    ///         to it only by an upgrade its guardian signs.
    /// @dev    Refuses an address with no code, one already published, and anything that is
    ///         not a locked UUPS logic contract (see `_requireLockedImplementation`). That
    ///         check proves what the address is. It cannot prove the version is sound: in
    ///         particular nothing on chain can prove a version keeps the upgrade lock. A
    ///         version must inherit LegalBody, be reviewed and have its source verified before
    ///         it is published.
    function publishVersion(address implementation_) external onlyOwner returns (uint256 version) {
        if (implementation_.code.length == 0) revert NotContract(implementation_);
        if (versionOfImplementation[implementation_] != 0) revert VersionExists(implementation_);
        _requireLockedImplementation(implementation_);
        version = _addVersion(implementation_);
    }

    /// @notice Withdraw a published version, for good. It can no longer be scheduled or
    ///         executed, even when an upgrade to it is already waiting. Bodies already on it
    ///         stay on it and can move to a later one.
    /// @dev    Version 1 cannot be withdrawn: it is what bodies are created on and is never
    ///         the target of an upgrade.
    function withdrawVersion(uint256 version) external onlyOwner {
        Version storage v = _version(version);
        if (version == 1) revert FirstVersionCannotBeWithdrawn();
        if (v.withdrawn) revert VersionIsWithdrawn(version);
        v.withdrawn = true;
        emit VersionWithdrawn(version, v.implementation);
    }

    // ------------------------------------------------------------------
    // Upgrades: guardian-signed, sent by anyone, guardian-cancellable
    // ------------------------------------------------------------------

    /// @notice Schedule the upgrade of a body to a published version, with its guardian's
    ///         signature. Callable by anyone: the signature is the authority.
    /// @dev    The guardian and the delay come from this factory's record of the body, never
    ///         from the body. The upgrade becomes the body's only pending one and supersedes
    ///         any older one; the delay starts again. Forward only: the version must be later
    ///         than the one the body runs, and versions may be skipped. Allowed in any status
    ///         of the body, because the code a dissolving or dissolved body still needs (the
    ///         sweeps) must stay repairable.
    function scheduleLegalBodyUpgrade(
        address legalBody,
        uint256 version,
        uint256 deadline,
        bytes calldata guardianSignature
    ) external {
        if (!isLegalBody(legalBody)) revert NotLegalBody(legalBody);
        _checkDeadline(deadline);
        Version storage v = _version(version);
        if (v.withdrawn) revert VersionIsWithdrawn(version);
        BodyRecord storage record = bodyRecord[legalBody];
        if (version <= record.version) revert NotNewerVersion(version);

        uint256 nonce = upgradeNonce[legalBody];
        bytes32 digest = upgradeDigest(legalBody, version, v.implementation, nonce, deadline);
        if (!_isValidSignature(record.guardian, digest, guardianSignature)) revert BadSignature();
        upgradeNonce[legalBody] = nonce + 1;

        uint256 executableAt = block.timestamp + record.delay;
        // Safe: `version` is at most the list's length, which `_addVersion` keeps within 32
        // bits, and a timestamp plus at most 30 days fits in 64 bits.
        // forge-lint: disable-next-line(unsafe-typecast)
        pendingUpgrade[legalBody] = PendingUpgrade({version: uint64(version), executableAt: uint64(executableAt)});
        emit LegalBodyUpgradeScheduled(legalBody, version, v.implementation, executableAt);
    }

    /// @notice Cancel the pending upgrade of a body. Guardian only, by a direct call.
    /// @dev    Uses up the body's current `upgradeNonce`, as the cancel by signature does: every
    ///         upgrade or cancel signature the guardian made before this call is void, whether
    ///         or not it was ever sent.
    function cancelLegalBodyUpgrade(address legalBody) external {
        if (msg.sender != bodyRecord[legalBody].guardian) revert NotGuardian();
        uint256 version = pendingUpgrade[legalBody].version;
        if (version == 0) revert NoPendingUpgrade();
        _cancelUpgrade(legalBody, version);
    }

    /// @notice Cancel the pending upgrade of a body with its guardian's signature. Callable by
    ///         anyone, so a guardian wallet that holds no gas can still cancel.
    /// @dev    The signature names the pending version and carries the body's current
    ///         `upgradeNonce`, which it uses up: it cannot cancel a later upgrade.
    function cancelLegalBodyUpgradeBySig(address legalBody, uint256 deadline, bytes calldata guardianSignature)
        external
    {
        if (!isLegalBody(legalBody)) revert NotLegalBody(legalBody);
        uint256 version = pendingUpgrade[legalBody].version;
        if (version == 0) revert NoPendingUpgrade();
        _checkDeadline(deadline);

        uint256 nonce = upgradeNonce[legalBody];
        bytes32 digest = upgradeCancelDigest(legalBody, version, nonce, deadline);
        if (!_isValidSignature(bodyRecord[legalBody].guardian, digest, guardianSignature)) revert BadSignature();
        _cancelUpgrade(legalBody, version);
    }

    /// @notice Carry out the pending upgrade of a body once its delay has passed, and for
    ///         `UPGRADE_EXECUTION_WINDOW` after that. Callable by anyone, so nobody can hold
    ///         back an upgrade the guardian signed.
    /// @dev    The version must still be listed, not withdrawn, and its code must be the code
    ///         that was published. The body then moves to it and runs its `migrate` in one
    ///         step, told which version it is leaving. Afterwards the body's initialisation
    ///         counter must equal the version's number, which holds only if the migration ran
    ///         as `reinitializer(version)`. If the migration reverts or the counter differs,
    ///         everything reverts and the upgrade stays pending. State is written before the
    ///         call.
    function executeLegalBodyUpgrade(address legalBody) external {
        PendingUpgrade memory pending = pendingUpgrade[legalBody];
        uint256 version = pending.version;
        if (version == 0) revert NoPendingUpgrade();
        if (block.timestamp < pending.executableAt) revert UpgradeTooEarly();
        if (block.timestamp > uint256(pending.executableAt) + UPGRADE_EXECUTION_WINDOW) revert UpgradeExpired();
        Version storage v = _versions[version - 1];
        if (v.withdrawn) revert VersionIsWithdrawn(version);
        address implementation_ = v.implementation;
        if (implementation_.codehash != v.codehash) revert VersionCodeChanged(version);

        delete pendingUpgrade[legalBody];
        BodyRecord storage record = bodyRecord[legalBody];
        uint256 fromVersion = record.version;
        // Safe: `version` came from a pending upgrade, which holds a listed version number.
        // forge-lint: disable-next-line(unsafe-typecast)
        record.version = uint32(version);

        LegalBody(payable(legalBody))
            .upgradeToAndCall(implementation_, abi.encodeCall(ILegalBodyVersion.migrate, (fromVersion)));
        // The version's one-time step must have run, under the version's own number. A step
        // numbered lower or higher, or one that did not count itself, would leave the body out
        // of step with the list: unable to take a later version, or able to repeat a step.
        uint256 initialized = LegalBody(payable(legalBody)).initializedVersion();
        if (initialized != version) revert MigrationNumberMismatch(version, initialized);
        emit LegalBodyUpgraded(legalBody, version, implementation_);
    }

    /// @notice The EIP-712 digest the guardian signs to approve an upgrade.
    function upgradeDigest(address legalBody, uint256 version, address implementation_, uint256 nonce, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return
            _hashTypedDataV4(
                keccak256(abi.encode(UPGRADE_TYPEHASH, legalBody, version, implementation_, nonce, deadline))
            );
    }

    /// @notice The EIP-712 digest the guardian signs to cancel a pending upgrade.
    function upgradeCancelDigest(address legalBody, uint256 version, uint256 nonce, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(UPGRADE_CANCEL_TYPEHASH, legalBody, version, nonce, deadline)));
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function isLegalBody(address legalBody) public view returns (bool) {
        return identityOwnerAtCreation[legalBody] != address(0);
    }

    /// @notice The EIP-712 digest the identity owner signs to authorise a body.
    function linkDigest(
        uint256 agentId,
        address guardian,
        uint256 amendmentDelay,
        bytes32 operatingAgreementHash,
        uint256 deadline
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(LINK_TYPEHASH, agentId, guardian, amendmentDelay, operatingAgreementHash, deadline))
        );
    }

    /// @notice The address the body for this link digest has, or will have. Publishing a
    ///         version does not move it.
    function predictLegalBody(bytes32 linkDigest_) public view returns (address) {
        return Create2.computeAddress(linkDigest_, proxyInitCodeHash);
    }

    /// @notice The version a body runs, or 0 for an address this factory did not create.
    function versionOf(address legalBody) external view returns (uint256) {
        return bodyRecord[legalBody].version;
    }

    /// @notice How many versions were published, withdrawn ones included.
    function versionCount() external view returns (uint256) {
        return _versions.length;
    }

    function versionInfo(uint256 version) external view returns (Version memory) {
        return _version(version);
    }

    /// @notice The exact pointer value the identity owner writes under `POINTER_KEY`.
    function encodePointer(address legalBody) external view returns (bytes memory) {
        return abi.encode(POINTER_VERSION, block.chainid, legalBody);
    }

    /// @notice The legal body `agentId` is linked to right now, or address(0).
    /// @dev    One predicate for everyone (this platform's backend and any third party). Linked
    ///         means all of these hold: the owner's pointer is exactly the 96-byte encoding for
    ///         this chain; it names a body this factory created and still manages; that body
    ///         names this agentId and is Active; and the identity still belongs to the owner
    ///         who signed the link.
    ///         The pointer is written by the identity owner, so it can hold any bytes: this
    ///         function decodes by hand and never reverts on anything the identity owner can
    ///         write under the pointer key. It does rely on the registry itself returning
    ///         well-formed data: a registry that answered with undecodable return data could
    ///         still make it revert.
    function linkedLegalBody(uint256 agentId) external view returns (address) {
        bytes memory pointer;
        try identityRegistry.getMetadata(agentId, POINTER_KEY) returns (bytes memory p) {
            pointer = p;
        } catch {
            return address(0);
        }
        if (pointer.length != POINTER_LENGTH) return address(0);
        uint256 version;
        uint256 chainId;
        uint256 bodyWord;
        assembly {
            version := mload(add(pointer, 0x20))
            chainId := mload(add(pointer, 0x40))
            bodyWord := mload(add(pointer, 0x60))
        }
        if (version != POINTER_VERSION || chainId != block.chainid || bodyWord >> 160 != 0) return address(0);
        // Safe: the line above returned early unless every bit above the low 160 is zero.
        // forge-lint: disable-next-line(unsafe-typecast)
        address candidate = address(uint160(bodyWord));
        address creator = identityOwnerAtCreation[candidate];
        if (creator == address(0)) return address(0);

        LegalManager lm = LegalManager(payable(candidate));
        (,,, uint256 bodyAgentId) = lm.meta();
        if (bodyAgentId != agentId || !_isActive(candidate)) return address(0);
        // True for every body today. It keeps two factories from both calling one body linked
        // if a later version ever hands a body to another manager.
        if (lm.manager() != address(this)) return address(0);

        try identityRegistry.ownerOf(agentId) returns (address currentOwner) {
            if (currentOwner != creator) return address(0);
        } catch {
            return address(0);
        }
        return candidate;
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _addVersion(address implementation_) private returns (uint256 version) {
        bytes32 codehash = implementation_.codehash;
        _versions.push(
            Version({
                implementation: implementation_,
                codehash: codehash,
                publishedAt: uint64(block.timestamp),
                withdrawn: false
            })
        );
        version = _versions.length;
        // Keeps every version number within the 32 bits a body's record stores it in.
        assert(version <= type(uint32).max);
        versionOfImplementation[implementation_] = version;
        emit VersionPublished(version, implementation_, codehash);
    }

    /// @dev Both cancels end here. Using up the nonce voids every signature the guardian made
    ///      for it: the cancel signature just used, and any upgrade signed but not yet sent.
    function _cancelUpgrade(address legalBody, uint256 version) private {
        upgradeNonce[legalBody] += 1;
        delete pendingUpgrade[legalBody];
        emit LegalBodyUpgradeCancelled(legalBody, version);
    }

    /// @dev Whether `legalBody` reports the Active status. Read as a raw word: a later version of
    ///      the body's code may add a status this factory does not know, and decoding that as
    ///      `LegalManager.Status` would revert where the answer is "not Active".
    function _isActive(address legalBody) private view returns (bool) {
        (bool ok, bytes memory ret) =
            legalBody.staticcall(abi.encodeWithSelector(LegalManager(payable(legalBody)).status.selector));
        return ok && ret.length == 32 && abi.decode(ret, (uint256)) == uint256(LegalManager.Status.Active);
    }

    function _version(uint256 version) private view returns (Version storage) {
        if (version == 0 || version > _versions.length) revert UnknownVersion(version);
        return _versions[version - 1];
    }

    /// @dev Every version of the body's code must be a locked UUPS logic contract, never a
    ///      proxy or a live body: a body pointed at a proxy would run whatever that proxy's
    ///      controller chose, without its guardian. Three checks, all needed:
    ///      1. `manager()` is empty. A proxy of a live body has a manager; a contract that is
    ///         not a LegalManager at all reverts here, which also refuses it.
    ///      2. `initialize` reverts with exactly `InvalidInitialization`, which proves the
    ///         target's initialisers were disabled at construction. An uninitialised proxy
    ///         would accept the call instead; the revert below then undoes that
    ///         initialisation along with the whole transaction, so the probe leaves no trace.
    ///      3. `proxiableUUID()` returns the ERC-1967 implementation slot. OpenZeppelin makes
    ///         that function revert when it is reached through a proxy, so this refuses a
    ///         proxy of a real logic contract too, and a LegalManager with no upgrade entry
    ///         point, which a body could never leave.
    function _requireLockedImplementation(address implementation_) private {
        LegalManager lm = LegalManager(payable(implementation_));
        if (lm.manager() != address(0)) revert NotImplementation(implementation_);
        try lm.initialize(address(1), address(2), MIN_AMENDMENT_DELAY, 0, "", 0, bytes32(0)) {
            revert NotImplementation(implementation_);
        } catch (bytes memory reason) {
            // Truncating to the first 4 bytes is the point: it reads the error selector.
            // forge-lint: disable-next-line(unsafe-typecast)
            if (reason.length < 4 || bytes4(reason) != Initializable.InvalidInitialization.selector) {
                revert NotImplementation(implementation_);
            }
        }
        try IERC1822Proxiable(implementation_).proxiableUUID() returns (bytes32 slot) {
            if (slot != ERC1967Utils.IMPLEMENTATION_SLOT) revert NotImplementation(implementation_);
        } catch {
            revert NotImplementation(implementation_);
        }
    }

    /// @dev ECDSA first, then ERC-1271: the same rule the ERC-8004 identity registry uses. A
    ///      plain ECDSA signature from `signer`'s own key is accepted even when `signer` has
    ///      code, which is what an EIP-7702 delegated account looks like; its own key controls
    ///      it. This is safe for ordinary contracts, because no one holds a key for a contract
    ///      address. Otherwise a contract signer is asked through ERC-1271.
    function _isValidSignature(address signer, bytes32 digest, bytes calldata signature) internal view returns (bool) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == signer) return true;
        if (signer.code.length != 0) return SignatureChecker.isValidERC1271SignatureNow(signer, digest, signature);
        return false;
    }

    function _checkDeadline(uint256 deadline) internal view {
        if (deadline < block.timestamp || deadline > block.timestamp + MAX_SIGNATURE_WINDOW) revert BadDeadline();
    }

    /// @dev Renouncing would leave no one able to create bodies, record amendments or publish
    ///      a version.
    function renounceOwnership() public pure override {
        revert OwnershipRenounceDisabled();
    }
}
