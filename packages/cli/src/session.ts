import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { generateKey, importKey, RoomClient, type RoomStatus, type SocketLike } from '@ima/protocol'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { FileWriter } from './file-writer.ts'

export interface SessionOptions {
  file: string
  /** Base URL of the ima server, e.g. https://ima.piconic.ai */
  server: string
  name?: string
  writeDelayMs?: number
  fetch?: typeof fetch
  createSocket?: (url: string) => SocketLike
  onStatus?: (status: RoomStatus) => void
  /** Called with the number of other people in the room. */
  onPeers?: (count: number) => void
  onError?: (error: unknown) => void
}

export interface Session {
  /** The share URL. Its fragment holds the key and must never be sent to the server. */
  url: string
  doc: Y.Doc
  client: RoomClient
  writer: FileWriter
  /** Writes the final state to the file and leaves the room. */
  stop(): Promise<void>
}

export async function startSession(opts: SessionOptions): Promise<Session> {
  const server = opts.server.replace(/\/+$/, '')
  const content = await readFile(opts.file, 'utf8')
  const doFetch = opts.fetch ?? fetch

  const res = await doFetch(`${server}/api/rooms`, { method: 'POST' })
  if (!res.ok) throw new Error(`failed to create a room: ${res.status} ${res.statusText}`)
  const { id } = (await res.json()) as { id: string }

  const key = generateKey()
  const url = `${server}/r/${id}#${key}`
  const wsUrl = `${server.replace(/^http/, 'ws')}/api/rooms/${id}/ws`

  const doc = new Y.Doc()
  const text = doc.getText('content')
  text.insert(0, content)
  const awareness = new Awareness(doc)
  awareness.setLocalState({ role: 'host', name: opts.name ?? 'host', file: basename(opts.file) })

  const writer = new FileWriter(opts.file, content, opts.writeDelayMs, opts.onError)
  const client = new RoomClient({
    url: wsUrl,
    key: await importKey(key),
    doc,
    awareness,
    createSocket: opts.createSocket,
    onStatus: opts.onStatus,
    onError: opts.onError,
  })

  doc.on('update', (_update: Uint8Array, origin: unknown) => {
    if (origin === client) writer.schedule(text.toString())
  })
  awareness.on('change', () => {
    const others = [...awareness.getStates().keys()].filter((id) => id !== doc.clientID)
    opts.onPeers?.(others.length)
  })
  client.connect()

  let stopped: Promise<void> | null = null
  const stop = () => {
    stopped ??= (async () => {
      writer.schedule(text.toString())
      await writer.flush()
      await client.destroy()
      awareness.destroy()
      doc.destroy()
    })()
    return stopped
  }

  return { url, doc, client, writer, stop }
}
