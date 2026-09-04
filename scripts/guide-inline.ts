/**
 * Inlining SKILL.md into a build, shared by the Node bundle and the binaries.
 *
 * `src/mcp/guide.ts` finds the guide by walking up from its own module path and
 * falls back to a short inline copy when the read fails. Every packaged form
 * moves or removes that path, so every packaged form needs this: measured, an
 * uninlined compiled binary served 1153 bytes of fallback while save and recall
 * worked perfectly and nothing reported a thing.
 *
 * It lives in its own module because a build script that imports another build
 * script runs it.
 */

import type { BunPlugin } from 'bun'
import { FALLBACK, loadMemoryGuide } from '../src/mcp/guide.ts'

/** The literal in guide.ts that gets rewritten; see the comment on it there. */
const GUIDE_SLOT = "const INLINED_GUIDE = ''"

/** The guide text to inline, refusing the fallback rather than shipping it. */
export function resolvedGuide(): string {
  const text = loadMemoryGuide()
  if (text === FALLBACK) throw new Error('build: refusing to inline the fallback guide')
  return text
}

/**
 * Rewrites guide.ts on its way into a bundle so the built server serves
 * SKILL.md's text. Throws rather than degrading: a silent fallback is exactly
 * the failure this exists to prevent.
 */
export function inlineGuide(text: string): BunPlugin {
  return {
    name: 'inline-memory-guide',
    setup(build) {
      build.onLoad({ filter: /src[/\\]mcp[/\\]guide\.ts$/ }, async ({ path }) => {
        const src = await Bun.file(path).text()
        if (!src.includes(GUIDE_SLOT)) throw new Error(`build: guide slot not found in ${path}`)
        return {
          contents: src.replace(GUIDE_SLOT, `const INLINED_GUIDE = ${JSON.stringify(text)}`),
          loader: 'ts',
        }
      })
    },
  }
}
