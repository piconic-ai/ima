import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importKey, RoomClient } from '@ima/protocol'
import { Relay } from '@ima/protocol/testing'
import { describe, expect, it, vi } from 'vitest'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { startSession } from '../src/session.ts'

async function setup(content: string) {
  const dir = await mkdtemp(join(tmpdir(), 'ima-test-'))
  const file = join(dir, 'notes.md')
  await writeFile(file, content)
  const relay = new Relay()
  const requests: string[] = []
  const fakeFetch = (async (input: string | URL | Request) => {
    requests.push(String(input))
    return Response.json({ id: 'AAAAAAAAAAAAAAAAAAAAAA' }, { status: 201 })
  }) as typeof fetch
  const session = await startSession({
    file,
    server: 'http://localhost:8787/',
    writeDelayMs: 20,
    fetch: fakeFetch,
    createSocket: relay.create,
  })
  return { file, relay, requests, session }
}

async function joinAsGuest(relay: Relay, shareUrl: string) {
  const key = new URL(shareUrl).hash.slice(1)
  const doc = new Y.Doc()
  const guest = new RoomClient({
    url: 'ws://guest',
    key: await importKey(key),
    doc,
    awareness: new Awareness(doc),
    createSocket: relay.create,
  })
  guest.connect()
  return guest
}

describe('startSession', () => {
  it('prints a share URL whose key never reaches the server', async () => {
    const { relay, requests, session } = await setup('# hi')
    const url = new URL(session.url)
    expect(url.origin).toBe('http://localhost:8787')
    expect(url.pathname).toBe('/r/AAAAAAAAAAAAAAAAAAAAAA')
    const key = url.hash.slice(1)
    expect(key).toHaveLength(43)
    expect(requests).toEqual(['http://localhost:8787/api/rooms'])
    await vi.waitFor(() => expect(relay.urls).toHaveLength(1))
    expect(relay.urls[0]).toBe('ws://localhost:8787/api/rooms/AAAAAAAAAAAAAAAAAAAAAA/ws')
    for (const u of [...requests, ...relay.urls]) expect(u).not.toContain(key)
    await session.stop()
  })

  it('serves the file to a guest and writes their edits back', async () => {
    const { file, relay, session } = await setup('# notes\n')
    const guest = await joinAsGuest(relay, session.url)
    const text = guest.doc.getText('content')
    await vi.waitFor(() => expect(text.toString()).toBe('# notes\n'))
    text.insert(text.length, '- from guest\n')
    await vi.waitFor(async () =>
      expect(await readFile(file, 'utf8')).toBe('# notes\n- from guest\n'),
    )
    await guest.destroy()
    await session.stop()
  })

  it('writes the final state on stop', async () => {
    const { file, relay, session } = await setup('a')
    const guest = await joinAsGuest(relay, session.url)
    const text = guest.doc.getText('content')
    await vi.waitFor(() => expect(text.toString()).toBe('a'))
    text.insert(1, 'b')
    await vi.waitFor(() => expect(session.doc.getText('content').toString()).toBe('ab'))
    await session.stop()
    expect(await readFile(file, 'utf8')).toBe('ab')
    await guest.destroy()
  })

  it('announces itself as host', async () => {
    const { relay, session } = await setup('')
    const guest = await joinAsGuest(relay, session.url)
    await vi.waitFor(() => {
      const states = [...guest.awareness.getStates().values()]
      expect(states.some((s) => s.role === 'host')).toBe(true)
    })
    await guest.destroy()
    await session.stop()
  })
})
