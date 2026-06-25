/**
 * Namespace and entry-key validation.
 *
 * A *namespace* is the unit of scoping/sharing (e.g. `user:abc`, `repo:owner/name`).
 * An *entry key* is a path within a namespace mirroring the memdir layout
 * (e.g. `MEMORY.md`, `feedback/testing.md`).
 *
 * Both are attacker-controlled (they come straight off the request), so they
 * are strictly validated before ever touching a storage path. This is the
 * server's port of openclaude's `validateTeamMemKey` path-traversal guard.
 */

export class InvalidNameError extends Error {}

// Namespaces: lowercase scope + ':' + segment(s). Conservative allowlist.
//   user:9f3a...        repo:gitlawb/node        agent:intern
const NAMESPACE_RE = /^[a-z][a-z0-9_-]{0,31}:[A-Za-z0-9._/-]{1,128}$/

/**
 * Validate a namespace id. Throws InvalidNameError on anything suspicious.
 * Returns the namespace unchanged so it can be used inline.
 */
export function validateNamespace(ns: string): string {
  if (typeof ns !== 'string' || !NAMESPACE_RE.test(ns)) {
    throw new InvalidNameError(`invalid namespace: ${JSON.stringify(ns)}`)
  }
  if (ns.includes('..') || ns.includes('//')) {
    throw new InvalidNameError('namespace must not contain ".." or "//"')
  }
  return ns
}

// Entry keys: relative posix-ish paths. No leading slash, no traversal,
// no backslashes, no NUL, must end in a sane file segment.
const ENTRY_KEY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,254})$/

export function validateEntryKey(key: string): string {
  if (typeof key !== 'string' || !ENTRY_KEY_RE.test(key)) {
    throw new InvalidNameError(`invalid entry key: ${JSON.stringify(key)}`)
  }
  if (
    key.includes('..') ||
    key.includes('//') ||
    key.startsWith('/') ||
    key.endsWith('/') ||
    key.includes('\0') ||
    key.includes('\\')
  ) {
    throw new InvalidNameError(`unsafe entry key: ${JSON.stringify(key)}`)
  }
  return key
}

/**
 * Turn a namespace into a single filesystem/object-store-safe segment.
 * We hash the slash-bearing part so the on-disk/object layout is always flat
 * and free of nested-path surprises, while staying deterministic.
 */
export function namespaceSlug(ns: string): string {
  // Replace the scope separator and any slashes with '__'. Already validated,
  // so this only needs to be reversible-enough for debugging, not perfectly.
  return ns.replace(/[:/]/g, '__')
}
