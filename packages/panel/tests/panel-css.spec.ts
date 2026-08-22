import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '..', 'src', 'panel.css'), 'utf8')
/** The stylesheet body without comments (contract docs live in the header). */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '')

/** The frozen color-token contract every host theme bridge must supply. */
const CONTRACT_COLOR_VARS = [
  '--swarm-bg',
  '--swarm-bg-raised',
  '--swarm-fg',
  '--swarm-fg-muted',
  '--swarm-border',
  '--swarm-accent',
  '--swarm-state-running',
  '--swarm-state-done',
  '--swarm-state-error',
] as const

describe('panel.css theme contract', () => {
  it('consumes every contract color variable', () => {
    for (const name of CONTRACT_COLOR_VARS) {
      expect(css, `panel.css must consume ${name}`).toMatch(new RegExp(`var\\(${name.replace(/[-]/g, '\\-')}[,)]`))
    }
  })

  it('maps status badges onto the --swarm-state-* variables via data-status selectors', () => {
    const badgeBlocks = rules.match(/\.swarm-task__status\[data-status=[^\]]*\]\s*,?/g) ?? []
    expect(badgeBlocks.length).toBeGreaterThan(0)
    // Each state variable is referenced by at least one badge rule block.
    for (const state of ['running', 'done', 'error'] as const) {
      expect(rules).toContain(`var(--swarm-state-${state})`)
    }
    for (const status of ['in_progress', 'submitted', 'verifying', 'completed', 'failed']) {
      expect(rules, `status ${status} needs a badge selector`).toContain(`[data-status='${status}']`)
    }
    // The default badge color stays muted, so pending/unknown statuses never
    // borrow a state color.
    expect(rules).toMatch(/\.swarm-task__status\s*\{[^}]*color:\s*var\(--swarm-fg-muted\)/)
  })

  it('contains no literal colors: every paint declaration rides a contract variable', () => {
    expect(css, 'no hex colors').not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(css, 'no color functions').not.toMatch(/\b(rgba?|hsla?|oklch|oklab|lab|lch|color)\(/i)
    const paintDeclarations = rules.match(/(?:^|[;{])\s*(?:color|background|background-color|border|border-top|border-left|outline)\s*:[^;}]+/g) ?? []
    expect(paintDeclarations.length).toBeGreaterThan(0)
    for (const declaration of paintDeclarations) {
      // Contract vars, or keyword resets that inherit host styling — never a
      // literal color.
      expect(declaration, `paint declaration must ride a contract var: ${declaration.trim()}`)
        .toMatch(/var\(--swarm-[a-z-]+\)|\b(none|inherit|initial|unset|currentcolor)\b/)
    }
  })

  it('declares only the non-color defaults on .swarm-panel', () => {
    const rootBlock = /\.swarm-panel\s*\{[^}]*\}/.exec(rules)?.[0] ?? ''
    expect(rootBlock).toContain('--swarm-radius: 8px')
    expect(rootBlock).toContain('--swarm-mono:')
    for (const name of CONTRACT_COLOR_VARS) {
      expect(rootBlock, `color defaults belong to hosts, not the shared sheet: ${name}`).not.toContain(`${name}:`)
    }
  })

  it('prefixes every stylesheet class with swarm- and covers every class the components render', () => {
    const sheetClasses = new Set([...rules.matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)]
      .map(match => match[1] ?? '')
      .filter(name => name !== ''))
    expect(sheetClasses.size).toBeGreaterThan(0)
    for (const name of sheetClasses) {
      expect(name.startsWith('swarm-'), `unprefixed class ${name}`).toBe(true)
    }
    const sources = ['SwarmPanel.tsx', 'TeamSummaryCard.tsx', 'TaskBoard.tsx', 'BudgetMeter.tsx', 'StatusCounters.tsx']
      .map(file => readFileSync(join(here, '..', 'src', 'components', file), 'utf8'))
    const renderedClasses = new Set(sources.flatMap(source =>
      [...source.matchAll(/className="([^"]+)"/g)].flatMap(match => (match[1] ?? '').split(/\s+/))))
    for (const name of renderedClasses) {
      expect(css, `component renders .${name} with no stylesheet rule`).toMatch(new RegExp(`\\.${name}[\\s,{:]`))
    }
  })
})
