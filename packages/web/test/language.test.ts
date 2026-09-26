import { describe, expect, it } from 'vitest'
import { type Language, resolveLanguage } from '../src/language.ts'

function nameOf(lang: Language): string {
  return lang.kind === 'lazy' ? lang.description.name : lang.kind
}

describe('resolveLanguage', () => {
  it.each([
    ['notes.md', 'markdown'],
    ['NOTES.MD', 'markdown'],
    ['data.csv', 'plain'],
    ['data.tsv', 'plain'],
    ['notes.txt', 'plain'],
    ['board.canvas', 'JSON'],
    ['main.go', 'Go'],
    ['Main.GO', 'Go'],
    ['config.json', 'JSON'],
    ['notes', 'markdown'],
    ['notes.unknownext', 'markdown'],
    ['notes.constructor', 'markdown'],
    ['', 'markdown'],
    [undefined, 'markdown'],
  ])('%s -> %s', (file, expected) => {
    expect(nameOf(resolveLanguage(file))).toBe(expected)
  })

  it('looks only at the base name', () => {
    expect(nameOf(resolveLanguage('dir.go/notes'))).toBe('markdown')
    expect(nameOf(resolveLanguage('docs/main.go'))).toBe('Go')
  })
})
