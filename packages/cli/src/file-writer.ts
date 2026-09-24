import { chmod, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** Writes the file atomically: a temp file in the same directory, then rename over. */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const tmp = join(dirname(path), `.${basename(path)}.ima-${process.pid}.tmp`)
  const mode = await stat(path).then(
    (s) => s.mode,
    () => undefined,
  )
  try {
    await writeFile(tmp, content, 'utf8')
    if (mode !== undefined) await chmod(tmp, mode)
    await rename(tmp, path)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
}

/**
 * Debounces writes of the latest content to `path`. Skips writes when the
 * content equals what is already on disk (as far as we know).
 */
export class FileWriter {
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending: string | null = null
  private writing: Promise<void> = Promise.resolve()
  lastWritten: string

  constructor(
    readonly path: string,
    initial: string,
    private readonly delayMs = 1000,
    private readonly onError: (error: unknown) => void = () => {},
  ) {
    this.lastWritten = initial
  }

  schedule(content: string): void {
    this.pending = content
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, this.delayMs)
  }

  /** Writes any pending content now and waits for all writes to finish. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const content = this.pending
    this.pending = null
    if (content !== null) {
      this.writing = this.writing.then(async () => {
        if (content === this.lastWritten) return
        try {
          await writeFileAtomic(this.path, content)
          this.lastWritten = content
        } catch (error) {
          this.onError(error)
        }
      })
    }
    return this.writing
  }
}
