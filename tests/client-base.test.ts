/**
 * The client's half of the write precondition.
 *
 * The server refuses a write whose base disagrees with the manifest, but that
 * is worth nothing until a client sends one. The subtlety is which read fills
 * the base: `push` performs its own hashes call immediately before the PUT, so
 * a base taken from there is milliseconds old and guards a window that barely
 * exists. The window that matters is the caller's own turn, so only reads the
 * caller asked for fill the map.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { namespaceSlug } from '../src/namespace.ts'
import { _reset } from '../src/ratelimit.ts'
import { contentPath, getStore, manifestPath } from '../src/store/index.ts'

let server: ReturnType<typeof Bun.serve>
let base: string
let MemlawbClient: typeof import('../client/index.ts').MemlawbClient
let MemlawbHttpError: typeof import('../client/index.ts').MemlawbHttpError
let MemlawbDecryptError: typeof import('../client/index.ts').MemlawbDecryptError

beforeAll(async () => {
  const { handleRequest } = await import('../src/handler.ts')
  ;({ MemlawbClient, MemlawbHttpError, MemlawbDecryptError } = await import('../client/index.ts'))
  server = Bun.serve({ port: 0, fetch: handleRequest })
  base = `http://localhost:${server.port}`
})
afterAll(() => server?.stop(true))
afterEach(() => _reset())

const client = () => new MemlawbClient({ url: base, passphrase: 'pw' })

/** A server that answers every request with one canned refusal. */
function denyingServer(status: number, code: string) {
  return Bun.serve({
    port: 0,
    fetch: () =>
      new Response(JSON.stringify({ error: { code, message: 'nope' } }), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  })
}

describe('base carriage', () => {
  test('a push from a stale read is refused, and the competing write survives', async () => {
    const ns = 'user:cb-stale'
    const a = client()
    const b = client()
    await a.push(ns, { 'a.md': 'v1' })

    // A reads. This is the read its edit is based on.
    await a.pull(ns)
    // B writes underneath it.
    await b.push(ns, { 'a.md': 'from-b' })

    const err = await a.push(ns, { 'a.md': 'from-a' }).catch(e => e)
    expect(err).toBeInstanceOf(MemlawbHttpError)
    expect((err as InstanceType<typeof MemlawbHttpError>).code).toBe('stale_base_version')
    expect((await b.pull(ns)).entries['a.md']).toBe('from-b')
  })

  test('re-reading before the push makes it succeed', async () => {
    const ns = 'user:cb-fresh'
    const a = client()
    const b = client()
    await a.push(ns, { 'a.md': 'v1' })
    await a.pull(ns)
    await b.push(ns, { 'a.md': 'from-b' })

    // Control for the test above: the only difference is this re-read.
    await a.pull(ns)
    await a.push(ns, { 'a.md': 'from-a' })
    expect((await b.pull(ns)).entries['a.md']).toBe('from-a')
  })

  test('a first write into a namespace this client never read still succeeds', async () => {
    const ns = 'user:cb-new'
    await client().push(ns, { 'a.md': 'first' })
    expect((await client().pull(ns)).entries['a.md']).toBe('first')
  })

  test('a delete after a foreign change is refused, and succeeds after a re-read', async () => {
    const ns = 'user:cb-del'
    const a = client()
    const b = client()
    await a.push(ns, { 'a.md': 'v1' })
    await a.pull(ns)
    await b.push(ns, { 'a.md': 'moved' })

    const err = await a.delete(ns, 'a.md').catch(e => e)
    expect(err).toBeInstanceOf(MemlawbHttpError)
    expect((err as InstanceType<typeof MemlawbHttpError>).code).toBe('stale_base_version')

    await a.pull(ns)
    await a.delete(ns, 'a.md')
    expect(Object.keys((await b.pull(ns)).entries)).toEqual([])
  })

  test("push's own pre-flight read does not refresh the base it is meant to check", async () => {
    // The whole point. If the internal hashes call filled the map, the base
    // would always be current and the refusal above could never fire.
    const ns = 'user:cb-preflight'
    const a = client()
    const b = client()
    await a.push(ns, { 'a.md': 'v1' })
    await a.pull(ns)
    await b.push(ns, { 'a.md': 'from-b' })
    // A push whose only read of this namespace since is push's own internal one.
    const err = await a.push(ns, { 'a.md': 'from-a' }).catch(e => e)
    expect(err).toBeInstanceOf(MemlawbHttpError)
  })
})

describe('typed refusals', () => {
  test('each refusal surfaces its status and code', async () => {
    for (const [status, code] of [
      [401, 'unauthorized'],
      [403, 'forbidden'],
      [413, 'namespace_too_large'],
      [429, 'rate_limited'],
    ] as const) {
      const s = denyingServer(status, code)
      const c = new MemlawbClient({ url: `http://localhost:${s.port}`, passphrase: 'pw' })
      const err = await c.pull('user:x').catch(e => e)
      s.stop(true)
      expect(err).toBeInstanceOf(MemlawbHttpError)
      expect((err as InstanceType<typeof MemlawbHttpError>).status).toBe(status)
      expect((err as InstanceType<typeof MemlawbHttpError>).code).toBe(code)
    }
  })

  test('a 404 that is not the server saying empty is an error, not an empty namespace', async () => {
    // The denial-rendered-as-success shape: a wrong URL or a proxy 404 must not
    // reach a caller as a successful read of nothing.
    const s = denyingServer(404, 'not_found')
    const c = new MemlawbClient({ url: `http://localhost:${s.port}`, passphrase: 'pw' })
    const err = await c.pull('user:x').catch(e => e)
    s.stop(true)
    expect(err).toBeInstanceOf(MemlawbHttpError)

    // Control: the server's own empty response still reads as an empty namespace.
    const fresh = await client().pull('user:cb-never-written')
    expect(fresh.entries).toEqual({})
  })

  test('a stale-write refusal carries the base this client actually sent', async () => {
    // KTD3 asks the 409 text to name the base sent alongside the current hash.
    // The server's payload only reports what each key holds NOW, so without
    // this the client is the only party that knows what it wrote against and
    // the information is lost at the throw.
    const a = client()
    const b = client()
    const ns = 'user:cb-sentbase'

    await a.push(ns, { 'x.md': 'one' })
    await a.pull(ns)
    const stale = (await a.hashes(ns))['x.md']
    await b.pull(ns)
    await b.push(ns, { 'x.md': 'two' })

    const err = await a.push(ns, { 'x.md': 'three' }).catch(e => e)
    expect(err).toBeInstanceOf(MemlawbHttpError)
    expect(err.status).toBe(409)
    expect(err.details?.sentBase).toEqual({ 'x.md': stale })
  })

  test('a no-op push reads once and reports that read version', async () => {
    // push already reads the namespace to compute the delta, and that read
    // carries the version. Asking again was a second round trip on the most
    // common write an agent makes (re-saving a fact that has not changed), and
    // the second read had its own 404 rule that returned version 0 for any
    // 404, turning a denial into a successful no-op write.
    let hits = 0
    const s = Bun.serve({
      port: 0,
      fetch: () => {
        hits += 1
        return new Response(JSON.stringify({ version: 7, entryChecksums: {}, supports: [] }), {
          headers: { 'content-type': 'application/json' },
        })
      },
    })
    const c = new MemlawbClient({ url: `http://localhost:${s.port}`, passphrase: 'pw' })
    const r = await c.push('user:x', {})
    s.stop(true)
    expect(hits).toBe(1)
    expect(r.version).toBe(7)
  })

  test('a pull of an empty namespace enumerates it, so a create asserts absence', async () => {
    // A pull is normally not authoritative, because getData silently skips an
    // entry whose blob is missing and a drifted key must not be asserted
    // absent. The server's own `empty` answer is the one exception: it means no
    // manifest exists at all, so there is nothing to drift and the namespace is
    // genuinely empty. Without this, a create after pulling an empty namespace
    // sends no base and silently overwrites whatever landed in between.
    const ns = 'user:cb-empty-enum'
    const a = client()
    const b = client()
    expect(await a.pull(ns)).toMatchObject({ entries: {} })

    await b.push(ns, { 'k.md': 'from b' })
    const err = await a.push(ns, { 'k.md': 'from a' }).catch(e => e)
    expect(err).toBeInstanceOf(MemlawbHttpError)
    expect(err.status).toBe(409)

    // Control: b's write survived, so the refusal protected it rather than
    // failing for some unrelated reason.
    expect((await b.pull(ns)).entries['k.md']).toBe('from b')
  })

  test('the same rule holds on the hashes path, which has its own guard', async () => {
    // pull and the hashes view each decide what a 404 means, so each needs
    // covering; a fix applied to one is not a fix applied to both.
    const s = denyingServer(404, 'not_found')
    const c = new MemlawbClient({ url: `http://localhost:${s.port}`, passphrase: 'pw' })
    const err = await c.hashes('user:x').catch(e => e)
    s.stop(true)
    expect(err).toBeInstanceOf(MemlawbHttpError)

    // Control: a namespace the real server has never seen still reads as empty.
    expect(await client().hashes('user:cb-hashes-empty')).toEqual({})
  })
})

describe('precondition advertisement', () => {
  test('a server that does not advertise it is reported as not enforcing', async () => {
    const s = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify({ version: 1, entryChecksums: {}, erasure: 'erases' }), {
          headers: { 'content-type': 'application/json' },
        }),
    })
    const c = new MemlawbClient({ url: `http://localhost:${s.port}`, passphrase: 'pw' })
    expect(await c.preconditionEnforced('user:x')).toBe(false)
    s.stop(true)

    // Control: the real server does advertise it.
    expect(await client().preconditionEnforced('user:cb-adv')).toBe(true)
  })
})

// ─── The observed-map rework ────────────────────────────────────────────
//
// The map used to conflate three states into one: never read, read-and-present,
// read-and-absent. Presence of the map meant "read" and a missing key meant
// "absent". Each test below pins one consequence of splitting that apart into
// a key->hash map plus whether the source enumerated the namespace.

/** A server that answers every request with one canned body, verbatim. */
function rawServer(status: number, body: string, contentType = 'application/json') {
  return Bun.serve({
    port: 0,
    fetch: () => new Response(body, { status, headers: { 'content-type': contentType } }),
  })
}

describe('observed knowledge', () => {
  test('a key whose blob is missing is not locked out of every future write', async () => {
    // getData skips an entry whose blob has gone (manifest/blob drift) and does
    // not populate entryChecksums for it either, so a pull cannot learn the key
    // exists at all. Treating pull as authoritative made the client assert the
    // key absent, and the server refused that base forever.
    const ns = 'user:cb-drift'
    const a = client()
    await a.push(ns, { 'a.md': 'v1' })

    const slug = namespaceSlug(ns)
    const raw = await getStore().get(manifestPath(slug))
    const manifest = JSON.parse(new TextDecoder().decode(raw as Uint8Array)) as {
      entries: Record<string, { hash: string }>
    }
    await getStore().delete(contentPath(slug, manifest.entries['a.md'].hash))

    // Confirm the drift actually landed: a plant that did not apply would make
    // the rest of this test prove nothing.
    expect((await a.pull(ns)).entries).toEqual({})

    await a.push(ns, { 'a.md': 'v2' })
    expect((await a.pull(ns)).entries['a.md']).toBe('v2')
  })

  test('a hashes read enumerates, so a key it did not name is asserted absent', async () => {
    // Deliberate, and flagged in review as possibly over-broad: hashes returns
    // no content, but its checksums ARE the manifest's and the base IS a
    // ciphertext hash, so for this purpose the read is exact.
    const ns = 'user:cb-enum-hashes'
    const a = client()
    const b = client()
    expect(await a.hashes(ns)).toEqual({})
    await b.push(ns, { 'x.md': 'from-b' })

    const err = await a.push(ns, { 'x.md': 'from-a' }).catch(e => e)
    expect(err).toBeInstanceOf(MemlawbHttpError)
    expect((err as InstanceType<typeof MemlawbHttpError>).code).toBe('stale_base_version')
    expect((await b.pull(ns)).entries['x.md']).toBe('from-b')
  })

  test('a pull does not enumerate, so a key it did not return is left unasserted', async () => {
    // The negative half of the rule above, and the reason the drift test can
    // pass: a pull of a namespace that HAS entries carries positive knowledge
    // only, because getData drops an entry whose blob is missing and the client
    // cannot tell that from a key that was never there. The empty-namespace
    // case is the documented exception and is covered separately.
    const ns = 'user:cb-enum-pull'
    const a = client()
    const b = client()
    await a.push(ns, { 'seed.md': 'seed' })
    expect(Object.keys((await a.pull(ns)).entries)).toEqual(['seed.md'])

    await b.pull(ns)
    await b.push(ns, { 'x.md': 'from-b' })

    // a never saw x.md, and cannot honestly claim it does not exist, so the
    // write is unconditional rather than refused.
    await a.push(ns, { 'x.md': 'from-a' })
    expect((await b.pull(ns)).entries['x.md']).toBe('from-a')
  })

  test('a write into a never-read namespace arms the precondition for the next one', async () => {
    // The whole feature failing: record used to no-op when no map existed, so a
    // write-only client never got a base and its second push clobbered whatever
    // had landed in between.
    const ns = 'user:cb-writeonly'
    const a = client()
    const b = client()
    await a.push(ns, { 'k.md': 'one' })

    await b.pull(ns)
    await b.push(ns, { 'k.md': 'from-b' })

    const err = await a.push(ns, { 'k.md': 'two' }).catch(e => e)
    expect(err).toBeInstanceOf(MemlawbHttpError)
    expect((err as InstanceType<typeof MemlawbHttpError>).code).toBe('stale_base_version')
    expect((await b.pull(ns)).entries['k.md']).toBe('from-b')
  })

  test('a key this client created is armed even though the read never saw it', async () => {
    // Isolates the written fold from the map-creation branch above: a map
    // already exists here (the pull made one), so only folding the written hash
    // in can arm the second push.
    const ns = 'user:cb-created'
    const a = client()
    const b = client()
    expect((await a.pull(ns)).entries).toEqual({})
    await a.push(ns, { 'k.md': 'mine' })

    await b.pull(ns)
    await b.push(ns, { 'k.md': 'from-b' })

    const err = await a.push(ns, { 'k.md': 'mine-again' }).catch(e => e)
    expect(err).toBeInstanceOf(MemlawbHttpError)
    expect((err as InstanceType<typeof MemlawbHttpError>).code).toBe('stale_base_version')
    expect((await b.pull(ns)).entries['k.md']).toBe('from-b')
  })

  test('a deleted key is dropped from the map, so recreating it is unconditional', async () => {
    // The other fold in record. Left in the map, the stale hash becomes the base
    // for the recreate and the server refuses a write nothing is racing.
    const ns = 'user:cb-recreate'
    const a = client()
    await a.push(ns, { 'k.md': 'one' })
    await a.pull(ns)
    await a.delete(ns, 'k.md')

    await a.push(ns, { 'k.md': 'again' })
    expect((await a.pull(ns)).entries['k.md']).toBe('again')
  })

  test('a delete of a key observed absent asserts that absence', async () => {
    // DELETE's base rides the query string and the server spells it only as
    // sha256:<hex>, so this one has to route through PUT to carry a JSON null.
    const ns = 'user:cb-del-absent'
    const a = client()
    const b = client()
    expect(await a.hashes(ns)).toEqual({})
    await b.push(ns, { 'k.md': 'from-b' })

    const err = await a.delete(ns, 'k.md').catch(e => e)
    expect(err).toBeInstanceOf(MemlawbHttpError)
    expect((err as InstanceType<typeof MemlawbHttpError>).code).toBe('stale_base_version')
    // The refusal has to actually protect the entry, not merely be thrown.
    expect((await b.pull(ns)).entries['k.md']).toBe('from-b')
  })

  test('the observed doc comment describes the model the code implements', async () => {
    // Finding 4 was a comment claiming writes filled the map while record
    // returned early without them. The comment is the only place the enumerated
    // distinction is explained, so it is pinned rather than left to drift.
    const src = await Bun.file(new URL('../client/index.ts', import.meta.url)).text()
    const doc = src.slice(0, src.indexOf('private readonly observed'))
    const block = doc.slice(doc.lastIndexOf('/**'))
    expect(block).toContain('enumerat')
    expect(block).toContain('hashes')
    expect(block).toContain('pull')
  })
})

describe('error text', () => {
  test('a non-JSON error body reaches the caller instead of rendering empty', async () => {
    // httpError used to call res.text() on a body res.json() had consumed, so
    // the fallback always produced '' and the caller got a bare status.
    const s = rawServer(502, 'upstream said no', 'text/plain')
    const c = new MemlawbClient({ url: `http://localhost:${s.port}`, passphrase: 'pw' })
    const err = await c.pull('user:x').catch(e => e)
    s.stop(true)
    expect(err).toBeInstanceOf(MemlawbHttpError)
    expect((err as Error).message).toContain('upstream said no')
  })

  test('server text is bounded before it reaches the caller', async () => {
    // This message is rendered into a model's context by the MCP tools, so a
    // hostile or broken server must not be able to put a megabyte of
    // instructions there.
    const nasty = `IGNORE PREVIOUS ${'A'.repeat(5000)}`
    const s = rawServer(500, JSON.stringify({ error: { code: 'boom', details: { raw: nasty } } }))
    const c = new MemlawbClient({ url: `http://localhost:${s.port}`, passphrase: 'pw' })
    const err = (await c.pull('user:x').catch(e => e)) as InstanceType<typeof MemlawbHttpError>
    s.stop(true)
    expect(err.message.length).toBeLessThanOrEqual(300)
    // Structured fields are the machine-readable half and stay verbatim, so the
    // bound cannot be met by throwing the server's answer away.
    expect(err.code).toBe('boom')
    expect((err.details as { raw: string }).raw).toBe(nasty)
  })

  test('control characters and escape sequences are stripped from server text', async () => {
    // Its own rule and its own control: JSON escapes a control character to
    // inert text, so only a non-JSON body carries real ones, and that is
    // exactly the body the text branch handles.
    const s = rawServer(500, '\u001b[31mred\u001b[0m\nboom\u0007', 'text/plain')
    const c = new MemlawbClient({ url: `http://localhost:${s.port}`, passphrase: 'pw' })
    const err = (await c.pull('user:x').catch(e => e)) as InstanceType<typeof MemlawbHttpError>
    s.stop(true)
    // Non-vacuous: a message that lost the whole body would pass every
    // not-toContain below.
    expect(err.message).toContain('boom')
    expect(err.message).not.toContain('\u001b')
    expect(err.message).not.toContain('[31m')
    expect(err.message).not.toContain('\u0007')
    expect(err.message).not.toContain('\n')
  })

  test('an ordinary short error body survives sanitising intact', async () => {
    // Negative control: a sanitiser that returned '' would pass both tests
    // above and lose every real diagnostic.
    const s = rawServer(500, JSON.stringify({ error: { code: 'boom', message: 'disk full' } }))
    const c = new MemlawbClient({ url: `http://localhost:${s.port}`, passphrase: 'pw' })
    const err = await c.pull('user:x').catch(e => e)
    s.stop(true)
    expect((err as Error).message).toContain('disk full')
    expect((err as Error).message).toContain('500')
  })
})

describe('what the server actually accepted', () => {
  test('a skipped entry is reported and kept out of uploaded', async () => {
    const ns = 'user:cb-skipped'
    const a = client()
    const r = await a.push(ns, { 'good.md': 'g', '../evil.md': 'e' })
    expect(r.skipped).toEqual([{ key: '../evil.md', reason: 'invalid_key' }])
    expect(r.uploaded).toEqual(['good.md'])
  })

  test('a skipped entry does not poison the base for the next write', async () => {
    // Recording a hash for content the server never stored makes the next write
    // for that same key send a base for something that does not exist, and the
    // server refuses it. Re-pushing the key is the only path that consults it:
    // baseFor only covers the keys a write touches, so pushing some OTHER key
    // afterwards would look fine while the refused one stayed locked out.
    const ns = 'user:cb-skipped-base'
    const a = client()
    await a.push(ns, { 'good.md': 'g', '../evil.md': 'e' })

    const again = await a.push(ns, { '../evil.md': 'e2' })
    expect(again.skipped).toEqual([{ key: '../evil.md', reason: 'invalid_key' }])
    // And the namespace is still writable for the key that did land.
    await a.push(ns, { 'good.md': 'g2' })
    expect((await a.pull(ns)).entries['good.md']).toBe('g2')
  })
})

describe('typed decrypt failure', () => {
  test('a wrong passphrase is a decrypt error naming the entry, not a transport error', async () => {
    const ns = 'user:cb-decrypt'
    await client().push(ns, { 'a.md': 'secret' })
    const wrong = new MemlawbClient({ url: base, passphrase: 'not-the-passphrase' })

    const err = await wrong.pull(ns).catch(e => e)
    expect(err).toBeInstanceOf(MemlawbDecryptError)
    expect((err as InstanceType<typeof MemlawbDecryptError>).entryKey).toBe('a.md')
    expect((err as Error).message).toContain('a.md')
  })

  test('a transport failure is not reported as a decrypt error', async () => {
    // Negative control: the distinction is the point, so a class that captured
    // every failure would be worth nothing.
    const s = denyingServer(500, 'internal')
    const c = new MemlawbClient({ url: `http://localhost:${s.port}`, passphrase: 'pw' })
    const err = await c.pull('user:x').catch(e => e)
    s.stop(true)
    expect(err).not.toBeInstanceOf(MemlawbDecryptError)
    expect(err).toBeInstanceOf(MemlawbHttpError)
  })
})
