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
  /** Keys the server actually stored. A key it refused is not in here. */
  uploaded: string[]
  unchanged: string[]
  deleted: string[]
  /**
   * What the server refused, verbatim from its response: an invalid key, bad
   * base64, an oversized entry. This client always sets it (empty when nothing
   * was refused); it is optional only so a test double or a server predating
   * the field does not have to carry one. A caller reporting a push as saved
   * has to consult it, or it reports a refusal as success.
   */
  skipped?: { key: string; reason: string }[]
}

/**
 * A body that would not decrypt with this client's key.
 *
 * Without a type for it, a caller sees one Error for a wrong passphrase, a
 * truncated response and a dropped socket alike, so a preflight check has no
 * honest way to say which happened and defaults to blaming the passphrase.
 */
export class MemlawbDecryptError extends Error {
  constructor(
    readonly entryKey: string,
    readonly namespace: string,
    readonly reason: string,
  ) {
    super(`memlawb: could not decrypt "${entryKey}" in ${namespace}: ${reason}`)
    this.name = 'MemlawbDecryptError'
  }
}

/**
 * What one namespace's reads and writes have taught this client.
 *
 * `hashes` is entryKey -> the ciphertext hash this client last saw it hold.
 * `enumerated` says whether the source listed the namespace authoritatively,
 * which decides what a key's ABSENCE from the map is allowed to mean.
 */
type Observed = {
  hashes: Record<string, string>
  enumerated: boolean
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
   * What this client has learned about each namespace, from reads the caller
   * asked for and from its own successful writes. No entry at all means this
   * client has never touched the namespace, and a first write into one is
   * deliberately unconditional.
   *
   * The `enumerated` flag is the part that matters. A `hashes` read returns the
   * manifest's checksums entire, so a key missing from it provably does not
   * exist and a later write may assert that absence with a null base. A `pull`
   * cannot make that claim: the server skips an entry whose blob has gone from
   * both `content.entries` and `content.entryChecksums`, so a key can be in the
   * manifest and invisible to the read. A pull therefore records only what it
   * decrypted, and a key it did not see is unknown rather than absent. Asserting
   * absence from a pull locked a drifted key out of every future write, since
   * the server refused the null base and re-pulling could never clear it.
   *
   * Deliberately not filled by `push`'s internal pre-flight read: that happens
   * milliseconds before the PUT, so a base taken from it would guard a window
   * that barely exists while the real one, the caller's turn between reading an
   * entry and writing it back, stayed open.
   */
  private readonly observed = new Map<string, Observed>()

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
    // Authoritative: these ARE the manifest's checksums, and a base is a
    // ciphertext hash, so this read is exact for the precondition even though
    // it carries no bodies.
    this.observed.set(namespace, { hashes: { ...checksums }, enumerated: true })
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
      // Enumerated, unlike every other pull: `empty` means no manifest exists,
      // so there is no entry a drifted blob could have hidden. A create after
      // this can therefore assert absence rather than overwrite blindly.
      this.observed.set(namespace, { hashes: {}, enumerated: true })
      return { namespace, version: 0, entries: {} }
    }
    if (!res.ok) throw await httpError(res)
    const data = (await res.json()) as {
      version: number
      content: { entries: Record<string, string> }
    }
    const key = this.key(namespace)
    const entries: Record<string, string> = {}
    // The base is derived from the bodies rather than the response's checksum
    // map, so it reflects what was actually decrypted here. This is a read the
    // caller asked for, so it is what a later write's base is measured against
    // — but positive knowledge only, hence `enumerated: false`; see `observed`.
    const seen: Record<string, string> = {}
    for (const [entryKey, b64] of Object.entries(data.content.entries)) {
      try {
        entries[entryKey] = decryptEntry(key, entryKey, b64)
      } catch (err) {
        throw new MemlawbDecryptError(entryKey, namespace, (err as Error).message)
      }
      seen[entryKey] = ciphertextHash(b64)
    }
    this.observed.set(namespace, { hashes: seen, enumerated: false })
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
    const view = await this.hashesView(namespace)
    const serverHashes = view.entryChecksums

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
      // Nothing to do. The version comes from the read above rather than a
      // second request: asking again cost a round trip on the commonest write
      // an agent makes, and that second read had its own 404 rule.
      return { namespace, version: view.version, uploaded, unchanged, deleted: [], skipped: [] }
    }

    const sent = this.baseFor(namespace, [...uploaded, ...deletions])
    const res = await fetch(this.endpoint(namespace), {
      method: 'PUT',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ entries: toUpload, deletions, ...(sent ?? {}) }),
    })
    if (!res.ok) throw await httpError(res, sent?.base)
    const result = (await res.json()) as {
      version: number
      deleted: string[]
      skipped?: { key: string; reason: string }[]
    }
    // A key the server refused was never stored, so folding its hash into
    // `observed` would make the next write send a base for content that does
    // not exist and take a 409 for a race nobody ran. Filtering on `skipped`
    // rather than intersecting `accepted` keeps this right against a server
    // that does not report `accepted` at all.
    const skipped = result.skipped ?? []
    const refused = new Set(skipped.map(s => s.key))
    const stored: Record<string, string> = {}
    for (const [k, b64] of Object.entries(toUpload)) if (!refused.has(k)) stored[k] = b64
    this.record(
      namespace,
      stored,
      deletions.filter(k => !refused.has(k)),
    )
    return {
      namespace,
      version: result.version,
      uploaded: uploaded.filter(k => !refused.has(k)),
      unchanged,
      deleted: result.deleted ?? [],
      skipped,
    }
  }

  /** Delete one entry. */
  async delete(namespace: string, entryKey: string): Promise<void> {
    const observed = this.observed.get(namespace)
    const seen = observed?.hashes[entryKey]
    if (!seen && observed?.enumerated) {
      // This client has enumerated the namespace and the key was not in it, so
      // the delete must assert that absence exactly as a push would. DELETE
      // cannot carry it: the server reads `base` off the query string and
      // accepts only a sha256:<hex> there, with no spelling for null. The PUT
      // body already takes a JSON null, so route it through that instead of
      // sending an unconditional delete that would destroy a competing write.
      const sent = { [entryKey]: null }
      const res = await fetch(this.endpoint(namespace), {
        method: 'PUT',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ entries: {}, deletions: [entryKey], base: sent }),
      })
      if (!res.ok) throw await httpError(res, sent)
      this.record(namespace, {}, [entryKey])
      return
    }
    const q = seen ? `&base=${encodeURIComponent(seen)}` : ''
    const res = await fetch(`${this.endpoint(namespace)}?key=${encodeURIComponent(entryKey)}${q}`, {
      method: 'DELETE',
      headers: this.headers(),
    })
    if (!res.ok) throw await httpError(res, seen ? { [entryKey]: seen } : undefined)
    this.record(namespace, {}, [entryKey])
  }

  /**
   * The base to send for the keys a write touches, or nothing when this client
   * has not touched the namespace. Sending no base is unconditional, which is
   * what a first write into a namespace nobody has read should be.
   *
   * A key the map holds sends its hash. A key it does not hold sends `null`,
   * asserting the key does not exist, ONLY when the map came from an
   * enumeration; otherwise the key is omitted, because this client cannot
   * honestly claim something it never enumerated is absent. Omitting every key
   * leaves an empty base, which is the same claim as no base at all.
   */
  private baseFor(
    namespace: string,
    keys: string[],
  ): { base: Record<string, string | null> } | null {
    const observed = this.observed.get(namespace)
    if (!observed || keys.length === 0) return null
    const base: Record<string, string | null> = {}
    for (const k of keys) {
      const hash = observed.hashes[k]
      if (hash !== undefined) base[k] = hash
      else if (observed.enumerated) base[k] = null
    }
    if (Object.keys(base).length === 0) return null
    return { base }
  }

  /**
   * Fold a successful write into what this client has observed.
   *
   * Creates the map when there is none: a write is itself knowledge of what the
   * namespace holds. It used to return early instead, so a client that only
   * ever wrote never armed the precondition and its SECOND push silently
   * clobbered whatever had landed in between. The new map is not enumerated,
   * since a write says nothing about the keys it did not touch.
   */
  private record(namespace: string, written: Record<string, string>, deleted: string[]): void {
    let observed = this.observed.get(namespace)
    if (!observed) {
      observed = { hashes: {}, enumerated: false }
      this.observed.set(namespace, observed)
    }
    for (const [k, b64] of Object.entries(written)) observed.hashes[k] = ciphertextHash(b64)
    for (const k of deleted) delete observed.hashes[k]
  }
}

/**
 * `sentBase` is what THIS client wrote against, which the server's payload
 * cannot supply: a refusal reports only what each key holds now. Without it a
 * caller can say what changed but not what it was working from, and KTD3 asks
 * the tool text for both.
 */
async function httpError(
  res: Response,
  sentBase?: Record<string, string | null>,
): Promise<MemlawbHttpError> {
  let code = 'unknown'
  let details: Record<string, unknown> | undefined
  // Read the body ONCE. This used to call res.json() and then res.text() on the
  // same response, so the non-JSON fallback ran against an already-consumed
  // body and every non-JSON refusal rendered as a bare status with no detail.
  const raw = await res.text().catch(() => '')
  try {
    const body = JSON.parse(raw) as {
      error?: { code?: string; details?: Record<string, unknown> }
    }
    if (body.error?.code) code = body.error.code
    details = body.error?.details
  } catch {
    // Not JSON. The raw text is the only thing there is to report.
  }
  return new MemlawbHttpError(
    `memlawb ${res.status} ${safeText(res.statusText)}: ${safeText(raw)}`,
    res.status,
    code,
    sentBase ? { ...details, sentBase } : details,
  )
}

/** How much server-supplied text an error message may carry. */
const MAX_SERVER_TEXT = 200

/**
 * Bound and de-fang text the server chose, before it lands in `Error.message`.
 *
 * That message is rendered into a model's context by the MCP tools, so a
 * hostile or merely broken server could otherwise plant an escape sequence, a
 * fake instruction, or a megabyte of anything there. Only the human-readable
 * message is treated this way: `code` and `details` stay verbatim, because they
 * are the machine-readable half and a caller matches on them.
 */
function safeText(text: string): string {
  const clean = text
    // ANSI sequences whole, so stripping ESC does not leave `[31m` behind.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.length > MAX_SERVER_TEXT ? `${clean.slice(0, MAX_SERVER_TEXT)}...` : clean
}

export { ciphertextHash, decryptEntry, deriveKey, encryptEntry } from './crypto.ts'
export {
  type Finding,
  type ScanMode,
  SecretFoundError,
  scanEntries,
  scanEntry,
} from './secretscan.ts'
