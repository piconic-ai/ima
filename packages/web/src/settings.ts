import { h } from './dom.ts'

const SVG_NS = 'http://www.w3.org/2000/svg'
const PANEL_WIDTH = 280
const EDGE = 8

/** An eight-toothed gear outline centred in a 24x24 box. */
function gearPath(teeth = 8, outer = 10, inner = 7.5): string {
  const points: string[] = []
  const step = (2 * Math.PI) / teeth
  const at = (r: number, a: number) =>
    `${(12 + r * Math.cos(a)).toFixed(2)} ${(12 + r * Math.sin(a)).toFixed(2)}`
  for (let i = 0; i < teeth; i++) {
    const a = i * step
    // Each tooth: rise, flat top, fall; the gap to the next one is a straight edge.
    points.push(
      at(inner, a - step * 0.3),
      at(outer, a - step * 0.18),
      at(outer, a + step * 0.18),
      at(inner, a + step * 0.3),
    )
  }
  return `M${points.join('L')}Z`
}

function gearIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  for (const [k, v] of Object.entries({
    viewBox: '0 0 24 24',
    width: '18',
    height: '18',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  })) {
    svg.setAttribute(k, v)
  }
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', gearPath())
  const hub = document.createElementNS(SVG_NS, 'circle')
  for (const [k, v] of Object.entries({ cx: '12', cy: '12', r: '3' })) hub.setAttribute(k, v)
  svg.append(path, hub)
  return svg
}

export interface ToggleOptions {
  label: string
  hint?: string
  checked: boolean
  onChange: (checked: boolean) => void
}

export interface Toggle {
  /** Updates the checkbox without calling onChange, e.g. to undo a failed change. */
  set(checked: boolean): void
}

export interface Settings {
  button: HTMLButtonElement
  panel: HTMLElement
  addToggle(options: ToggleOptions): Toggle
}

/**
 * A gear button that opens a panel of per-browser preferences.
 * The panel is a popover, so the browser handles closing it on Escape or an
 * outside click.
 */
export function createSettings(): Settings {
  const list = h('div', { className: 'settings-list' })
  const panel = h('div', { className: 'settings', id: 'settings', role: 'dialog' }, [
    h('h2', { textContent: 'Settings' }),
    list,
  ])
  panel.setAttribute('popover', '')
  panel.setAttribute('aria-label', 'Settings')

  const button = h('button', { type: 'button', className: 'icon', title: 'Settings' }, [gearIcon()])
  button.setAttribute('aria-label', 'Settings')
  button.setAttribute('popovertarget', panel.id)

  // Open right under the button, wherever the header has wrapped it to,
  // and keep the whole panel on screen.
  panel.addEventListener('beforetoggle', (ev) => {
    if ((ev as ToggleEvent).newState !== 'open') return
    const rect = button.getBoundingClientRect()
    const viewport = document.documentElement.clientWidth
    const width = Math.min(PANEL_WIDTH, viewport - 2 * EDGE)
    const left = Math.max(EDGE, Math.min(rect.right - width, viewport - width - EDGE))
    panel.style.width = `${width}px`
    panel.style.left = `${left}px`
    panel.style.top = `${rect.bottom + 6}px`
  })

  const addToggle = ({ label, hint, checked, onChange }: ToggleOptions): Toggle => {
    const input = h('input', { type: 'checkbox', checked })
    input.addEventListener('change', () => onChange(input.checked))
    const text = h('span', { className: 'settings-text' }, [h('span', { textContent: label })])
    if (hint) text.append(h('small', { textContent: hint }))
    list.append(h('label', { className: 'settings-row' }, [input, text]))
    return {
      set: (value) => {
        input.checked = value
      },
    }
  }

  return { button, panel, addToggle }
}
