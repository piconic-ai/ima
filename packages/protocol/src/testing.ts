import type { SocketLike } from './room.ts'

/** An in-memory stand-in for the Worker: relays every frame to all other sockets. */
export class Relay {
  sockets = new Set<FakeSocket>()
  frames: Uint8Array[] = []
  urls: string[] = []
  create = (url: string): SocketLike => {
    this.urls.push(url)
    const socket = new FakeSocket(this)
    this.sockets.add(socket)
    queueMicrotask(() => {
      socket.readyState = 1
      socket.onopen?.({})
    })
    return socket
  }
}

export class FakeSocket implements SocketLike {
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
