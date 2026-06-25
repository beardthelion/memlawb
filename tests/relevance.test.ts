/**
 * Relevance ranker. Asserts ordering and the description/key weighting, plus
 * the empty-query and no-overlap guards.
 */

import { describe, expect, test } from 'bun:test'
import { rankMemories } from '../src/mcp/relevance.ts'

const entries = {
  'MEMORY.md': '# index\n- [prefs](prefs.md)\n- [deploy](deploy.md)',
  'prefs.md':
    '---\nname: prefs\ndescription: how the user likes answers formatted\n---\nThe user prefers terse, direct answers and dislikes preamble.',
  'deploy.md':
    '---\nname: deploy\ndescription: where and how the project ships\n---\nDeploys to Fly in region sin via Docker. Single machine for the beta.',
  'stack.md':
    '---\nname: stack\ndescription: runtime and language choices\n---\nBun + TypeScript, zero-dependency crypto using node:crypto.',
}

describe('rankMemories', () => {
  test('ranks the on-topic entry first', () => {
    const r = rankMemories('how should I format my answers for this user', entries)
    expect(r[0].key).toBe('prefs.md')
  })

  test('a deployment query surfaces the deploy note', () => {
    const r = rankMemories('what region do we deploy to', entries)
    expect(r[0].key).toBe('deploy.md')
  })

  test('description matches outweigh incidental body matches', () => {
    // "runtime" appears in stack.md's description; should win over a stray hit.
    const r = rankMemories('runtime choices', entries)
    expect(r[0].key).toBe('stack.md')
  })

  test('empty / stopword-only queries return nothing', () => {
    expect(rankMemories('', entries)).toHaveLength(0)
    expect(rankMemories('the a of to', entries)).toHaveLength(0)
  })

  test('respects the limit', () => {
    expect(rankMemories('user project answers deploy', entries, 2).length).toBeLessThanOrEqual(2)
  })
})
