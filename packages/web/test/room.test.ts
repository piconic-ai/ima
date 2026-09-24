import { describe, expect, it } from 'vitest'
import { parseRoomLocation, participants, roomSocketUrl } from '../src/room.ts'

const id = 'AAAAAAAAAAAAAAAAAAAAAA'
const key = 'k'.repeat(43)

describe('parseRoomLocation', () => {
  it('reads the id from the path and the key from the fragment', () => {
    expect(parseRoomLocation({ pathname: `/r/${id}`, hash: `#${key}` })).toEqual({ id, key })
  })

  it('rejects links without a valid key or id', () => {
    expect(parseRoomLocation({ pathname: `/r/${id}`, hash: '' })).toBeNull()
    expect(parseRoomLocation({ pathname: `/r/${id}`, hash: '#short' })).toBeNull()
    expect(parseRoomLocation({ pathname: '/r/bad', hash: `#${key}` })).toBeNull()
    expect(parseRoomLocation({ pathname: '/', hash: `#${key}` })).toBeNull()
  })
})

describe('roomSocketUrl', () => {
  it('builds a key-free WebSocket URL on the same host', () => {
    expect(roomSocketUrl({ protocol: 'https:', host: 'ima.piconic.ai' }, id)).toBe(
      `wss://ima.piconic.ai/api/rooms/${id}/ws`,
    )
    expect(roomSocketUrl({ protocol: 'http:', host: 'localhost:8787' }, id)).toBe(
      `ws://localhost:8787/api/rooms/${id}/ws`,
    )
  })
})

describe('participants', () => {
  it('lists the host first, then self, and reads names from either shape', () => {
    const states = new Map<number, Record<string, unknown>>([
      [1, { user: { name: 'Bob', color: '#000' } }],
      [2, { user: { name: 'Me', color: '#111' } }],
      [3, { role: 'host', name: 'alice' }],
      [4, {}],
    ])
    const list = participants(states, 2)
    expect(list.map((p) => p.name)).toEqual(['alice', 'Me', 'Bob', 'anonymous'])
    expect(list[0]?.isHost).toBe(true)
    expect(list[1]?.isSelf).toBe(true)
  })
})
