/**
 * MemlawbClient — the zero-knowledge sync client.
 *
 * Wraps the crypto + the HTTP sync contract so callers (the openclaude shim,
 * the MCP server, the CLI) work in plaintext and never touch ciphertext or the
 * wire format. Encryption/decryption happen in-process with a key derived from
 * the passphrase, which never leaves the machine.
 *
 *   const client = new MemlawbClient({ url, apiKey, passphrase })
 *   await client.push('user:me', { 'MEMORY.md': '# index...' })
 *   const { entries } = await client.pull('user:me')
 */

import { ciphertextHash, decryptEntry, deriveKey, encryptEntry } from './crypto.ts'
import { enforce, type Finding, type ScanMode } from './secretscan.ts'

export type MemlawbClientOptions = {
  /** Base URL, e.g. https://memory.gitlawb.com (no trailing slash needed). */
  url: string
  /** API key (Bearer). Omit only against an ALLOW_UNAUTHENTICATED self-host. */
  apiKey?: string
  /** Passphrase the encryption key is derived from. Never sent to the server. */
  passphrase: string
  /**
   * Secret-scan policy applied to plaintext before encryption. Default `block`
   * (refuse to upload entries that look like they contain live credentials).
   */
  scanMode?: ScanMode
  /** Called with findings in `warn` mode (default logs to console.warn). */
  onScanWarning?: (findings: Finding[]) => void
}

export type PullResult = {
  namespace: string
  version: number
  /** entryKey -> decrypted plaintext */
  entries: Record<string, string>
}

export type PushResult = {
  namespace: string
  version: number
  uploaded: string[]
  unchanged: string[]
  deleted: string[]
}

/**
 * A refusal from the server, carrying what it actually said.
 *
 * The previous shape flattened every failure into one message string, so a
 * caller could not tell a stale write from a bad key from a quota breach, and
 * an agent surfacing it had nothing to act on. `code` is the server's own error
 * code and `details` its payload, so a stale write names the keys that moved.
 */
export class MemlawbHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'MemlawbHttpError'
  }
}

export class MemlawbClient {
  /**
   * What this client last saw each entry hold, per namespace, from reads the
   * caller asked for and from its own successful writes.
   *
   * Deliberately not filled by `push`'s internal pre-flight read: that happens
   * milliseconds before the PUT, so a base taken from it would guard a window
   * that barely exists while the real one, the caller's turn between reading an
   * entry and writing it back, stayed open.
   */
  private readonly observed = new Map<string, Record<string, string>>()

  private readonly url: string
  private readonly apiKey?: string
  private readonly passphrase: string
  private readonly scanMode: ScanMode
  private readonly onScanWarning?: (findings: Finding[]) => void
  private readonly keyCache = new Map<string, Buffer>()

  constructor(opts: MemlawbClientOptions) {
    this.url = opts.url.replace(/\/$/, '')
    this.apiKey = opts.apiKey
    this.passphrase = opts.passphrase
    this.scanMode = opts.scanMode ?? 'block'
    this.onScanWarning = opts.onScanWarning
  }

  private key(namespace: string): Buffer {
    let k = this.keyCache.get(namespace)
    if (!k) {
      k = deriveKey(this.passphrase, namespace)
      this.keyCache.set(namespace, k)
    }
    return k
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      ...extra,
    }
  }

  private endpoint(namespace: string): string {
    return `${this.url}/api/memory/${encodeURIComponent(namespace)}`
  }

  /** Fetch per-key ciphertext checksums (no bodies). Empty if namespace is new. */
  async hashes(namespace: string): Promise<Record<string, string>> {
    const checksums = (await this.hashesView(namespace)).entryChecksums
    this.observed.set(namespace, { ...checksums })
    return checksums
  }

  /**
   * The raw hashes view, without recording what it saw. `push` uses this for
   * its delta computation, which must not count as the caller having read the
   * namespace; see `observed`.
   */
  private async hashesView(
    namespace: string,
  ): Promise<{ version: number; entryChecksums: Record<string, string>; supports: string[] }> {
    const res = await fetch(`${this.endpoint(namespace)}?view=hashes`, { headers: this.headers() })
    if (res.status === 404) {
      const err = await httpError(res)
      // Only the server's own "this namespace has nothing yet" is emptiness.
      // Any other 404 is a wrong URL or something in front of the server, and
      // reporting it as an empty namespace is a denial rendered as success.
      if (err.code !== 'empty') throw err
      return { version: 0, entryChecksums: {}, supports: [] }
    }
    if (!res.ok) throw await httpError(res)
    const data = (await res.json()) as {
      version?: number
      entryChecksums?: Record<string, string>
      supports?: string[]
    }
    return {
      version: data.version ?? 0,
      entryChecksums: data.entryChecksums ?? {},
      supports: data.supports ?? [],
    }
  }

  /**
   * Whether this server enforces the write precondition. A server that ignores
   * an unknown body field accepts a stale write silently, so a caller relying
   * on the guarantee needs to know it is not in force rather than assume it.
   */
  async preconditionEnforced(namespace: string): Promise<boolean> {
    return (await this.hashesView(namespace)).supports.includes('base-precondition')
  }

  /** Pull and decrypt all entries for a namespace. */
  async pull(namespace: string): Promise<PullResult> {
    const res = await fetch(this.endpoint(namespace), { headers: this.headers() })
    if (res.status === 404) {
      const err = await httpError(res)
      // See hashesView: only the server's own `empty` is an empty namespace.
      if (err.code !== 'empty') throw err
      this.observed.set(namespace, {})
      return { namespace, version: 0, entries: {} }
    }
    if (!res.ok) throw await httpError(res)
    const data = (await res.json()) as {
      version: number
      content: { entries: Record<string, string>; entryChecksums?: Record<string, string> }
    }
    const key = this.key(namespace)
    const entries: Record<string, string> = {}
    for (const [entryKey, b64] of Object.entries(data.content.entries)) {
      entries[entryKey] = decryptEntry(key, entryKey, b64)
    }
    // This is a read the caller asked for, so it is what a later write's base
    // is measured against. Derive from the bodies rather than trusting the
    // checksum map, so the base reflects what was actually decrypted here.
    const seen: Record<string, string> = {}
    for (const [entryKey, b64] of Object.entries(data.content.entries)) {
      seen[entryKey] = ciphertextHash(b64)
    }
    this.observed.set(namespace, seen)
    return { namespace, version: data.version, entries }
  }

  /**
   * Encrypt + delta-push entries. Only entries whose ciphertext differs from
   * the server's are uploaded (deterministic encryption makes this stable).
   */
  async push(
    namespace: string,
    entries: Record<string, string>,
    opts?: { deletions?: string[] },
  ): Promise<PushResult> {
    // Defense in depth: scan plaintext for secrets BEFORE it is encrypted and
    // leaves the machine. `block` throws; `warn` reports and proceeds.
    const findings = enforce(entries, this.scanMode)
    if (findings.length) {
      if (this.onScanWarning) this.onScanWarning(findings)
      else
        console.warn(
          `[memlawb] ${findings.length} potential secret(s) in pushed memory (scan=warn)`,
        )
    }

    const key = this.key(namespace)
    const serverHashes = (await this.hashesView(namespace)).entryChecksums

    const toUpload: Record<string, string> = {}
    const uploaded: string[] = []
    const unchanged: string[] = []
    for (const [entryKey, plaintext] of Object.entries(entries)) {
      const b64 = encryptEntry(key, entryKey, plaintext)
      if (serverHashes[entryKey] === ciphertextHash(b64)) {
        unchanged.push(entryKey)
        continue
      }
      toUpload[entryKey] = b64
      uploaded.push(entryKey)
    }

    const deletions = opts?.deletions ?? []
    if (uploaded.length === 0 && deletions.length === 0) {
      // Nothing to do; report current server version.
      const ver = await this.version(namespace)
      return { namespace, version: ver, uploaded, unchanged, deleted: [] }
    }

    const res = await fetch(this.endpoint(namespace), {
      method: 'PUT',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        entries: toUpload,
        deletions,
        ...(this.baseFor(namespace, [...uploaded, ...deletions]) ?? {}),
      }),
    })
    if (!res.ok) throw await httpError(res)
    const result = (await res.json()) as { version: number; deleted: string[] }
    this.record(namespace, toUpload, deletions)
    return {
      namespace,
      version: result.version,
      uploaded,
      unchanged,
      deleted: result.deleted ?? [],
    }
  }

  /** Delete one entry. */
  async delete(namespace: string, entryKey: string): Promise<void> {
    const seen = this.observed.get(namespace)?.[entryKey]
    const q = seen ? `&base=${encodeURIComponent(seen)}` : ''
    const res = await fetch(`${this.endpoint(namespace)}?key=${encodeURIComponent(entryKey)}${q}`, {
      method: 'DELETE',
      headers: this.headers(),
    })
    if (!res.ok) throw await httpError(res)
    this.record(namespace, {}, [entryKey])
  }

  /**
   * The base to send for the keys a write touches, or nothing when this client
   * has not read the namespace. Sending no base is unconditional, which is what
   * a first write into a namespace nobody has read should be.
   */
  private baseFor(
    namespace: string,
    keys: string[],
  ): { base: Record<string, string | null> } | null {
    const seen = this.observed.get(namespace)
    if (!seen || keys.length === 0) return null
    const base: Record<string, string | null> = {}
    for (const k of keys) base[k] = seen[k] ?? null
    return { base }
  }

  /** Fold a successful write into what this client has observed. */
  private record(namespace: string, written: Record<string, string>, deleted: string[]): void {
    const seen = this.observed.get(namespace)
    if (!seen) return
    for (const [k, b64] of Object.entries(written)) seen[k] = ciphertextHash(b64)
    for (const k of deleted) delete seen[k]
  }

  private async version(namespace: string): Promise<number> {
    const res = await fetch(`${this.endpoint(namespace)}?view=hashes`, { headers: this.headers() })
    if (res.status === 404) return 0
    if (!res.ok) throw await httpError(res)
    return ((await res.json()) as { version: number }).version
  }
}

async function httpError(res: Response): Promise<MemlawbHttpError> {
  let code = 'unknown'
  let details: Record<string, unknown> | undefined
  let detail = ''
  try {
    const body = (await res.json()) as {
      error?: { code?: string; details?: Record<string, unknown> }
    }
    if (body.error?.code) code = body.error.code
    details = body.error?.details
    detail = JSON.stringify(body)
  } catch {
    detail = await res.text().catch(() => '')
  }
  return new MemlawbHttpError(
    `memlawb ${res.status} ${res.statusText}: ${detail}`,
    res.status,
    code,
    details,
  )
}

export { ciphertextHash, decryptEntry, deriveKey, encryptEntry } from './crypto.ts'
export {
  type Finding,
  type ScanMode,
  SecretFoundError,
  scanEntries,
  scanEntry,
} from './secretscan.ts'
