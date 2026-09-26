import { safeAvatar } from './identity.ts'

export interface RoomLocation {
  id: string
  key: string
}

/** Reads `/r/<id>#<key>`. The key lives only in the fragment, which browsers never send. */
export function parseRoomLocation(loc: { pathname: string; hash: string }): RoomLocation | null {
  const match = /^\/r\/([A-Za-z0-9_-]{22})\/?$/.exec(loc.pathname)
  const key = loc.hash.replace(/^#/, '')
  if (!match?.[1] || !/^[A-Za-z0-9_-]{43}$/.test(key)) return null
  return { id: match[1], key }
}

export function roomSocketUrl(loc: { protocol: string; host: string }, id: string): string {
  const scheme = loc.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${loc.host}/api/rooms/${id}/ws`
}

export interface Participant {
  clientId: number
  name: string
  color: string
  /** Only from hosts we allow; see safeAvatar. */
  avatar?: string
  isHost: boolean
  isSelf: boolean
}

type State = { [key: string]: unknown }

export function participants(states: Map<number, State>, selfId: number): Participant[] {
  const list: Participant[] = []
  for (const [clientId, state] of states) {
    const user = (state.user ?? {}) as { name?: unknown; color?: unknown; avatar?: unknown }
    const name = typeof user.name === 'string' ? user.name : state.name
    const isHost = state.role === 'host'
    const avatar = safeAvatar(user.avatar)
    list.push({
      clientId,
      name: typeof name === 'string' && name ? name : 'anonymous',
      color: typeof user.color === 'string' ? user.color : isHost ? '#1f7a64' : '#7a828d',
      ...(avatar && { avatar }),
      isHost,
      isSelf: clientId === selfId,
    })
  }
  return list.sort(
    (a, b) => Number(b.isHost) - Number(a.isHost) || Number(b.isSelf) - Number(a.isSelf),
  )
}

const COLORS = [
  '#1f7a64',
  '#d96b12',
  '#4254b5',
  '#b5427a',
  '#6b8e23',
  '#8a4fbf',
  '#c0392b',
  '#1d7fa6',
]

export function colorFor(seed: number): string {
  return COLORS[Math.abs(seed) % COLORS.length] ?? '#4254b5'
}
