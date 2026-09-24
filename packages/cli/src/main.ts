import { existsSync } from 'node:fs'
import { userInfo } from 'node:os'
import { resolve } from 'node:path'
import { copyToClipboard } from './clipboard.ts'
import { startSession } from './session.ts'

declare const IMA_VERSION: string

const DEFAULT_SERVER = 'https://ima.piconic.ai'

const USAGE = `Usage: ima <file>

Share a local Markdown file and co-edit it with others in their browser.
Edits are written back to the file. Press Ctrl+C to finish.

Environment:
  IMA_SERVER  ima server URL (default: ${DEFAULT_SERVER})`

async function main(argv: string[]): Promise<number> {
  const [arg, ...rest] = argv
  if (arg === '-h' || arg === '--help') {
    console.log(USAGE)
    return 0
  }
  if (arg === '-v' || arg === '--version') {
    console.log(typeof IMA_VERSION === 'string' ? IMA_VERSION : 'dev')
    return 0
  }
  if (!arg || rest.length > 0) {
    console.error(USAGE)
    return 2
  }
  const file = resolve(arg)
  if (!existsSync(file)) {
    console.error(`ima: no such file: ${arg}`)
    return 1
  }

  const tty = process.stdout.isTTY
  let peers = 0
  let status = 'connecting'
  let ready = false
  const render = () => {
    if (!ready) return
    const who = peers === 0 ? 'waiting for others' : `${peers} other${peers === 1 ? '' : 's'} here`
    const line = `  ${status === 'connected' ? '●' : '○'} ${status} · ${who}`
    if (tty) process.stdout.write(`\r\x1b[2K${line}`)
    else console.log(line.trim())
  }

  const session = await startSession({
    file,
    server: process.env.IMA_SERVER || DEFAULT_SERVER,
    name: safeUsername(),
    onStatus: (s) => {
      status = s
      render()
    },
    onPeers: (n) => {
      if (n === peers) return
      peers = n
      render()
    },
    onError: (error) => {
      if (process.env.IMA_DEBUG) console.error('\nima:', error)
    },
  })

  const copied = await copyToClipboard(session.url)
  console.log(`Sharing ${arg}\n\n  ${session.url}\n`)
  if (copied) console.log('  (copied to clipboard)\n')
  ready = true
  render()

  await new Promise<void>((done) => {
    let stopping = false
    const onSignal = () => {
      if (stopping) process.exit(130)
      stopping = true
      if (tty) process.stdout.write('\n')
      console.log('Saving and closing the room…')
      session.stop().then(done, (error) => {
        console.error('ima:', error)
        process.exit(1)
      })
    }
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
  })
  console.log(`Saved ${arg}`)
  return 0
}

function safeUsername(): string | undefined {
  try {
    return userInfo().username
  } catch {
    return undefined
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error('ima:', error instanceof Error ? error.message : error)
    process.exit(1)
  },
)
