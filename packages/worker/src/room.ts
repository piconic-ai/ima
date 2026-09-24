import { DurableObject } from 'cloudflare:workers'
import { ROOM_CLOSED } from '@ima/protocol/close'

export const MAX_PEERS = 32
export const MAX_MESSAGE_BYTES = 1024 * 1024
/** Set by the Worker (never by clients) on the host's upgrade request. */
export const HOST_HEADER = 'X-Ima-Host'

const HOST_TAG = 'host'

/**
 * A room relays encrypted frames between its peers. It never parses or stores them;
 * it cannot, since it never sees the key.
 *
 * A room lives only as long as its host is connected: guests are turned away
 * while there is no host, and everyone is disconnected with ROOM_CLOSED as soon
 * as the host leaves, so nothing lingers (and nothing keeps waking the room up)
 * after a session ends.
 */
export class Room extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected a WebSocket upgrade', { status: 426 })
    }
    if (this.ctx.getWebSockets().length >= MAX_PEERS) {
      return new Response('room is full', { status: 429 })
    }
    const isHost = request.headers.get(HOST_HEADER) === '1'
    const { 0: client, 1: server } = new WebSocketPair()
    if (!isHost && this.hosts().length === 0) {
      // Accept only to tell the client why: browsers cannot read HTTP errors of
      // a failed upgrade, but they do see close codes.
      server.accept()
      server.close(ROOM_CLOSED, 'room is closed')
      return new Response(null, { status: 101, webSocket: client })
    }
    this.ctx.acceptWebSocket(server, isHost ? [HOST_TAG] : [])
    return new Response(null, { status: 101, webSocket: client })
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === 'string') {
      ws.close(1003, 'binary frames only')
      return
    }
    if (message.byteLength > MAX_MESSAGE_BYTES) {
      ws.close(1009, 'message too big')
      return
    }
    for (const peer of this.ctx.getWebSockets()) {
      if (peer === ws) continue
      try {
        peer.send(message)
      } catch {
        // The peer is going away; its close handler cleans up.
      }
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    safeClose(ws, code, reason)
    this.closeIfHostLeft(ws)
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    safeClose(ws, 1011, 'error')
    this.closeIfHostLeft(ws)
  }

  private hosts(except?: WebSocket): WebSocket[] {
    return this.ctx.getWebSockets(HOST_TAG).filter((s) => s !== except)
  }

  private closeIfHostLeft(ws: WebSocket): void {
    if (!this.ctx.getTags(ws).includes(HOST_TAG) || this.hosts(ws).length > 0) return
    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== ws) safeClose(peer, ROOM_CLOSED, 'the host left')
    }
  }
}

function safeClose(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason)
  } catch {
    // Already closed.
  }
}
