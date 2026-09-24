import { Hono } from 'hono'

export { Room } from './room.ts'

// 128-bit random ids, base64url without padding.
const ROOM_ID = /^[A-Za-z0-9_-]{22}$/

export function newRoomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

const app = new Hono<{ Bindings: Env }>()

app.post('/api/rooms', (c) => c.json({ id: newRoomId() }, 201))

app.get('/api/rooms/:id/ws', (c) => {
  const id = c.req.param('id')
  if (!ROOM_ID.test(id)) return c.text('invalid room id', 400)
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    return c.text('expected a WebSocket upgrade', 426)
  }
  const room = c.env.ROOM.get(c.env.ROOM.idFromName(id))
  return room.fetch(c.req.raw)
})

export default app
