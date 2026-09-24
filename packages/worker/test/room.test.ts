import { exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { roomIdFor } from '../src/index.ts'
import { MAX_MESSAGE_BYTES, MAX_PEERS } from '../src/room.ts'

const ROOM_CLOSED = 4001

interface Room {
  id: string
  hostToken: string
}

async function createRoom(): Promise<Room> {
  const res = await exports.default.fetch('https://ima.test/api/rooms', { method: 'POST' })
  expect(res.status).toBe(201)
  return res.json<Room>()
}

interface Peer {
  ws: WebSocket
  received: ArrayBuffer[]
  closed: Promise<CloseEvent>
}

function upgrade(id: string, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(`https://ima.test/api/rooms/${id}/ws`, {
    headers: { Upgrade: 'websocket', ...headers },
  })
}

async function connect(id: string, headers: Record<string, string> = {}): Promise<Peer> {
  const res = await upgrade(id, headers)
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

const host = (room: Room) => connect(room.id, { Authorization: `Bearer ${room.hostToken}` })

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10))
  expect(check()).toBe(true)
}

describe('rooms', () => {
  it('issues unguessable room ids derived from the host token', async () => {
    const a = await createRoom()
    const b = await createRoom()
    expect(a.id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(a.hostToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(a.id).toBe(await roomIdFor(a.hostToken))
    expect(a.id).not.toBe(b.id)
  })

  it('rejects malformed ids, plain requests and wrong host tokens', async () => {
    expect((await exports.default.fetch('https://ima.test/api/rooms/nope/ws')).status).toBe(400)
    const room = await createRoom()
    expect((await exports.default.fetch(`https://ima.test/api/rooms/${room.id}/ws`)).status).toBe(
      426,
    )
    const other = await createRoom()
    const res = await upgrade(room.id, { Authorization: `Bearer ${other.hostToken}` })
    expect(res.status).toBe(403)
  })

  it('relays binary frames to everyone but the sender', async () => {
    const room = await createRoom()
    const a = await host(room)
    const b = await connect(room.id)
    const c = await connect(room.id)
    a.ws.send(new Uint8Array([1, 2, 3]))
    await until(() => b.received.length === 1 && c.received.length === 1)
    expect([...new Uint8Array(b.received[0] ?? new ArrayBuffer(0))]).toEqual([1, 2, 3])
    expect(a.received).toHaveLength(0)
    b.ws.send(new Uint8Array([4]))
    await until(() => a.received.length === 1)
  })

  it('keeps rooms isolated', async () => {
    const one = await createRoom()
    const two = await createRoom()
    const a = await host(one)
    const other = await host(two)
    const b = await connect(two.id)
    a.ws.send(new Uint8Array([9]))
    await new Promise((r) => setTimeout(r, 50))
    expect(other.received).toHaveLength(0)
    expect(b.received).toHaveLength(0)
  })

  it('turns guests away while there is no host', async () => {
    const room = await createRoom()
    const guest = await connect(room.id)
    expect((await guest.closed).code).toBe(ROOM_CLOSED)
  })

  it('ignores a role header sent by a client', async () => {
    const room = await createRoom()
    const guest = await connect(room.id, { 'X-Ima-Host': '1' })
    expect((await guest.closed).code).toBe(ROOM_CLOSED)
  })

  it('closes the room for everyone when the host leaves', async () => {
    const room = await createRoom()
    const h = await host(room)
    const a = await connect(room.id)
    const b = await connect(room.id)
    h.ws.close(1000, 'bye')
    expect((await a.closed).code).toBe(ROOM_CLOSED)
    expect((await b.closed).code).toBe(ROOM_CLOSED)
    const late = await connect(room.id)
    expect((await late.closed).code).toBe(ROOM_CLOSED)
  })

  it('stays open while a reconnected host is still there', async () => {
    const room = await createRoom()
    const stale = await host(room)
    await host(room)
    const guest = await connect(room.id)
    stale.ws.close(1000, 'replaced')
    await new Promise((r) => setTimeout(r, 50))
    guest.ws.send(new Uint8Array([1]))
    const closedEarly = await Promise.race([
      guest.closed.then(() => true),
      new Promise((r) => setTimeout(() => r(false), 50)),
    ])
    expect(closedEarly).toBe(false)
  })

  it('closes sockets that send text or oversized frames', async () => {
    const room = await createRoom()
    await host(room)
    const text = await connect(room.id)
    text.ws.send('hello')
    expect((await text.closed).code).toBe(1003)

    const big = await connect(room.id)
    big.ws.send(new Uint8Array(MAX_MESSAGE_BYTES + 1))
    expect((await big.closed).code).toBe(1009)
  })

  it('caps the number of peers', async () => {
    const room = await createRoom()
    await host(room)
    for (let i = 1; i < MAX_PEERS; i++) await connect(room.id)
    expect((await upgrade(room.id)).status).toBe(429)
  })
})
