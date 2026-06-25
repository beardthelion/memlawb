/**
 * Authorization isolation tests. These guard the one rule that separates
 * tenants — a regression here is a cross-tenant data leak, so the cases are
 * deliberately adversarial (substring collisions, sibling prefixes, traversal).
 */

import { describe, expect, test } from 'bun:test'
import { authorizeNamespace } from '../src/auth.ts'

const id = (owner: string) => ({ owner })

describe('authorizeNamespace — tenant isolation', () => {
  test('owner reaches their own user subtree', () => {
    expect(authorizeNamespace(id('alice'), 'user:alice')).toBe(true)
    expect(authorizeNamespace(id('alice'), 'user:alice/projects')).toBe(true)
    expect(authorizeNamespace(id('alice'), 'user:alice/a/b')).toBe(true)
  })

  test('substring-colliding owner ids cannot cross over', () => {
    // The old `includes()` rule let "ab" reach anything containing "ab".
    expect(authorizeNamespace(id('ab'), 'user:abc')).toBe(false)
    expect(authorizeNamespace(id('ab'), 'repo:lab/node')).toBe(false)
    expect(authorizeNamespace(id('ab'), 'user:xab')).toBe(false)
    expect(authorizeNamespace(id('alice'), 'user:alice-evil')).toBe(false)
  })

  test('one owner cannot touch another owner', () => {
    expect(authorizeNamespace(id('alice'), 'user:bob')).toBe(false)
    expect(authorizeNamespace(id('alice'), 'user:bob/secret')).toBe(false)
  })

  test('non-user namespaces are denied without an ACL grant', () => {
    expect(authorizeNamespace(id('alice'), 'repo:alice/node')).toBe(false)
    expect(authorizeNamespace(id('alice'), 'agent:alice')).toBe(false)
  })

  test('local (self-host open mode) owns everything', () => {
    expect(authorizeNamespace(id('local'), 'user:anyone')).toBe(true)
    expect(authorizeNamespace(id('local'), 'repo:x/y')).toBe(true)
  })
})
