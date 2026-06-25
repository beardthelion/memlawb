import { describe, expect, test } from 'bun:test'
import { InvalidNameError, validateEntryKey, validateNamespace } from '../src/namespace.ts'

describe('namespace validation', () => {
  test('accepts valid namespaces', () => {
    for (const ns of ['user:alice', 'repo:gitlawb/node', 'agent:intern', 'user:9f3a-bc']) {
      expect(validateNamespace(ns)).toBe(ns)
    }
  })

  test('rejects traversal and junk', () => {
    for (const ns of ['../etc', 'user:../x', 'nope', 'user:a//b', 'USER:alice', '']) {
      expect(() => validateNamespace(ns)).toThrow(InvalidNameError)
    }
  })
})

describe('entry-key validation (path traversal)', () => {
  test('accepts memdir-style keys', () => {
    for (const k of ['MEMORY.md', 'feedback/testing.md', 'a/b/c.md']) {
      expect(validateEntryKey(k)).toBe(k)
    }
  })

  test('rejects traversal, absolute, backslash, NUL', () => {
    for (const k of [
      '../secret',
      '/etc/passwd',
      'a/../b',
      'a\\b',
      'a\0b',
      '/leading',
      'trailing/',
    ]) {
      expect(() => validateEntryKey(k)).toThrow(InvalidNameError)
    }
  })
})
