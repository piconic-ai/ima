import diff from 'fast-diff'
import type * as Y from 'yjs'

interface Edit {
  start: number
  end: number
  insert: string
}

/** Edits turning `from` into `to`, in `from` offsets, in ascending order. */
function editsBetween(from: string, to: string): Edit[] {
  const edits: Edit[] = []
  let pos = 0
  for (const [op, chunk] of diff(from, to)) {
    if (op === diff.EQUAL) {
      pos += chunk.length
    } else if (op === diff.DELETE) {
      const last = edits.at(-1)
      if (last && last.end === pos) last.end += chunk.length
      else edits.push({ start: pos, end: pos + chunk.length, insert: '' })
      pos += chunk.length
    } else {
      const last = edits.at(-1)
      if (last && last.end === pos) last.insert += chunk
      else edits.push({ start: pos, end: pos, insert: chunk })
    }
  }
  return edits
}

/** Returns a function mapping offsets in `base` to offsets in `current`. */
function offsetMapper(base: string, current: string): (offset: number) => number {
  const ops = diff(base, current)
  return (offset) => {
    let b = 0
    let c = 0
    for (const [op, chunk] of ops) {
      const len = chunk.length
      if (op === diff.EQUAL) {
        if (offset <= b + len) return c + (offset - b)
        b += len
        c += len
      } else if (op === diff.DELETE) {
        if (offset <= b + len) return c
        b += len
      } else {
        c += len
      }
    }
    return c + (offset - b)
  }
}

/**
 * Applies the change from `base` to `next` (an edit made to the file outside ima)
 * onto `text`, which may meanwhile have diverged from `base` through remote edits.
 * Remote edits are kept unless the external edit replaced the same region.
 */
export function mergeExternalEdit(text: Y.Text, base: string, next: string, origin: unknown): void {
  const current = text.toString()
  const edits = editsBetween(base, next)
  if (edits.length === 0) return
  const map = offsetMapper(base, current)
  const mapped = edits.map((e) => ({
    start: map(e.start),
    end: Math.max(map(e.start), map(e.end)),
    insert: e.insert,
  }))
  const doc = text.doc
  const apply = () => {
    for (let i = mapped.length - 1; i >= 0; i--) {
      const e = mapped[i] as Edit
      if (e.end > e.start) text.delete(e.start, e.end - e.start)
      if (e.insert) text.insert(e.start, e.insert)
    }
  }
  if (doc) doc.transact(apply, origin)
  else apply()
}
