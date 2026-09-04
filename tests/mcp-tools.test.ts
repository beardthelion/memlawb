/**
 * MCP memory tools end-to-end: real in-process server + real MemlawbClient, so
 * every tool call goes through the actual encrypt → HTTP → ciphertext-store →
 * decrypt path. Also re-proves zero-knowledge: nothing the tools store is
 * readable on disk.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MemlawbClient } from '../client/index.ts'
import { type MemoryTools, makeTools } from '../src/mcp/tools.ts'
import { FAKE } from './secret-fixtures.ts'
import { httpError, StubClient } from './stub-client.ts'

const DATA_DIR = process.env.DATA_DIR!
let server: ReturnType<typeof Bun.serve>
let tools: MemoryTools

beforeAll(async () => {
  const { handleRequest } = await import('../src/handler.ts')
  server = Bun.serve({ port: 0, fetch: handleRequest })
  const client = new MemlawbClient({
    url: `http://localhost:${server.port}`,
    passphrase: 'mcp-pass',
  })
  tools = makeTools(client, 'user:me')
})

afterAll(() => server?.stop(true))

describe('mcp memory tools', () => {
  test('save then list shows the entry', async () => {
    const saved = await tools.save('prefs.md', 'The user prefers terse answers.')
    expect(saved.isError).toBeUndefined()
    expect(saved.text).toContain('saved')

    const list = await tools.list()
    expect(list.text).toContain('prefs.md')
  })

  test('recall ranks a relevant entry', async () => {
    await tools.save(
      'deploy.md',
      '---\ndescription: where the project ships\n---\nDeploys to Fly region sin.',
    )
    const r = await tools.recall('where do we deploy the project')
    expect(r.isError).toBeUndefined()
    expect(r.text).toContain('deploy.md')
    expect(r.text).toContain('Fly')
  })

  test('search finds by substring', async () => {
    const r = await tools.search('terse')
    expect(r.text).toContain('prefs.md')
  })

  test('default namespace is used when none is given', async () => {
    const r = await tools.recall('terse answers')
    expect(r.text).toContain('user:me')
  })

  test('the secret scanner blocks a save with a credential', async () => {
    const r = await tools.save('leak.md', `token: ${FAKE.github}`)
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/secret/i)
  })

  test('what landed on disk is ciphertext, not plaintext', () => {
    const found: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else found.push(readFileSync(p, 'utf8'))
      }
    }
    walk(DATA_DIR)
    const blob = found.join('\n')
    expect(blob).not.toContain('prefers terse answers')
    expect(blob).not.toContain('Deploys to Fly')
  })

  test('delete removes an entry', async () => {
    await tools.delete('prefs.md')
    const list = await tools.list()
    expect(list.text).not.toContain('prefs.md')
  })
})

/**
 * AE7 (covers R12): a stale write is refused, the refusal tells the model what
 * moved and what to do, and the change it would have clobbered survives.
 *
 * Two real clients against the real in-process server, because the whole point
 * of the scenario is the base the client sent versus the manifest the server
 * holds; a stub would be asserting on a fixture of my own making.
 */
describe('AE7 stale write', () => {
  test("a save computed from a superseded read is refused, names the key, and B's write survives", async () => {
    const mk = () =>
      makeTools(
        new MemlawbClient({ url: `http://localhost:${server.port}`, passphrase: 'mcp-pass' }),
        'user:me',
      )
    const a = mk()
    const b = mk()

    expect((await a.save('ae7.md', 'shared note v1')).isError).toBeUndefined()
    // A reads, so its next write carries a base measured against this read.
    await a.search('shared note')
    // B commits a change to the same key underneath A.
    expect((await b.save('ae7.md', 'shared note v1\nB added a line')).isError).toBeUndefined()

    const stale = await a.save('ae7.md', 'shared note v1\nA added a line')
    expect(stale.isError).toBe(true)
    expect(stale.text).toContain('ae7.md')
    expect(stale.text).toContain('409 stale base')
    expect(stale.text).toMatch(/re-read/i)
    expect(stale.text).toContain('recall')
    // The refusal is written for a model, not a JSON dump of the response.
    expect(stale.text).not.toContain('{"error"')

    // B's line is still there: the refusal did not half-apply anything.
    expect((await b.recall('shared note')).text).toContain('B added a line')

    // A re-reads and reapplies on top of what is actually stored.
    const reread = await a.recall('shared note')
    expect(reread.text).toContain('B added a line')
    const retry = await a.save('ae7.md', 'shared note v1\nB added a line\nA added a line')
    expect(retry.isError).toBeUndefined()

    const final = (await b.recall('shared note')).text
    expect(final).toContain('B added a line')
    expect(final).toContain('A added a line')
  })
})

/**
 * The denial matrix. Each status is its own rule with its own control: the
 * assertion names the marker only that branch can produce, and then asserts the
 * other four markers are absent, so a branch that fell through to the generic
 * string or to a neighbouring branch is red rather than green.
 */
describe('denial rendering', () => {
  // Markers are chosen so the pre-change generic rendering (which wraps the raw
  // JSON body, and so contains the bare status number) carries none of them.
  const MARKERS = [
    '401 unauthorized',
    '403 forbidden',
    '409 stale base',
    '413 quota',
    '429 rate limited',
  ] as const
  // The sixth rule is not an HTTP status: a 2xx push that stored nothing. It
  // gets its own marker so a text that fell through to it (or out of it) is
  // red in both directions.
  const SKIPPED_MARKER = 'refused by the server'
  const only = (text: string, marker: (typeof MARKERS)[number]) => {
    expect(text).toContain(marker)
    for (const other of MARKERS) if (other !== marker) expect(text).not.toContain(other)
    expect(text).not.toContain(SKIPPED_MARKER)
  }
  const toolsWith = (error: unknown, ns = 'user:alice') => {
    const stub = new StubClient()
    stub.error = error
    return makeTools(stub, ns)
  }

  test('401 says the key was rejected and how to fix it', async () => {
    const r = await toolsWith(httpError(401, 'unauthorized')).save('k.md', 'body')
    expect(r.isError).toBe(true)
    only(r.text, '401 unauthorized')
    expect(r.text).toMatch(/API key/i)
    // The model cannot edit the server's environment or restart the process,
    // so telling it to do that leaves it with no move at all. Like the 429
    // text, this one has to hand the problem to the user.
    expect(r.text).toMatch(/tell the user/i)
    expect(r.text).not.toMatch(/start it again|restart/i)
  })

  test('403 names the authorized prefix and nothing belonging to another owner', async () => {
    const r = await toolsWith(httpError(403, 'forbidden')).save('k.md', 'body', 'user:bob/private')
    expect(r.isError).toBe(true)
    only(r.text, '403 forbidden')
    expect(r.text).toContain('user:alice')
    // Negative control: a text that echoed the attempted namespace would leak
    // another owner's name back into the model's context.
    expect(r.text).not.toContain('user:bob')
  })

  test('409 names the base the write was computed from, not only the current hash', async () => {
    // KTD3 asks for four things in the 409 text: the conflicting keys, the base
    // sent, the current hash and the recovery move. The base sent is the one a
    // server payload cannot supply, so it rides on the error from the client.
    const err = httpError(409, 'stale_base_version', {
      conflicts: { 'a.md': `sha256:${'c'.repeat(64)}` },
      sentBase: { 'a.md': `sha256:${'b'.repeat(64)}` },
    })
    const r = await toolsWith(err).save('a.md', 'body')
    expect(r.text).toContain(`sha256:${'b'.repeat(64)}`)
    expect(r.text).toContain(`sha256:${'c'.repeat(64)}`)
  })

  test('a 409 with no base sent still renders without inventing one', async () => {
    // A first write into a namespace this client never read sends no base at
    // all, so there is nothing to name and the text must not claim otherwise.
    const err = httpError(409, 'stale_base_version', {
      conflicts: { 'a.md': `sha256:${'c'.repeat(64)}` },
    })
    const r = await toolsWith(err).save('a.md', 'body')
    expect(r.text).toContain(`sha256:${'c'.repeat(64)}`)
    expect(r.text).not.toMatch(/computed against\s*[.,]/)
    expect(r.text).not.toContain('undefined')
  })

  test('a base recorded as absent is not rendered as a base that was sent', async () => {
    // baseFor writes null for a key this client has read the namespace but not
    // the key, so "computed against" has nothing to name. This is the case the
    // absent-sentBase test cannot reach: it returns at the type guard first.
    const err = httpError(409, 'stale_base_version', {
      conflicts: { 'a.md': `sha256:${'c'.repeat(64)}` },
      sentBase: { 'a.md': null },
    })
    const r = await toolsWith(err).save('a.md', 'body')
    expect(r.text).not.toContain('computed against')
    expect(r.text).toContain(`sha256:${'c'.repeat(64)}`)
  })

  test('a namespace the server cannot serve does not read as empty memory', async () => {
    // The fifth instance of this branch's recurring shape, and the one a model
    // acts on hardest: told its memory does not exist, it will happily save
    // over a namespace whose entries are merely unservable. A namespace never
    // written answers 404 empty at version 0; one whose manifest names entries
    // the store has lost answers 200 at a later version with nothing in it.
    //
    // Only the tools that read BODIES are blind to this. `list` reads the
    // manifest, so it still names the keys, which is the honest answer and is
    // asserted here so the fix is not applied where it does not belong.
    const drifted = {
      pull: async () => ({ namespace: 'user:d', version: 7, entries: {} }),
      hashes: async () => ({ 'a.md': `sha256:${'a'.repeat(64)}` }),
      entry: async () => 'x',
      push: async () => ({
        namespace: 'user:d',
        version: 7,
        uploaded: [],
        unchanged: [],
        deleted: [],
      }),
      delete: async () => {},
    }
    const t = makeTools(drifted as unknown as Parameters<typeof makeTools>[0], 'user:d')
    for (const r of [await t.recall('anything'), await t.search('anything')]) {
      expect(r.isError).toBe(true)
      expect(r.text).not.toMatch(/no memory stored|no matches/i)
      expect(r.text).toMatch(/could not serve|cannot serve/i)
    }
    expect((await t.list()).text).toContain('a.md')

    // Control: a genuinely empty namespace still reads as empty, so this
    // distinguishes the two rather than calling every empty read a failure.
    const fresh = {
      pull: async () => ({ namespace: 'user:f', version: 0, entries: {} }),
      hashes: async () => ({}),
      entry: async () => 'x',
      push: async () => ({
        namespace: 'user:f',
        version: 0,
        uploaded: [],
        unchanged: [],
        deleted: [],
      }),
      delete: async () => {},
    }
    const f = makeTools(fresh as unknown as Parameters<typeof makeTools>[0], 'user:f')
    const fr = await f.recall('anything')
    expect(fr.isError).toBeUndefined()
    expect(fr.text).toMatch(/no memory stored/i)
  })

  test('an unrecognized failure does not put an unbounded server body in the text', async () => {
    // The untyped fallback renders `(e as Error).message`, and an HTTP error's
    // message embeds the response body. Nothing bounded what a hostile or
    // broken server could put into a model's context through that path.
    const huge = new Error(`boom ${'A'.repeat(5000)}`)
    const r = await toolsWith(huge).save('k.md', 'body')
    expect(r.isError).toBe(true)
    expect(r.text.length).toBeLessThan(600)
    // Control: it still says something useful rather than swallowing the error.
    expect(r.text).toMatch(/boom/)
  })

  test('the authorized prefix is the owner root, not the configured namespace', async () => {
    // The guide and the setup card both tell a developer to run one namespace
    // per codebase, which is user:<owner>/<repo>, so the configured default is
    // routinely a child like user:alice/memlawb. Naming that as the prefix the
    // key may reach is false (the key reaches all of user:alice) and sends the
    // model to retarget inside a subtree narrower than the one it actually has.
    const tools = toolsWith(httpError(403, 'forbidden'), 'user:alice/memlawb')
    const r = await tools.save('k.md', 'body', 'user:bob/private')
    expect(r.text).toContain('user:alice')
    expect(r.text).not.toContain('user:alice/memlawb')
    expect(r.text).not.toContain('user:bob')
  })

  test('a refused delete does not claim nothing was stored', async () => {
    // The save wording ("Nothing was stored.") is wrong on the delete path:
    // the entry is still there, which is the opposite of what it reports.
    const r = await toolsWith(httpError(403, 'forbidden')).delete('k.md')
    expect(r.text).not.toContain('Nothing was stored')
    expect(r.text).toMatch(/still stored|nothing was deleted/i)
  })

  test('409 names the conflicting keys, the server hash, and the recovery move', async () => {
    const err = httpError(409, 'stale_base_version', {
      conflicts: { 'a.md': `sha256:${'a'.repeat(64)}`, 'b.md': null },
    })
    const r = await toolsWith(err).save('a.md', 'body')
    expect(r.isError).toBe(true)
    only(r.text, '409 stale base')
    expect(r.text).toContain('a.md')
    expect(r.text).toContain('b.md')
    expect(r.text).toContain(`sha256:${'a'.repeat(64)}`)
    expect(r.text).toContain('no entry')
    expect(r.text).toMatch(/re-read/i)
  })

  test('a 409 whose details are missing still renders the stale-base branch', async () => {
    const r = await toolsWith(httpError(409, 'stale_base_version')).save('a.md', 'body')
    only(r.text, '409 stale base')
    expect(r.text).toMatch(/did not name/i)
  })

  test('a 409 whose conflicts payload is malformed does not crash or leak junk', async () => {
    const err = httpError(409, 'stale_base_version', { conflicts: 'not-an-object' })
    const r = await toolsWith(err).save('a.md', 'body')
    only(r.text, '409 stale base')
    expect(r.text).toMatch(/did not name/i)
  })

  test('a quota refusal says what to do about storage', async () => {
    const err = httpError(413, 'namespace_too_large', { max_bytes: 5000 })
    const r = await toolsWith(err).save('k.md', 'body')
    expect(r.isError).toBe(true)
    only(r.text, '413 quota')
    expect(r.text).toContain('namespace_too_large')
    expect(r.text).toMatch(/delete or shorten/i)
  })

  test('429 says not to retry', async () => {
    const r = await toolsWith(httpError(429, 'rate_limited')).save('k.md', 'body')
    expect(r.isError).toBe(true)
    only(r.text, '429 rate limited')
    expect(r.text).toMatch(/do not retry/i)
  })

  test('the five denials are five distinct texts', async () => {
    // Set size alone is decoration here: five generic strings wrapping five
    // different JSON bodies are already distinct, so the baseline passes it.
    // Pairing each text with its own marker is what dies when two statuses
    // fall through to the same rendering.
    const texts = await Promise.all(
      [
        httpError(401, 'unauthorized'),
        httpError(403, 'forbidden'),
        httpError(409, 'stale_base_version', { conflicts: { 'a.md': null } }),
        httpError(413, 'namespace_too_large', { max_bytes: 1 }),
        httpError(429, 'rate_limited'),
      ].map(async e => (await toolsWith(e).save('k.md', 'body')).text),
    )
    expect(new Set(texts).size).toBe(5)
    for (const [i, text] of texts.entries()) only(text, MARKERS[i])
  })

  test('delete renders the same denials as save', async () => {
    const r = await toolsWith(httpError(403, 'forbidden')).delete('k.md', 'user:bob/private')
    expect(r.isError).toBe(true)
    only(r.text, '403 forbidden')
    expect(r.text).toContain('user:alice')
    expect(r.text).not.toContain('user:bob')
    expect(r.text).toContain('k.md')
  })

  test('a non-HTTP failure still falls through to the generic message', async () => {
    const r = await toolsWith(new Error('socket hang up')).save('k.md', 'body')
    expect(r.isError).toBe(true)
    expect(r.text).toContain('socket hang up')
    for (const m of MARKERS) expect(r.text).not.toContain(m)
  })

  test('an unmapped status renders generically rather than as one of the five', async () => {
    const r = await toolsWith(httpError(503, 'manifest_unreadable')).save('k.md', 'body')
    expect(r.isError).toBe(true)
    for (const m of MARKERS) expect(r.text).not.toContain(m)
  })

  test('a successful save is not rendered as a denial', async () => {
    const r = await makeTools(new StubClient(), 'user:alice').save('k.md', 'body')
    expect(r.isError).toBeUndefined()
    for (const m of MARKERS) expect(r.text).not.toContain(m)
  })

  test('a 403 against a namespace no key can reach does not promise a subtree', async () => {
    // authorizeNamespace grants a non-local owner user:<owner> and its children
    // and nothing else, so when the configured namespace is agent:/repo:-scoped
    // there is no reachable subtree to retarget into. Saying otherwise sends
    // the model to retry somewhere it can never get to.
    const r = await toolsWith(httpError(403, 'forbidden'), 'agent:intern').save('k.md', 'body')
    expect(r.isError).toBe(true)
    only(r.text, '403 forbidden')
    expect(r.text).toContain('agent:intern')
    expect(r.text).not.toMatch(/may only reach agent:intern/)
    expect(r.text).not.toMatch(/Retarget/)
    expect(r.text).toMatch(/tell the user/i)
    expect(r.text).toContain('user:')
  })

  test('recall renders the typed denial rather than the raw response body', async () => {
    const r = await toolsWith(httpError(403, 'forbidden')).recall('anything', 'user:bob/private')
    expect(r.isError).toBe(true)
    only(r.text, '403 forbidden')
    expect(r.text).toContain('user:alice')
    expect(r.text).not.toContain('user:bob')
    expect(r.text).not.toContain('{"error"')
    // The save wording is wrong on a read: nothing was being stored.
    expect(r.text).not.toContain('Nothing was stored')
  })

  test('search renders the typed denial rather than the raw response body', async () => {
    const r = await toolsWith(httpError(429, 'rate_limited')).search('anything')
    expect(r.isError).toBe(true)
    only(r.text, '429 rate limited')
    expect(r.text).toMatch(/do not retry/i)
    expect(r.text).not.toContain('{"error"')
    expect(r.text).not.toContain('Nothing was stored')
  })

  test('list renders the typed denial rather than the raw response body', async () => {
    const r = await toolsWith(httpError(401, 'unauthorized')).list()
    expect(r.isError).toBe(true)
    only(r.text, '401 unauthorized')
    expect(r.text).toMatch(/tell the user/i)
    expect(r.text).not.toContain('{"error"')
    expect(r.text).not.toContain('Nothing was stored')
  })

  test('a read failure that is not a typed refusal still falls through', async () => {
    const r = await toolsWith(new Error('socket hang up')).recall('anything')
    expect(r.isError).toBe(true)
    expect(r.text).toContain('socket hang up')
    for (const m of MARKERS) expect(r.text).not.toContain(m)
  })
})

/**
 * A 2xx push that stored nothing. The server answers 200 and lists the refused
 * key in `skipped`, so a tool that reads only `uploaded` reports a denial as
 * "saved" or "unchanged" and the model believes its memory landed.
 */
describe('a refused entry inside a successful push', () => {
  const withRefusal = (key: string, reason: string) => {
    const stub = new StubClient()
    stub.refuse[key] = reason
    return { stub, tools: makeTools(stub, 'user:alice') }
  }

  test('an oversized entry is a failure naming the size move, not a save', async () => {
    const { stub, tools } = withRefusal('big.md', 'entry_too_large')
    const r = await tools.save('big.md', 'body')
    expect(r.isError).toBe(true)
    expect(r.text).toContain('big.md')
    expect(r.text).toContain('entry_too_large')
    expect(r.text).toContain('refused by the server')
    expect(r.text).toMatch(/split|less content/i)
    // Neither the loud lie nor the quiet one.
    expect(r.text).not.toMatch(/\bsaved\b/)
    expect(r.text).not.toMatch(/\bunchanged\b/)
    // And the claim matches the store: nothing landed.
    expect(stub.entries['big.md']).toBeUndefined()
  })

  test('an invalid key is a failure naming a different key as the move', async () => {
    const { tools } = withRefusal('../escape.md', 'invalid_key')
    const r = await tools.save('../escape.md', 'body')
    expect(r.isError).toBe(true)
    expect(r.text).toContain('invalid_key')
    expect(r.text).toMatch(/entry key/i)
    // The oversize move is the wrong advice here: shortening a bad path does
    // not make it valid.
    expect(r.text).not.toMatch(/split/i)
    expect(r.text).not.toMatch(/\bsaved\b/)
  })

  test("a push that refused a different key does not swallow this key's save", async () => {
    // Negative control for the lookup: the tool must match the key it sent,
    // not merely notice that `skipped` is non-empty.
    const { stub, tools } = withRefusal('other.md', 'entry_too_large')
    const r = await tools.save('mine.md', 'body')
    expect(r.isError).toBeUndefined()
    expect(r.text).toContain('saved')
    expect(r.text).not.toContain('refused by the server')
    expect(stub.entries['mine.md']).toBe('body')
  })

  test('a plain save is still reported as saved', async () => {
    const { tools } = withRefusal('other.md', 'entry_too_large')
    const r = await tools.save('fine.md', 'body')
    expect(r.text).toContain('saved "fine.md" in user:alice')
  })

  test('the real server refusing an oversized entry is not reported as saved', async () => {
    // The double is mine; this one is the shipped contract. MAX_ENTRY_BYTES
    // defaults to 250_000, and the per-entry check runs before any namespace
    // byte cap, so an oversized entry comes back skipped inside a 200.
    const client = new MemlawbClient({
      url: `http://localhost:${server.port}`,
      passphrase: 'mcp-pass',
    })
    const real = makeTools(client, 'user:me/skipped')
    const r = await real.save('big.md', 'x'.repeat(300_000))
    expect(r.isError).toBe(true)
    expect(r.text).toContain('big.md')
    expect(r.text).toContain('entry_too_large')
    expect(r.text).not.toMatch(/\bsaved\b/)
    expect(r.text).not.toMatch(/\bunchanged\b/)
    // And the server really is empty, so the refusal is not a mislabelled write.
    expect((await real.list()).text).not.toContain('big.md')
  })
})
