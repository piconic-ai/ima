import { afterEach, describe, expect, it, vi } from 'vitest'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { generateKey, importKey, RoomClient, type SocketLike } from '../src/index.ts'

/** An in-memory stand-in for the Worker: relays every frame to all other sockets. */
class Relay {
  sockets = new Set<FakeSocket>()
  frames: Uint8Array[] = []
  create = (_url: string): SocketLike => {
    const socket = new FakeSocket(this)
    this.sockets.add(socket)
    queueMicrotask(() => {
      socket.readyState = 1
      socket.onopen?.({})
    })
    return socket
  }
}

class FakeSocket implements SocketLike {
  binaryType = 'blob'
  readyState = 0
  onopen: SocketLike['onopen'] = null
  onmessage: SocketLike['onmessage'] = null
  onclose: SocketLike['onclose'] = null
  onerror: SocketLike['onerror'] = null
  constructor(private relay: Relay) {}
  send(data: Uint8Array) {
    this.relay.frames.push(data)
    for (const peer of this.relay.sockets) {
      if (peer !== this && peer.readyState === 1) {
        const copy = data.slice().buffer
        queueMicrotask(() => peer.onmessage?.({ data: copy }))
      }
    }
  }
  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    this.relay.sockets.delete(this)
    queueMicrotask(() => this.onclose?.({}))
  }
}

const clients: RoomClient[] = []
afterEach(async () => {
  for (const c of clients.splice(0)) await c.destroy()
})

async function join(relay: Relay, key: CryptoKey, init?: string, state?: Record<string, unknown>) {
  const doc = new Y.Doc()
  if (init) doc.getText('content').insert(0, init)
  const awareness = new Awareness(doc)
  if (state) awareness.setLocalState(state)
  const client = new RoomClient({
    url: 'ws://test',
    key,
    doc,
    awareness,
    createSocket: relay.create,
  })
  clients.push(client)
  client.connect()
  return client
}

const text = (c: RoomClient) => c.doc.getText('content').toString()

describe('RoomClient', () => {
  it('gives a late joiner the full document', async () => {
    const relay = new Relay()
    const key = await importKey(generateKey())
    const host = await join(relay, key, '# notes\n')
    await vi.waitFor(() => expect(host.status).toBe('connected'))
    const guest = await join(relay, key)
    await vi.waitFor(() => expect(text(guest)).toBe('# notes\n'))
  })

  it('syncs concurrent edits both ways', async () => {
    const relay = new Relay()
    const key = await importKey(generateKey())
    const a = await join(relay, key, 'hello')
    const b = await join(relay, key)
    await vi.waitFor(() => expect(text(b)).toBe('hello'))
    a.doc.getText('content').insert(0, 'A')
    b.doc.getText('content').insert(5, 'B')
    await vi.waitFor(() => {
      expect(text(a)).toBe(text(b))
      expect(text(a)).toContain('A')
      expect(text(a)).toContain('B')
    })
  })

  it('pushes offline edits of a reconnecting host', async () => {
    const relay = new Relay()
    const key = await importKey(generateKey())
    const guest = await join(relay, key)
    await join(relay, key, 'written before anyone joined')
    await vi.waitFor(() => expect(text(guest)).toBe('written before anyone joined'))
  })

  it('shares awareness with newcomers and clears it on leave', async () => {
    const relay = new Relay()
    const key = await importKey(generateKey())
    const host = await join(relay, key, '', { role: 'host' })
    await vi.waitFor(() => expect(host.status).toBe('connected'))
    const guest = await join(relay, key, '', { name: 'guest' })
    await vi.waitFor(() => {
      expect(guest.awareness.getStates().get(host.doc.clientID)).toEqual({ role: 'host' })
      expect(host.awareness.getStates().get(guest.doc.clientID)).toEqual({ name: 'guest' })
    })
    await host.destroy()
    await vi.waitFor(() => expect(guest.awareness.getStates().has(host.doc.clientID)).toBe(false))
  })

  it('sends only ciphertext over the wire', async () => {
    const relay = new Relay()
    const key = await importKey(generateKey())
    await join(relay, key, 'top secret plaintext')
    const b = await join(relay, key)
    await vi.waitFor(() => expect(text(b)).toBe('top secret plaintext'))
    const wire = relay.frames.map((f) => new TextDecoder().decode(f)).join('')
    expect(wire).not.toContain('top secret')
  })

  it('ignores peers using a different key', async () => {
    const relay = new Relay()
    const errors: unknown[] = []
    const a = await join(relay, await importKey(generateKey()), 'mine')
    const doc = new Y.Doc()
    const b = new RoomClient({
      url: 'ws://test',
      key: await importKey(generateKey()),
      doc,
      awareness: new Awareness(doc),
      createSocket: relay.create,
      onError: (e) => errors.push(e),
    })
    clients.push(b)
    b.connect()
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0))
    expect(text(b)).toBe('')
    expect(text(a)).toBe('mine')
  })

  it('reconnects after the socket drops', async () => {
    const relay = new Relay()
    const key = await importKey(generateKey())
    const a = await join(relay, key, 'x')
    await vi.waitFor(() => expect(a.status).toBe('connected'))
    for (const s of relay.sockets) s.close()
    await vi.waitFor(() => expect(a.status).toBe('disconnected'))
    await vi.waitFor(() => expect(a.status).toBe('connected'), { timeout: 3000 })
  })
})
