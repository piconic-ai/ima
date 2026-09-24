import { spawn } from 'node:child_process'

const COMMANDS: Record<string, [string, string[]][]> = {
  darwin: [['pbcopy', []]],
  win32: [['clip', []]],
  linux: [
    ['wl-copy', []],
    ['xclip', ['-selection', 'clipboard']],
    ['xsel', ['--clipboard', '--input']],
  ],
}

function tryCopy(cmd: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
    child.stdin.end(text)
  })
}

/** Best effort: returns false when no clipboard tool is available. */
export async function copyToClipboard(text: string): Promise<boolean> {
  for (const [cmd, args] of COMMANDS[process.platform] ?? []) {
    if (await tryCopy(cmd, args, text)) return true
  }
  return false
}
