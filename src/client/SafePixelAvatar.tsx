/** Deterministic, safe pixel-grid avatar with an honest asset placeholder.
 *
 *  The backend never fabricates an avatar: it reports an explicit `SwarmReadAssetStatusV1`
 *  (`generated` | `not_generated` | `unavailable`). This component only ever draws from a
 *  deterministic seed (the technical identity name) and:
 *    - generated    → a colored symmetric pixel grid derived from the seed,
 *    - not_generated → the same grid muted to grayscale with a dashed "not generated" frame,
 *    - unavailable   → a faint grid with a dashed "unavailable" frame.
 *  No HTML string is ever interpolated (pure SVG elements only), and the state is exposed via
 *  `data-avatar-state` / `data-avatar-reason` plus a human `aria-label`, never a fake asset. */
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SwarmReadAssetStatusV1 } from '../rpc/read-rpc-contract.js'
import { TEAM_DASHBOARD_NS } from './team-dashboard-locales.js'

const GRID = 5
/** Right-half count (including the shared centre column) of a horizontally symmetric 5-cell avatar. */
const HALF = Math.ceil(GRID / 2)

export interface SafePixelAvatarProps {
  /** Technical identity seed (name). The pixel pattern is a pure function of this string. */
  readonly seed: string
  /** Honest backend asset status; never fabricated by this component. */
  readonly asset: SwarmReadAssetStatusV1
  /** Human-readable name used only for the accessible label. */
  readonly name: string
  readonly t: TranslateNS<typeof TEAM_DASHBOARD_NS>
  readonly className?: string
}

/** FNV-1a over the UTF-8 bytes; deterministic, tiny, and safe for arbitrary names. */
function hashSeed(seed: string): number {
  let hash = 0x811c9dc5
  const bytes = new TextEncoder().encode(seed)
  for (const byte of bytes) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** Horizontally symmetric 5×5 on/off pattern, seeded deterministically from the name. */
export function pixelPattern(seed: string): readonly (readonly boolean[])[] {
  const hash = hashSeed(seed)
  const cells: boolean[] = Array.from({ length: GRID * GRID }, () => false)
  // Derive bits from a xorshift stream; mirror the left half so the avatar reads as an identicon.
  let state = hash || 0x9e3779b9
  const next = (): number => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state
  }
  for (let row = 0; row < GRID; row += 1) {
    for (let col = 0; col < HALF; col += 1) {
      const on = (next() & (1 << (col % 4))) !== 0
      cells[row * GRID + col] = on
      cells[row * GRID + (GRID - 1 - col)] = on
    }
  }
  const rows: boolean[][] = []
  for (let row = 0; row < GRID; row += 1) rows.push(cells.slice(row * GRID, row * GRID + GRID))
  return rows
}

/** Deterministic colored / muted palettes keyed off one seed hash. */
function palette(seed: string): readonly [string, string] {
  const hash = hashSeed(`${seed}:palette`)
  const hue = hash % 360
  return [
    `hsl(${String(hue)} 62% 46%)`,
    `hsl(${String((hue + 40) % 360)} 55% 82%)`,
  ]
}

export function SafePixelAvatar({ seed, asset, name, t, className }: SafePixelAvatarProps) {
  const pattern = pixelPattern(seed)
  const generated = asset.state === 'generated'
  const unavailable = asset.state === 'unavailable'
  const [fg, bg] = palette(seed)
  // Muted placeholder states follow the official DSH theme aliases (light/dark) via style
  // properties; only a *generated* asset carries its own deterministic seed palette.
  const mutedFill = 'var(--dsw-alias-label-secondary)'
  const mutedBg = 'var(--dsw-alias-bg-layer-1)'
  const frameStroke = 'var(--dsw-alias-border-l2)'
  const label = generated ? t('avatarGeneratedLabel')
    : unavailable ? t('avatarUnavailableLabel') : t('avatarNotGeneratedLabel')
  const opacity = generated ? 1 : unavailable ? 0.35 : 0.7
  return (
    <svg
      className={className}
      width={GRID * 8}
      height={GRID * 8}
      viewBox={`0 0 ${String(GRID)} ${String(GRID)}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={`${name} · ${label}`}
      data-swarm-pixel-avatar
      data-avatar-state={asset.state}
      data-avatar-reason={asset.reason}
      style={{ display: 'block', width: '100%', height: '100%', borderRadius: 4 }}
    >
      {generated
        ? <rect x="0" y="0" width={GRID} height={GRID} rx="0.35" fill={bg} />
        : <rect x="0" y="0" width={GRID} height={GRID} rx="0.35" style={{ fill: mutedBg }} />}
      <g opacity={opacity} strokeWidth={0.08} style={generated ? undefined : { stroke: frameStroke }}>
        {pattern.flatMap((row, rowIndex) => row.map((on, colIndex) => {
          if (!on) return null
          const key = `${rowIndex}-${colIndex}`
          return generated
            ? <rect key={key} x={colIndex} y={rowIndex} width="1" height="1" fill={fg} />
            : <rect key={key} x={colIndex} y={rowIndex} width="1" height="1" style={{ fill: mutedFill }} />
        }))}
      </g>
    </svg>
  )
}
