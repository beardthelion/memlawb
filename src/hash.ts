/**
 * Hashing helpers. These run over CIPHERTEXT only — they never touch
 * plaintext (the server never has it).
 */

import { createHash } from 'node:crypto'

/** sha256:<hex> of raw bytes. */
export function sha256Prefixed(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/** sha256 hex (no prefix) of a string — used to derive flat entry filenames. */
export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

/**
 * Deterministic checksum over a whole namespace: hash of the sorted
 * `key\thash` lines. Two namespaces with identical entry sets (same keys, same
 * ciphertext) get the same checksum regardless of write order.
 */
export function namespaceChecksum(entryChecksums: Record<string, string>): string {
  const lines = Object.keys(entryChecksums)
    .sort()
    .map(k => `${k}\t${entryChecksums[k]}`)
    .join('\n')
  return `sha256:${createHash('sha256').update(lines).digest('hex')}`
}
