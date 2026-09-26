import { markdown } from '@codemirror/lang-markdown'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { importKey, RoomClient, type RoomStatus } from '@ima/protocol'
import { basicSetup } from 'codemirror'
import { yCollab } from 'y-codemirror.next'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { avatarFor, fetchIdentity, initials } from './identity.ts'
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
      h('code', { textContent: 'ima notes.md' }),
      ' and share the link it prints. ',
      h('a', {
        href: 'https://github.com/piconic-ai/ima#install',
        textContent: 'How to install',
      }),
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

interface Me {
  name: string
  avatar?: string
}

async function joinRoom(id: string, key: string, me: Me): Promise<void> {
  const doc = new Y.Doc()
  const text = doc.getText('content')
  const awareness = new Awareness(doc)
  const color = colorFor(doc.clientID)
  awareness.setLocalState({ user: { ...me, color, colorLight: `${color}33` } })

  const status = h('span', { className: 'status' }, [h('span', { className: 'dot' }), h('span')])
  const file = h('span', { className: 'file' })
  const people = h('ul', { className: 'people', ariaLabel: 'Participants' })
  // The room closes as soon as the host leaves (or was never there).
  const reconnect = h('button', { type: 'button', textContent: 'Reconnect' })
  reconnect.addEventListener('click', () => location.reload())
  const banner = h('div', { className: 'banner', role: 'status', hidden: true }, [
    h('span', {
      textContent:
        'This session has ended: the host is not connected. You can still copy the text.',
    }),
    reconnect,
  ])
  const main = h('main', { className: 'editor' })
  app.replaceChildren(
    h('header', {}, [h('span', { className: 'brand', textContent: 'ima' }), file, status, people]),
    banner,
    main,
  )

  const editable = new Compartment()
  const readOnly = [EditorState.readOnly.of(true), EditorView.editable.of(false)]
  const undoManager = new Y.UndoManager(text)
  const editor = new EditorView({
    parent: main,
    extensions: [
      basicSetup,
      markdown(),
      EditorView.lineWrapping,
      editable.of([]),
      yCollab(text, awareness, { undoManager }),
    ],
  })

  const setStatus = (s: RoomStatus) => {
    status.dataset.status = s
    const label = status.lastElementChild as HTMLElement
    label.textContent =
      s === 'connected'
        ? 'Connected'
        : s === 'connecting'
          ? 'Connecting…'
          : s === 'closed'
            ? 'Ended'
            : 'Offline'
    if (s === 'closed') {
      banner.hidden = false
      editor.dispatch({ effects: editable.reconfigure(readOnly) })
    }
  }

  const renderPeople = () => {
    const list = participants(awareness.getStates(), doc.clientID)
    people.replaceChildren(
      ...list.map((p) => {
        const face = h('span', { className: 'avatar', textContent: initials(p.name) })
        if (p.avatar) {
          const img = h('img', { src: p.avatar, alt: '', referrerPolicy: 'no-referrer' })
          // Unknown to Gravatar (d=404) or blocked: keep the initials.
          img.addEventListener('error', () => img.remove())
          face.append(img)
        }
        const label = `${p.name}${p.isHost ? ' (host)' : ''}${p.isSelf ? ' (you)' : ''}`
        const li = h('li', { title: label }, [face, h('span', { textContent: label })])
        li.style.setProperty('--c', p.color)
        return li
      }),
    )
    const host = [...awareness.getStates().values()].find((s) => s.role === 'host')
    // Keep showing the file name after the host has gone.
    if (typeof host?.file === 'string') {
      file.textContent = host.file
      document.title = `${host.file} · ima`
    }
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

  setStatus('connecting')
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
  // Behind Cloudflare Access we already know who you are.
  const identity = await fetchIdentity()
  const me: Me = identity
    ? { name: identity.name, avatar: await avatarFor(identity) }
    : { name: loadName() ?? (await askName()) }
  await joinRoom(room.id, room.key, me)
}

void start()
