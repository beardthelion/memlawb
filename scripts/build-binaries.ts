/**
 * Standalone binaries, for a machine with neither Bun nor Node.
 *
 * `bun build --compile` bakes the runtime in, so these are the only artifact
 * that needs no install of anything. They are large (tens of MB each) because
 * of that; that is the trade, not a defect.
 *
 * Why this is not a plain `bun build --compile` in the release workflow: the
 * compiled binary embeds `src/mcp/guide.ts`, which reads SKILL.md from a path
 * relative to its own module. Inside a binary that path does not exist, so the
 * MCP server silently served a short inline fallback instead of the memory
 * protocol, with save and recall working fine and nothing reporting anything.
 * Measured before this script existed: 1153 bytes of fallback against 5671 of
 * guide. So the compile reuses the same inlining the Node build does.
 *
 * Run: bun run scripts/build-binaries.ts [outdir]
 */

import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inlineGuide, resolvedGuide } from './guide-inline.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outdir = process.argv[2] ?? join(root, 'binaries')

/**
 * The platforms a release ships. Kept here rather than in the workflow so the
 * list is one thing, and so a local run produces what CI produces.
 */
const TARGETS = [
  'bun-linux-x64',
  'bun-linux-arm64',
  'bun-linux-x64-musl',
  'bun-linux-arm64-musl',
  'bun-darwin-x64',
  'bun-darwin-arm64',
  'bun-windows-x64',
] as const

await rm(outdir, { recursive: true, force: true })
await mkdir(outdir, { recursive: true })

const guide = resolvedGuide()
const only = process.env.BINARY_TARGETS?.split(',').filter(Boolean)
const targets = only?.length ? TARGETS.filter(t => only.includes(t)) : TARGETS

for (const target of targets) {
  const name = `memlawb-${target.replace(/^bun-/, '')}${target.includes('windows') ? '.exe' : ''}`
  const outfile = join(outdir, name)
  const built = await Bun.build({
    entrypoints: [join(root, 'bin/memlawb.ts')],
    target: 'bun',
    compile: { target, outfile },
    minify: true,
    plugins: [inlineGuide(guide)],
  })
  if (!built.success) {
    for (const log of built.logs) console.error(log)
    throw new Error(`build: ${target} failed`)
  }
  console.log(`built ${name}`)
}

// Checksums beside the binaries: a downloaded binary is the one artifact a user
// cannot inspect before running.
const sums =
  await Bun.$`sh -c 'cd ${outdir} && sha256sum memlawb-* 2>/dev/null || shasum -a 256 memlawb-*'`
    .quiet()
    .text()
await Bun.write(join(outdir, 'SHA256SUMS'), sums)
console.log(sums.trim())
