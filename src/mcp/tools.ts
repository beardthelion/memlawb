/**
 * memlawb memory tools, decoupled from the MCP transport so they can be unit
 * tested directly against a MemlawbClient. server.ts wraps each result into the
 * MCP content shape; everything substantive lives here.
 *
 * All encryption/decryption happens inside the MemlawbClient in THIS process,
 * which holds the passphrase. The remote server only ever sees ciphertext, so
 * recall/search must run locally on decrypted entries — which is exactly what
 * these tools do.
 */

import { MemlawbHttpError, type PullResult, type PushResult } from '../../client/index.ts'
import { SecretFoundError } from '../../client/secretscan.ts'
import { rankMemories } from './relevance.ts'

export type ToolResult = { text: string; isError?: boolean }

/**
 * The slice of MemlawbClient these tools actually use. Structural rather than
 * the concrete class so a test can drive a specific server refusal through the
 * tools without a live server; the real client still has to satisfy it.
 */
export type MemoryClient = {
  push(
    namespace: string,
    entries: Record<string, string>,
    opts?: { deletions?: string[] },
  ): Promise<PushResult>
  pull(namespace: string): Promise<PullResult>
  hashes(namespace: string): Promise<Record<string, string>>
  delete(namespace: string, entryKey: string): Promise<void>
}

const ok = (text: string): ToolResult => ({ text })
const fail = (text: string): ToolResult => ({ text, isError: true })

/**
 * Render a server refusal as text a model can act on.
 *
 * Every failure used to collapse into one string wrapping the raw JSON body,
 * which tells a model that something went wrong and nothing about what to do
 * next: a stale write, a wrong API key and a rate limit all read the same. Each
 * status now gets its own text with its own recovery move.
 *
 * The 403 text deliberately does NOT echo the namespace that was refused. A
 * denial is the one moment the caller is provably reaching outside its own
 * subtree, so repeating the target would feed another owner's namespace back
 * into the model's context; it names the prefix this deployment is authorized
 * for instead.
 *
 * Returns null when the error is not a typed HTTP refusal, so the caller keeps
 * its generic message rather than dressing up an unknown failure.
 */
/**
 * The subtree a key actually reaches, derived from the configured namespace.
 *
 * `authorizeNamespace` grants an owner `user:<owner>` and its children, so the
 * prefix is the owner root, never the configured namespace itself. The guide
 * and the setup card both ask a developer to run one namespace per codebase,
 * which makes a configured `user:alice/repo/x` the normal case; naming that as
 * the limit would be false and would send the model to retarget inside a
 * subtree narrower than the one it has. A namespace that is not `user:`-scoped
 * is not grantable at all, so it is reported unchanged.
 */
function ownerRoot(namespace: string): string {
  if (!namespace.startsWith('user:')) return namespace
  const slash = namespace.indexOf('/')
  return slash === -1 ? namespace : namespace.slice(0, slash)
}

function denial(
  action: string,
  namespace: string,
  configured: string,
  tail: string,
  e: unknown,
): string | null {
  if (!(e instanceof MemlawbHttpError)) return null
  const authorized = ownerRoot(configured)
  if (e.status === 401) {
    return `${action} refused: the server did not accept this API key (401 unauthorized). Set a working memlawb API key in the MCP server configuration and start it again; retrying with the same key cannot succeed. ${tail}`
  }
  if (e.status === 403) {
    return `${action} refused: this key may only reach ${authorized} and namespaces under it (403 forbidden). Retarget the tool at a namespace under ${authorized}. ${tail}`
  }
  if (e.status === 409) {
    return `${action} refused: the memory changed on the server after this session last read ${namespace}, so the base this write was computed from is out of date (409 stale base). ${conflictLines(e.details)}${sentBaseLine(e.details)} Re-read the namespace with the recall tool, reapply this change on top of what is stored now, and save again. ${tail}`
  }
  if (e.status === 429) {
    return `${action} refused: the server is rate limiting this key (429 rate limited). Do not retry now and do not retry in a loop; wait for the limit to reset, and tell the user memory writes are paused. ${tail}`
  }
  if (e.status === 413) {
    return `${action} refused: this write would exceed a storage limit on ${namespace} (413 quota: ${e.code}). Delete or shorten stored entries before saving again, or save less content. ${tail}`
  }
  return null
}

/**
 * What this client wrote against, when it sent a base at all.
 *
 * A first write into a namespace this client never read carries no base, so
 * there is nothing to name and this adds nothing rather than inventing one.
 */
function sentBaseLine(details: Record<string, unknown> | undefined): string {
  const raw = details?.sentBase
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return ''
  const parts = Object.entries(raw as Record<string, unknown>)
    .filter(([, v]) => typeof v === 'string')
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `"${k}" at ${v as string}`)
  return parts.length === 0 ? '' : ` This write was computed against ${parts.join(', ')}.`
}

/** What the server says each conflicting key holds now, or that it said nothing. */
function conflictLines(details: Record<string, unknown> | undefined): string {
  const raw = details?.conflicts
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return 'The server did not name the conflicting keys.'
  }
  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length === 0) return 'The server did not name the conflicting keys.'
  const parts = entries
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `"${k}" now holds ${typeof v === 'string' ? v : 'no entry'}`)
  return `Changed since this session read it: ${parts.join(', ')}.`
}

function snippet(content: string, max = 200): string {
  const oneLine = content.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

export type MemoryTools = ReturnType<typeof makeTools>

export function makeTools(client: MemoryClient, defaultNamespace: string) {
  const nsOf = (ns?: string) => (ns?.trim() ? ns.trim() : defaultNamespace)

  return {
    /** Persist one durable memory entry (encrypted before upload). */
    async save(key: string, content: string, namespace?: string): Promise<ToolResult> {
      const ns = nsOf(namespace)
      try {
        const r = await client.push(ns, { [key]: content })
        const status = r.uploaded.length ? 'saved' : 'unchanged'
        return ok(`${status} "${key}" in ${ns} (v${r.version})`)
      } catch (e) {
        if (e instanceof SecretFoundError) {
          return fail(
            `Refused to save "${key}" — it looks like it contains a secret:\n${e.message}`,
          )
        }
        const d = denial(`Saving "${key}"`, ns, defaultNamespace, 'Nothing was stored.', e)
        return fail(d ?? `save failed: ${(e as Error).message}`)
      }
    },

    /** Rank stored memories by relevance to a natural-language query. */
    async recall(query: string, namespace?: string, limit = 5): Promise<ToolResult> {
      const ns = nsOf(namespace)
      try {
        const { entries } = await client.pull(ns)
        if (Object.keys(entries).length === 0) return ok(`(no memory stored in ${ns} yet)`)
        const ranked = rankMemories(query, entries, limit)
        if (ranked.length === 0) return ok(`(nothing in ${ns} looks relevant to "${query}")`)
        const body = ranked.map(r => `### ${r.key}\n${r.content.trim()}`).join('\n\n')
        return ok(
          `${ranked.length} relevant memor${ranked.length === 1 ? 'y' : 'ies'} from ${ns}:\n\n${body}`,
        )
      } catch (e) {
        return fail(`recall failed: ${(e as Error).message}`)
      }
    },

    /** Literal substring/keyword search over keys and decrypted content. */
    async search(query: string, namespace?: string): Promise<ToolResult> {
      const ns = nsOf(namespace)
      const needle = query.toLowerCase()
      try {
        const { entries } = await client.pull(ns)
        const hits = Object.entries(entries).filter(
          ([key, content]) =>
            key.toLowerCase().includes(needle) || content.toLowerCase().includes(needle),
        )
        if (hits.length === 0) return ok(`no matches for "${query}" in ${ns}`)
        const body = hits.map(([key, content]) => `- ${key}: ${snippet(content)}`).join('\n')
        return ok(`${hits.length} match(es) for "${query}" in ${ns}:\n${body}`)
      } catch (e) {
        return fail(`search failed: ${(e as Error).message}`)
      }
    },

    /** List entry keys in a namespace (no content downloaded). */
    async list(namespace?: string): Promise<ToolResult> {
      const ns = nsOf(namespace)
      try {
        const hashes = await client.hashes(ns)
        const keys = Object.keys(hashes).sort()
        if (keys.length === 0) return ok(`(${ns} is empty)`)
        return ok(
          `${keys.length} entr${keys.length === 1 ? 'y' : 'ies'} in ${ns}:\n${keys.map(k => `- ${k}`).join('\n')}`,
        )
      } catch (e) {
        return fail(`list failed: ${(e as Error).message}`)
      }
    },

    /** Delete one entry. */
    async delete(key: string, namespace?: string): Promise<ToolResult> {
      const ns = nsOf(namespace)
      try {
        await client.delete(ns, key)
        return ok(`deleted "${key}" from ${ns}`)
      } catch (e) {
        const d = denial(`Deleting "${key}"`, ns, defaultNamespace, `"${key}" is still stored.`, e)
        return fail(d ?? `delete failed: ${(e as Error).message}`)
      }
    },
  }
}
