/**
 * Every bare import in shipped code is a declared dependency.
 *
 * `src/mcp/server.ts` imported `zod` for a long time while only the MCP SDK was
 * declared. It resolved anyway, because npm and Bun hoist a transitive
 * dependency to the top of `node_modules` where a bare specifier finds it. That
 * is not a guarantee: a stricter installer does not hoist, and the day the SDK
 * drops or renames its own dependency the import breaks for consumers while
 * every gate in this repo stays green, because this repo's own install still
 * has the package.
 *
 * It is the shape of bug that only ever appears in someone else's project,
 * which is why it needs a test here rather than a note.
 */

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const SHIPPED = ['src', 'client', 'bin']

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...sourceFiles(p))
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

/** Bare specifiers only: a relative path is this repo's own code. */
function bareImports(src: string): string[] {
  const out: string[] = []
  for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'".][^'"]*)['"]/g)) {
    const spec = m[1] as string
    if (spec.startsWith('node:') || spec.startsWith('bun:')) continue
    // A subpath import still resolves against the package name.
    out.push(
      spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : (spec.split('/')[0] as string),
    )
  }
  return out
}

describe('shipped code declares what it imports', () => {
  test('every bare import is in dependencies, not merely hoisted', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const declared = new Set(Object.keys(pkg.dependencies ?? {}))

    const used = new Map<string, string>()
    for (const dir of SHIPPED) {
      for (const file of sourceFiles(join(ROOT, dir))) {
        for (const spec of bareImports(readFileSync(file, 'utf8'))) {
          if (!used.has(spec)) used.set(spec, file.slice(ROOT.length + 1))
        }
      }
    }

    // Positive control: the walk actually found the imports it claims to check.
    // Without this the assertion below holds just as well over an empty set.
    expect(used.has('@modelcontextprotocol/sdk')).toBe(true)

    const undeclared = [...used].filter(([spec]) => !declared.has(spec))
    expect(undeclared.map(([spec, file]) => `${spec} (imported by ${file})`)).toEqual([])
  })
})
