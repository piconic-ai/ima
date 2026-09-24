import { type FSWatcher, watch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { generateKey, importKey, RoomClient, type RoomStatus, type SocketLike } from '@ima/protocol'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { FileWriter } from './file-writer.ts'
import { mergeExternalEdit } from './merge.ts'

export interface SessionOptions {
  file: string
  /** Base URL of the ima server, e.g. https://ima.piconic.ai */
  server: string
  name?: string
  writeDelayMs?: number
  /** Stream edits made to the file outside ima into the room (default: true). */
  watch?: boolean
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
  /** Merges the file's current content into the doc if it changed outside ima. */
  syncFromDisk(): Promise<void>
  /** Writes the final state to the file and leaves the room. */
  stop(): Promise<void>
}

export async function startSession(opts: SessionOptions): Promise<Session> {
  const server = opts.server.replace(/\/+$/, '')
  const content = await readFile(opts.file, 'utf8')
  const doFetch = opts.fetch ?? fetch

  const res = await doFetch(`${server}/api/rooms`, { method: 'POST' })
  if (!res.ok) throw new Error(`failed to create a room: ${res.status} ${res.statusText}`)
  const { id, hostToken } = (await res.json()) as { id: string; hostToken: string }

  const key = generateKey()
  const url = `${server}/r/${id}#${key}`
  const wsUrl = `${server.replace(/^http/, 'ws')}/api/rooms/${id}/ws`

  const doc = new Y.Doc()
  const text = doc.getText('content')
  text.insert(0, content)
  const awareness = new Awareness(doc)
  awareness.setLocalState({ role: 'host', name: opts.name ?? 'host', file: basename(opts.file) })

  const FILE_ORIGIN = 'file'
  let readTimer: ReturnType<typeof setTimeout> | null = null
  let reading: Promise<void> = Promise.resolve()

  // Pull an outside edit into the doc, merged against what we last wrote.
  const syncFromDisk = () => {
    reading = reading.then(async () => {
      const onDisk = await readSettled(opts.file)
      if (onDisk === null || onDisk === writer.lastWritten) return
      mergeExternalEdit(text, writer.lastWritten, onDisk, FILE_ORIGIN)
      writer.lastWritten = onDisk
      // Remote edits made meanwhile are not on disk yet; this also replaces any
      // stale pending write.
      writer.schedule(text.toString())
    })
    return reading
  }
  const scheduleSyncFromDisk = () => {
    if (readTimer) clearTimeout(readTimer)
    readTimer = setTimeout(() => {
      readTimer = null
      void syncFromDisk()
    }, 50)
  }

  const writer = new FileWriter(
    opts.file,
    content,
    opts.writeDelayMs,
    opts.onError,
    scheduleSyncFromDisk,
  )
  const client = new RoomClient({
    url: wsUrl,
    key: await importKey(key),
    doc,
    awareness,
    // Marks us as the host: the room closes for everyone once we leave.
    headers: { Authorization: `Bearer ${hostToken}` },
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

  // Watch the directory rather than the file: editors often save by renaming a
  // new file over the old one, which would orphan a watch on the file itself.
  let watcher: FSWatcher | null = null
  if (opts.watch ?? true) {
    const name = basename(opts.file)
    watcher = watch(dirname(opts.file), (_event, changed) => {
      if (changed === null || changed.toString() === name) scheduleSyncFromDisk()
    })
    watcher.on('error', (error) => opts.onError?.(error))
  }

  let stopped: Promise<void> | null = null
  const stop = () => {
    stopped ??= (async () => {
      watcher?.close()
      if (readTimer) clearTimeout(readTimer)
      await syncFromDisk()
      writer.schedule(text.toString())
      await writer.flush()
      await client.destroy()
      awareness.destroy()
      doc.destroy()
    })()
    return stopped
  }

  return { url, doc, client, writer, syncFromDisk, stop }
}

// Saving is often truncate-then-write, so a read right after the change event can
// see a half-written file. Read until two consecutive reads agree.
async function readSettled(path: string, intervalMs = 30, maxReads = 10): Promise<string | null> {
  let previous = await readFile(path, 'utf8').catch(() => null)
  for (let i = 1; i < maxReads; i++) {
    await new Promise((r) => setTimeout(r, intervalMs))
    const current = await readFile(path, 'utf8').catch(() => null)
    if (current === previous) return current
    previous = current
  }
  return previous
}
