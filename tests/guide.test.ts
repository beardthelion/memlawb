/**
 * The memory guide must load from the canonical SKILL.md (frontmatter stripped)
 * so the MCP prompt and the Claude Code skill never drift.
 */

import { describe, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FALLBACK, loadMemoryGuide, SHORT_INSTRUCTIONS } from '../src/mcp/guide.ts'

/** Both surfaces are hard-wrapped, so assert on the text, not the line breaks. */
const flat = (t: string) => t.replace(/\s+/g, ' ')

describe('memory guide', () => {
  test('loads the SKILL.md body, not its frontmatter', () => {
    const g = loadMemoryGuide()
    expect(g.length).toBeGreaterThan(200)
    expect(g).toContain('Recall first')
    expect(g).toContain('Save what')
    // Frontmatter delimiters and the name: line must be stripped.
    expect(g.startsWith('---')).toBe(false)
    expect(g).not.toContain('name: memlawb-memory')
  })

  test('short instructions steer recall-first / save-durable', () => {
    expect(SHORT_INSTRUCTIONS).toContain('memory_recall')
    expect(SHORT_INSTRUCTIONS).toContain('memory_save')
    expect(SHORT_INSTRUCTIONS).toContain('memory_guide')
  })
})

describe('retention note (R27, U10)', () => {
  // On fs and s3 a delete erases. On the node driver it does not: prior
  // ciphertext stays in repository history and in any pin already taken. The
  // guide is static and serves every deployment, so it must not claim either
  // outcome. What it can do is tell the model the delete response is where the
  // answer is, so it never reports "deleted" as "gone" on a store that retains.
  test('the guide says deletion may not erase, and points at the delete response', () => {
    const g = flat(loadMemoryGuide()).toLowerCase()
    expect(g).toContain('not every deployment can erase')
    expect(g).toContain('memory_delete')
  })

  test('the guide does not promise erasure', () => {
    // The control that matters. A guide asserting deletion removes the data
    // would be false on the node driver, which is the exact false promise R27
    // exists to stop.
    const g = flat(loadMemoryGuide()).toLowerCase()
    expect(g).not.toContain('permanently deletes')
    expect(g).not.toContain('erases it from the server')
  })

  test('the fallback carries the note too, so a broken guide load still warns', () => {
    // guide.ts falls back to an inline copy when SKILL.md cannot be read, and
    // that path is silent by design. A fallback without the note would drop the
    // warning exactly when something is already wrong.
    expect(flat(FALLBACK).toLowerCase()).toContain('not every deployment can erase')
  })
})

describe('memory routing rule', () => {
  // Three independent rules, three controls. Asserting one shared substring
  // would prove nothing about the other two clauses.
  test('the guide sends durable cross-machine facts to memlawb', () => {
    expect(flat(loadMemoryGuide())).toContain('durable facts that must survive across machines')
  })

  test('the guide sends the session log to the host agent local memdir', () => {
    const g = flat(loadMemoryGuide())
    expect(g).toContain("The host agent's local memdir")
    expect(g).toContain('the session log')
  })

  test('the guide sends repo-shared facts to team memory', () => {
    const g = flat(loadMemoryGuide())
    expect(g).toContain('Team memory')
    expect(g).toContain('repo-shared facts')
  })

  test('the short instructions carry all three clauses in one sentence', () => {
    const sentence = flat(SHORT_INSTRUCTIONS)
      .split('. ')
      .find(s => s.includes('memlawb takes'))
    expect(sentence).toBeDefined()
    expect(sentence).toContain('durable facts that must survive across machines')
    expect(sentence).toContain('local memdir keeps the session log')
    expect(sentence).toContain('team memory')
  })

  // The three clauses above only name the categories. What resolves the case
  // this feature exists for is the tie-breaker, and it used to live in SKILL.md
  // alone: the full guide reaches the model only if it chooses to call the
  // memory_guide prompt, and nothing forces it. SHORT_INSTRUCTIONS is in
  // context on every session, so a model that never calls the prompt was left
  // with three categories and no way to pick between two of them.
  const TIE_BREAKER =
    'ask who needs it: you on every machine, this session only, or everyone on the repository'

  test('the short instructions carry the tie-breaker, not just the categories', () => {
    expect(flat(SHORT_INSTRUCTIONS)).toContain(TIE_BREAKER)
  })

  test('the fallback carries the tie-breaker too', () => {
    expect(flat(FALLBACK)).toContain(TIE_BREAKER)
  })

  test('the fallback carries the rule too, so a failed read still routes', () => {
    const f = flat(FALLBACK)
    expect(f).toContain('durable facts that must survive across machines')
    expect(f).toContain('local memdir keeps the session log')
    expect(f).toContain('team memory')
  })
})

describe('namespace convention', () => {
  test('the guide pins namespaces to the owner authorized subtree', () => {
    const g = flat(loadMemoryGuide())
    expect(g).toContain('grants an owner `user:<owner>` and its children')
  })

  test('the guide asks for one namespace per codebase', () => {
    const g = flat(loadMemoryGuide())
    expect(g).toContain('one namespace per codebase')
    expect(g).toContain('`user:<owner>/<repo>`')
  })
})

describe('guide source controls', () => {
  // The trap this control exists for: the routing rule is deliberately in BOTH
  // SKILL.md and FALLBACK, so every assertion above passes whether or not the
  // file was ever read, and broken path resolution would ship unnoticed. These
  // markers exist only in SKILL.md, so they go red the moment the fallback is
  // what got served.
  test('the loaded guide is the file, not the inline fallback', () => {
    const g = flat(loadMemoryGuide())
    const f = flat(FALLBACK)
    expect(loadMemoryGuide()).not.toBe(FALLBACK)
    for (const marker of [
      'Trust but verify',
      'Entry-key conventions',
      'one namespace per codebase',
      'For a fact that seems to fit two of them',
    ])
      expect(`${marker}: guide=${g.includes(marker)} fallback=${f.includes(marker)}`).toBe(
        `${marker}: guide=true fallback=false`,
      )
  })

  test('a missing SKILL.md falls back to the inline text', async () => {
    // guide.ts resolves SKILL.md relative to its own file and imports nothing
    // from this repo, so a copy in a temp tree with no skills/ directory
    // exercises the missing-file path for real rather than by stubbing.
    const dir = mkdtempSync(join(tmpdir(), 'memlawb-guide-'))
    mkdirSync(join(dir, 'src', 'mcp'), { recursive: true })
    const copy = join(dir, 'src', 'mcp', 'guide.ts')
    copyFileSync(fileURLToPath(new URL('../src/mcp/guide.ts', import.meta.url)), copy)
    const mod = await import(copy)
    expect(mod.loadMemoryGuide()).toBe(mod.FALLBACK)
    expect(flat(mod.loadMemoryGuide())).toContain('durable facts that must survive across machines')
    rmSync(dir, { recursive: true, force: true })
  })
})
