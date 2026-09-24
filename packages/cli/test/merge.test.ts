import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { mergeExternalEdit } from '../src/merge.ts'

function textOf(content: string): Y.Text {
  const doc = new Y.Doc()
  const text = doc.getText('content')
  text.insert(0, content)
  return text
}

describe('mergeExternalEdit', () => {
  it('applies the edit when nothing else changed', () => {
    const text = textOf('# title\n\nbody\n')
    mergeExternalEdit(text, '# title\n\nbody\n', '# Title\n\nbody\nmore\n', 'file')
    expect(text.toString()).toBe('# Title\n\nbody\nmore\n')
  })

  it('keeps remote edits made elsewhere in the document', () => {
    const base = 'one\ntwo\nthree\n'
    const text = textOf(base)
    text.insert(0, 'zero\n') // remote edit, not yet on disk
    mergeExternalEdit(text, base, 'one\ntwo\nthree\nfour\n', 'file')
    expect(text.toString()).toBe('zero\none\ntwo\nthree\nfour\n')
  })

  it('keeps both sides when they touch the same line', () => {
    const base = 'hello world\n'
    const text = textOf(base)
    text.insert(5, ',') // remote: "hello, world"
    mergeExternalEdit(text, base, 'hello world!\n', 'file')
    expect(text.toString()).toBe('hello, world!\n')
  })

  it('lets an external deletion remove the region it replaced', () => {
    const base = 'a\nb\nc\n'
    const text = textOf(base)
    text.insert(0, 'x') // remote
    mergeExternalEdit(text, base, 'a\nc\n', 'file')
    expect(text.toString()).toBe('xa\nc\n')
  })

  it('tags the transaction with the given origin', () => {
    const text = textOf('a')
    const origins: unknown[] = []
    text.doc?.on('update', (_u: Uint8Array, origin: unknown) => origins.push(origin))
    mergeExternalEdit(text, 'a', 'ab', 'file')
    expect(origins).toEqual(['file'])
  })
})
