// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { monotonic, PreviewPane, scrollTarget } from '../src/pane.ts'
import * as preview from '../src/preview.ts'

describe('scrollTarget', () => {
  const anchors = [
    { line: 0, top: 0 },
    { line: 4, top: 100 },
    { line: 10, top: 400 },
  ]

  it('lines up with the block the editor shows', () => {
    expect(scrollTarget(anchors, 4)).toBe(100)
    expect(scrollTarget(anchors, 10)).toBe(400)
  })

  it('interpolates inside a block', () => {
    expect(scrollTarget(anchors, 2)).toBe(50)
    expect(scrollTarget(anchors, 7)).toBe(250)
  })

  it('stops at the last anchor', () => {
    expect(scrollTarget(anchors, 30)).toBe(400)
    expect(scrollTarget([], 3)).toBe(0)
  })

  it('starts from the top before the first anchor', () => {
    expect(scrollTarget([{ line: 4, top: 200 }], 2)).toBe(100)
  })
})

describe('monotonic', () => {
  it('drops anchors that do not move forward', () => {
    expect(
      monotonic([
        { line: 0, top: 0 },
        { line: 2, top: 50 },
        { line: 2, top: 50 },
        { line: 3, top: 40 },
        { line: 5, top: 90 },
      ]),
    ).toEqual([
      { line: 0, top: 0 },
      { line: 2, top: 50 },
      { line: 5, top: 90 },
    ])
  })
})

describe('PreviewPane', () => {
  function setup(load = () => Promise.resolve(preview)) {
    const doc = new Y.Doc()
    const text = doc.getText('content')
    const rendered = vi.fn()
    const pane = new PreviewPane(text, { load, onRender: rendered })
    return { text, pane, rendered }
  }

  it('renders only while active and follows edits', async () => {
    const load = vi.fn(() => Promise.resolve(preview))
    const { text, pane, rendered } = setup(load)
    text.insert(0, '# Hello')
    await new Promise((r) => setTimeout(r, 50))
    expect(load).not.toHaveBeenCalled()
    expect(pane.element.innerHTML).toBe('')

    pane.active = true
    await vi.waitFor(() => expect(pane.element.querySelector('h1')?.textContent).toBe('Hello'))
    text.insert(text.length, '\n\nworld')
    await vi.waitFor(() => expect(pane.element.querySelector('p')?.textContent).toBe('world'))
    expect(load).toHaveBeenCalledTimes(1)
    expect(rendered).toHaveBeenCalledTimes(2)
  })

  it('catches up on edits made while hidden', async () => {
    const { text, pane } = setup()
    pane.active = true
    await vi.waitFor(() => expect(pane.element.innerHTML).toBe(''))
    pane.active = false
    text.insert(0, 'later')
    pane.active = true
    await vi.waitFor(() => expect(pane.element.textContent).toContain('later'))
  })

  it('says so when the renderer cannot load, and retries on the next edit', async () => {
    const load = vi
      .fn<() => Promise<typeof preview>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(preview)
    const { text, pane } = setup(load)
    text.insert(0, 'hi')
    pane.active = true
    await vi.waitFor(() => expect(pane.element.textContent).toContain('could not be loaded'))
    text.insert(2, '!')
    await vi.waitFor(() => expect(pane.element.textContent).toBe('hi!\n'))
  })
})
