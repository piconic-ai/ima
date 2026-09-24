import { markdown } from '@codemirror/lang-markdown'
import { EditorView } from '@codemirror/view'
import { importKey, RoomClient, type RoomStatus } from '@ima/protocol'
import { basicSetup } from 'codemirror'
import { yCollab } from 'y-codemirror.next'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { colorFor, parseRoomLocation, participants, roomSocketUrl } from './room.ts'
import './style.css'

const NAME_KEY = 'ima:name'
const app = document.getElementById('app') as HTMLElement

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const el = Object.assign(document.createElement(tag), props)
  el.append(...children)
  return el
}

function loadName(): string | null {
  try {
    return localStorage.getItem(NAME_KEY)
  } catch {
    return null
  }
}

function saveName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name)
  } catch {
    // Private mode or storage disabled: ask again next time.
  }
}

function showCard(title: string, body: (Node | string)[]): HTMLElement {
  const card = h('div', { className: 'card' }, [h('h1', { textContent: title }), ...body])
  app.replaceChildren(h('div', { className: 'center' }, [card]))
  return card
}

function showLanding(): void {
  showCard('ima', [
    h('p', {}, [
      'Co-edit a local Markdown file, right now. Run ',
      h('code', { textContent: 'npx @piconic/ima notes.md' }),
      ' and share the link it prints.',
    ]),
    h('p', { textContent: '居間 (living room) + 今 (now).' }),
  ])
}

function askName(): Promise<string> {
  return new Promise((resolve) => {
    const input = h('input', {
      name: 'name',
      placeholder: 'Your name',
      autocomplete: 'name',
      required: true,
      maxLength: 40,
    })
    const form = h('form', {}, [input, h('button', { type: 'submit', textContent: 'Join' })])
    form.addEventListener('submit', (ev) => {
      ev.preventDefault()
      const name = input.value.trim()
      if (!name) return
      saveName(name)
      resolve(name)
    })
    showCard('Join the room', [
      h('p', { textContent: 'Others will see this name next to your cursor.' }),
      form,
    ])
    input.focus()
  })
}

async function joinRoom(id: string, key: string, name: string): Promise<void> {
  const doc = new Y.Doc()
  const text = doc.getText('content')
  const awareness = new Awareness(doc)
  const color = colorFor(doc.clientID)
  awareness.setLocalState({ user: { name, color, colorLight: `${color}33` } })

  const status = h('span', { className: 'status' }, [h('span', { className: 'dot' }), h('span')])
  const file = h('span', { className: 'file' })
  const people = h('ul', { className: 'people', ariaLabel: 'Participants' })
  const banner = h('div', {
    className: 'banner',
    role: 'status',
    textContent: 'The host is not connected. Your edits will reach their file once they are back.',
    hidden: true,
  })
  const main = h('main', { className: 'editor' })
  app.replaceChildren(
    h('header', {}, [h('span', { className: 'brand', textContent: 'ima' }), file, status, people]),
    banner,
    main,
  )

  const setStatus = (s: RoomStatus) => {
    status.dataset.status = s
    const label = status.lastElementChild as HTMLElement
    label.textContent =
      s === 'connected' ? 'Connected' : s === 'connecting' ? 'Connecting…' : 'Offline'
  }
  setStatus('connecting')

  const renderPeople = () => {
    const list = participants(awareness.getStates(), doc.clientID)
    people.replaceChildren(
      ...list.map((p) => {
        const li = h('li', {
          textContent: `${p.name}${p.isHost ? ' (host)' : ''}${p.isSelf ? ' (you)' : ''}`,
        })
        li.style.setProperty('--c', p.color)
        return li
      }),
    )
    const host = [...awareness.getStates().values()].find((s) => s.role === 'host')
    banner.hidden = Boolean(host) || client.status !== 'connected'
    file.textContent = typeof host?.file === 'string' ? host.file : ''
    document.title = host?.file ? `${host.file} · ima` : 'ima'
  }

  const client = new RoomClient({
    url: roomSocketUrl(location, id),
    key: await importKey(key),
    doc,
    awareness,
    onStatus: (s) => {
      setStatus(s)
      renderPeople()
    },
  })
  awareness.on('change', renderPeople)

  const undoManager = new Y.UndoManager(text)
  new EditorView({
    parent: main,
    extensions: [
      basicSetup,
      markdown(),
      EditorView.lineWrapping,
      yCollab(text, awareness, { undoManager }),
    ],
  })
  client.connect()
  renderPeople()
  window.addEventListener('pagehide', () => void client.destroy())
}

async function start(): Promise<void> {
  if (location.pathname === '/' || location.pathname === '') {
    showLanding()
    return
  }
  const room = parseRoomLocation(location)
  if (!room) {
    showCard('This link is incomplete', [
      h('p', { textContent: 'Ask the host to copy the whole URL, including the part after #.' }),
    ])
    return
  }
  const name = loadName() ?? (await askName())
  await joinRoom(room.id, room.key, name)
}

void start()
