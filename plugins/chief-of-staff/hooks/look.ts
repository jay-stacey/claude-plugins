import type { ThemeSetArgs } from 'claude-code'

import type { ChiefPaneRow } from '../types'
import { makeColors } from './make-colors.js'

// The Chief's look in the app: the console's ember HUD (console/app.css), dark only.
// Colors and the session graph both come from here, so the pane and the theme agree.

export const EMBER = {
  bg: '#0a0605',
  panel: '#130b08',
  panel2: '#1a0f0b',
  line: '#3a2018',
  lineStrong: '#6e3320',
  fg: '#ecd9cf',
  muted: '#9a7d70',
  faint: '#5e4a42',
  accent: '#ff5a1f',
  ok: '#7fae6a',
} as const

// Session states, as the console colors them.
export const STATE_HEX: Record<string, string> = {
  you: '#ff4b2b',
  active: '#ffa24a',
  wait: '#c9824f',
  stale: '#6b5850',
}

const built = makeColors({
  label: 'Chief ember console',
  only: 'dark',
  roles: { accent: EMBER.accent, danger: '#ff4b2b', success: EMBER.ok, warning: '#ffa24a', pro: '#c9824f' },
  dark: {
    gray: {
      anchors: {
        'surface-0': EMBER.bg,
        'surface-1': '#140c09',
        'surface-2': '#1b100c',
        'surface-3': '#22140f',
        'text-primary': EMBER.fg,
        'text-secondary': '#c4a99b',
        'text-muted': EMBER.muted,
      },
    },
  },
})

// What would stop the app painting the look at all, if anything.
export const LOOK_BLOCKER = built.problems.find(line => line.startsWith("Desktop won't paint")) ?? null

export const LOOK: ThemeSetArgs = {
  colors: built.theme,
  backdrop: { scene: 'chief-ember', glass: false },
}

// The console's background: an ember glow over a faint 32 px grid, breathing slowly.
export const SCENE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
<style>
.glow{animation:breathe 9s ease-in-out infinite;transform-origin:50% 45%}
@keyframes breathe{0%,100%{opacity:.75}50%{opacity:1}}
@media (prefers-reduced-motion: reduce){.glow{animation:none}}
</style>
<defs>
<radialGradient id="g" cx="50%" cy="45%" r="60%">
<stop offset="0" stop-color="#ff5a1f" stop-opacity=".09"/>
<stop offset="1" stop-color="#ff5a1f" stop-opacity="0"/>
</radialGradient>
<pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse">
<path d="M32 0H0V32" fill="none" stroke="#ff622e" stroke-opacity=".05" stroke-width="1"/>
</pattern>
</defs>
<rect width="1600" height="1000" fill="${EMBER.bg}"/>
<rect width="1600" height="1000" fill="url(#grid)"/>
<rect class="glow" width="1600" height="1000" fill="url(#g)"/>
</svg>`

function xml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const RINGS: Record<string, number> = { you: 0.42, active: 0.6, wait: 0.78, stale: 0.95 }
const GRAPH_MAX = 28

// The console's session graph, small: the Chief's core in the middle, each session a node
// on its state's ring. Nodes that need Jay pulse. Hover shows a node's title.
export function graphSvg(rows: readonly ChiefPaneRow[], name: string): string {
  const w = 560
  const h = 230
  const cx = w / 2
  const cy = h / 2
  const shown = rows.slice(0, GRAPH_MAX)
  const byState = new Map<string, ChiefPaneRow[]>()
  for (const r of shown) byState.set(r.state, [...(byState.get(r.state) ?? []), r])
  const rings: string[] = []
  const links: string[] = []
  const nodes: string[] = []
  for (const [state, k] of Object.entries(RINGS)) {
    const rx = (w / 2 - 18) * k
    const ry = (h / 2 - 14) * k
    rings.push(`<ellipse cx="${cx}" cy="${cy}" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}" fill="none" stroke="${EMBER.accent}" stroke-opacity="${state === 'you' ? 0.4 : 0.2}" stroke-dasharray="${state === 'stale' ? '2 6' : '0'}"/>`)
    const list = byState.get(state) ?? []
    list.forEach((r, i) => {
      // Spread the ring's nodes evenly, each ring turned a little so lines do not stack.
      const a = (2 * Math.PI * i) / Math.max(1, list.length) - Math.PI / 2 + k * 1.7
      const x = cx + rx * Math.cos(a)
      const y = cy + ry * Math.sin(a)
      const c = STATE_HEX[state] ?? EMBER.faint
      links.push(`<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${c}" stroke-opacity="${state === 'stale' ? 0.14 : 0.35}"/>`)
      const pulse = state === 'you'
        ? `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7" fill="none" stroke="${c}" class="pulse"/>`
        : ''
      nodes.push(`<g><title>${xml(r.title)}</title>${pulse}<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${state === 'you' ? 7.5 : 5.5}" fill="${c}" fill-opacity="${state === 'stale' ? 0.7 : 1}"/></g>`)
    })
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
<style>
.pulse{animation:ping 2.2s ease-out infinite;transform-box:fill-box;transform-origin:center}
@keyframes ping{0%{transform:scale(1);opacity:.9}100%{transform:scale(2.6);opacity:0}}
.core{animation:core 4s ease-in-out infinite}
@keyframes core{0%,100%{opacity:.35}50%{opacity:.7}}
@media (prefers-reduced-motion: reduce){.pulse,.core{animation:none}}
</style>
<defs><radialGradient id="c"><stop offset="0" stop-color="${EMBER.accent}" stop-opacity=".55"/><stop offset="1" stop-color="${EMBER.accent}" stop-opacity="0"/></radialGradient></defs>
${rings.join('\n')}
${links.join('\n')}
<circle class="core" cx="${cx}" cy="${cy}" r="34" fill="url(#c)"/>
<circle cx="${cx}" cy="${cy}" r="15" fill="${EMBER.panel2}" stroke="${EMBER.accent}" stroke-width="2"/>
<text x="${cx}" y="${cy + 33}" text-anchor="middle" font-family="Bahnschrift, Segoe UI, sans-serif" font-size="11" letter-spacing="2" fill="${EMBER.muted}">${xml(name.toUpperCase())}</text>
${nodes.join('\n')}
</svg>`
}
