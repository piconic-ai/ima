import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { MAX_MESSAGE_BYTES, MAX_PEERS } from '../src/room.ts'

async function createRoom(): Promise<string> {
  const res = await SELF.fetch('https://ima.test/api/rooms', { method: 'POST' })
  expect(res.status).toBe(201)
  const { id } = await res.json<{ id: string }>()
  return id
}

interface Peer {
  ws: WebSocket
  received: ArrayBuffer[]
  closed: Promise<CloseEvent>
}

async function connect(id: string): Promise<Peer> {
  const res = await SELF.fetch(`https://ima.test/api/rooms/${id}/ws`, {
    headers: { Upgrade: 'websocket' },
  })
  expect(res.status).toBe(101)
  const ws = res.webSocket
  if (!ws) throw new Error('no websocket')
  const received: ArrayBuffer[] = []
  const closed = new Promise<CloseEvent>((resolve) => ws.addEventListener('close', resolve))
  ws.addEventListener('message', (ev) => {
    if (ev.data instanceof ArrayBuffer) received.push(ev.data)
  })
  ws.binaryType = 'arraybuffer'
  ws.accept()
  return { ws, received, closed }
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10))
  expect(check()).toBe(true)
}

describe('rooms', () => {
  it('issues unguessable room ids', async () => {
    const a = await createRoom()
    const b = await createRoom()
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(a).not.toBe(b)
  })

  it('rejects malformed ids and plain requests', async () => {
    expect((await SELF.fetch('https://ima.test/api/rooms/nope/ws')).status).toBe(400)
    const id = await createRoom()
    expect((await SELF.fetch(`https://ima.test/api/rooms/${id}/ws`)).status).toBe(426)
  })

  it('relays binary frames to everyone but the sender', async () => {
    const id = await createRoom()
    const a = await connect(id)
    const b = await connect(id)
    const c = await connect(id)
    a.ws.send(new Uint8Array([1, 2, 3]))
    await until(() => b.received.length === 1 && c.received.length === 1)
    expect([...new Uint8Array(b.received[0] ?? new ArrayBuffer(0))]).toEqual([1, 2, 3])
    expect(a.received).toHaveLength(0)
  })

  it('keeps rooms isolated', async () => {
    const a = await connect(await createRoom())
    const other = await connect(await createRoom())
    const b = await connect(await createRoom())
    a.ws.send(new Uint8Array([9]))
    await new Promise((r) => setTimeout(r, 50))
    expect(other.received).toHaveLength(0)
    expect(b.received).toHaveLength(0)
  })

  it('closes sockets that send text or oversized frames', async () => {
    const id = await createRoom()
    const text = await connect(id)
    text.ws.send('hello')
    expect((await text.closed).code).toBe(1003)

    const big = await connect(id)
    big.ws.send(new Uint8Array(MAX_MESSAGE_BYTES + 1))
    expect((await big.closed).code).toBe(1009)
  })

  it('caps the number of peers', async () => {
    const id = await createRoom()
    for (let i = 0; i < MAX_PEERS; i++) await connect(id)
    const res = await SELF.fetch(`https://ima.test/api/rooms/${id}/ws`, {
      headers: { Upgrade: 'websocket' },
    })
    expect(res.status).toBe(429)
  })
})
