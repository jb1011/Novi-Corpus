// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title BytecodeMetadata
/// @notice Compares runtime code without the metadata the compiler appends to it, so that two
///         builds of the same source that differ only in comments compare equal.
library BytecodeMetadata {
    /// @dev Drops the trailing CBOR metadata that solc appends to runtime code. Its last 2 bytes
    ///      are a big-endian length L of the CBOR block before them, so the last L + 2 bytes go.
    ///      Code too short to hold that much is returned unchanged.
    function strip(bytes memory code) internal pure returns (bytes memory stripped) {
        uint256 n = code.length;
        if (n < 2) return code;
        uint256 metaLen = (uint256(uint8(code[n - 2])) << 8) | uint256(uint8(code[n - 1]));
        if (metaLen + 2 > n) return code;
        stripped = new bytes(n - metaLen - 2);
        for (uint256 i = 0; i < stripped.length; i++) {
            stripped[i] = code[i];
        }
    }
}
