import { chmod, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileWriter, writeFileAtomic } from '../src/file-writer.ts'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ima-test-'))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('writeFileAtomic', () => {
  it('replaces the file, keeps its mode and leaves no temp file', async () => {
    const path = join(dir, 'a.md')
    await writeFile(path, 'old')
    await chmod(path, 0o600)
    await writeFileAtomic(path, 'new')
    expect(await readFile(path, 'utf8')).toBe('new')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readdir(dir)).toEqual(['a.md'])
  })
})

describe('FileWriter', () => {
  it('debounces writes to the latest content', async () => {
    vi.useFakeTimers()
    const path = join(dir, 'a.md')
    await writeFile(path, 'v0')
    const writer = new FileWriter(path, 'v0', 1000)
    writer.schedule('v1')
    await vi.advanceTimersByTimeAsync(500)
    writer.schedule('v2')
    await vi.advanceTimersByTimeAsync(500)
    expect(await readFile(path, 'utf8')).toBe('v0')
    await vi.advanceTimersByTimeAsync(500)
    await writer.flush()
    expect(await readFile(path, 'utf8')).toBe('v2')
  })

  it('flush writes immediately', async () => {
    const path = join(dir, 'a.md')
    await writeFile(path, 'v0')
    const writer = new FileWriter(path, 'v0', 60_000)
    writer.schedule('v1')
    await writer.flush()
    expect(await readFile(path, 'utf8')).toBe('v1')
    expect(writer.lastWritten).toBe('v1')
  })
})
