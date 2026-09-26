// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createSettings } from '../src/settings.ts'

describe('createSettings', () => {
  it('opens its panel from a labelled gear button', () => {
    const { button, panel } = createSettings()
    expect(button.getAttribute('aria-label')).toBe('Settings')
    expect(button.querySelector('svg path')?.getAttribute('d')).toMatch(/^M.+Z$/)
    expect(panel.hasAttribute('popover')).toBe(true)
    expect(button.getAttribute('popovertarget')).toBe(panel.id)
  })

  it('adds toggles that report changes and can be reset without reporting', () => {
    const { panel, addToggle } = createSettings()
    document.body.append(panel)
    const changes: boolean[] = []
    const toggle = addToggle({
      label: 'Vim keybindings',
      hint: 'Only in this browser.',
      checked: false,
      onChange: (on) => changes.push(on),
    })

    const row = panel.querySelector('label')
    const input = panel.querySelector('input')
    if (!row || !input) throw new Error('no toggle rendered')
    expect(row.textContent).toContain('Vim keybindings')
    expect(row.textContent).toContain('Only in this browser.')
    expect(input.checked).toBe(false)

    input.click()
    expect(changes).toEqual([true])

    toggle.set(false)
    expect(input.checked).toBe(false)
    expect(changes).toEqual([true])
  })

  it('starts a toggle in the stored state', () => {
    const { panel, addToggle } = createSettings()
    addToggle({ label: 'A', checked: true, onChange: () => {} })
    addToggle({ label: 'B', checked: false, onChange: () => {} })
    const inputs = [...panel.querySelectorAll('input')].map((i) => i.checked)
    expect(inputs).toEqual([true, false])
  })
})

describe('settings panel position', () => {
  function openAt(right: number, bottom: number, viewport: number) {
    const { button, panel } = createSettings()
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      value: viewport,
    })
    button.getBoundingClientRect = () => ({ right, bottom }) as DOMRect
    const ev = new Event('beforetoggle') as Event & { newState: string }
    ev.newState = 'open'
    panel.dispatchEvent(ev)
    return panel.style
  }

  it('lines the panel up with the right edge of the gear', () => {
    expect(openAt(1270, 40, 1280)).toMatchObject({ left: '990px', top: '46px', width: '280px' })
  })

  it('keeps the panel on screen when the gear wraps to the left', () => {
    expect(openAt(250, 80, 375)).toMatchObject({ left: '8px', width: '280px' })
    expect(openAt(300, 80, 250)).toMatchObject({ left: '8px', width: '234px' })
  })
})
