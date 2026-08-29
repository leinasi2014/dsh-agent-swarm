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

export interface SafePixelRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly fill: string
  readonly opacity?: number
}
export interface SafePixelSvg {
  readonly size: number
  readonly rects: readonly SafePixelRect[]
}

const PIXEL_FILL = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$|^currentColor$/
/** Separate MIME (parser input) and namespace (parsed element) constants: DOMParser takes the
 *  MIME string, while parsed rect elements carry the SVG namespace URI (null under jsdom XML). */
const SVG_MIME = 'image/svg+xml'
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
/** Strict non-negative decimal: no exponent, no sign, no Infinity, no whitespace. */
const SVG_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/
const svgDecimal = (raw: string): number | undefined => {
  if (!SVG_DECIMAL.test(raw)) return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

/** Independent client-side allowlist parse of a backend-provided pixel-avatar SVG. The markup is
 *  NEVER interpolated: only an exact `viewBox="0 0 N N"` root (8..32) whose element children are
 *  `<rect>`s carrying at most x/y/width/height/fill/opacity (fill #RGB/#RRGGBB/currentColor,
 *  opacity 0..1, strict non-negative decimals) is accepted; anything else returns undefined and
 *  the caller falls back to the deterministic grid. Mirrors the host provisioning allowlist as a
 *  second, client-owned gate. */
export function parseSafePixelSvg(svg: string): SafePixelSvg | undefined {
  if (typeof svg !== 'string' || svg.length === 0 || svg.length > 16_384) return undefined
  let document: Document
  try {
    document = new DOMParser().parseFromString(svg, SVG_MIME)
  } catch {
    return undefined
  }
  if (document.querySelector('parsererror') !== null) return undefined
  const root = document.documentElement
  if (root === null || root.localName !== 'svg' || root.tagName.toLowerCase() !== 'svg') return undefined
  if (root.namespaceURI !== null && root.namespaceURI !== SVG_NAMESPACE) return undefined
  const viewBox = root.getAttribute('viewBox')
  const match = /^0 0 (\d{1,3}) (\d{1,3})$/.exec(viewBox ?? '')
  if (match === null) return undefined
  const size = Number(match[1])
  if (!Number.isInteger(size) || size !== Number(match[2]) || size < 8 || size > 32) return undefined
  if ([...root.attributes].some(attribute => attribute.name !== 'viewBox')) return undefined
  const rects: SafePixelRect[] = []
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === node.TEXT_NODE) {
      if ((node.textContent ?? '').trim() !== '') return undefined
      continue
    }
    if (node.nodeType !== node.ELEMENT_NODE) return undefined
    const element = node as Element
    // Real browsers report the SVG namespace; jsdom XML parsing reports null. Any other
    // namespace is rejected — the security gate stays the local-name + attribute allowlist,
    // and raw markup is never interpolated regardless, only converted to React rect elements.
    if (element.localName !== 'rect') return undefined
    if (element.namespaceURI !== null && element.namespaceURI !== SVG_NAMESPACE) return undefined
    const numeric = (name: string): number | undefined => {
      const raw = element.getAttribute(name)
      if (raw === null) return undefined
      return svgDecimal(raw)
    }
    const x = numeric('x')
    const y = numeric('y')
    const width = numeric('width')
    const height = numeric('height')
    if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined
    const fill = element.getAttribute('fill')
    if (fill === null || !PIXEL_FILL.test(fill)) return undefined
    const opacityRaw = element.getAttribute('opacity')
    let opacity: number | undefined
    if (opacityRaw !== null) {
      opacity = svgDecimal(opacityRaw)
      if (opacity === undefined || opacity > 1) return undefined
    }
    const allowed = new Set(['x', 'y', 'width', 'height', 'fill', ...(opacityRaw === null ? [] : ['opacity'])])
    if ([...element.attributes].some(attribute => !allowed.has(attribute.name))) return undefined
    // Rect boundary: fully inside the authored viewBox, positive extent.
    if (width <= 0 || height <= 0) return undefined
    if (x < 0 || y < 0 || x + width > size || y + height > size) return undefined
    rects.push({ x, y, width, height, fill, ...(opacity === undefined ? {} : { opacity }) })
  }
  if (rects.length === 0 || rects.length > 256) return undefined
  return { size, rects }
}

export function SafePixelAvatar({ seed, asset, name, t, className }: SafePixelAvatarProps) {
  const pattern = pixelPattern(seed)
  const generated = asset.state === 'generated'
  const unavailable = asset.state === 'unavailable'
  // A generated avatar may carry backend pixel markup; it renders only after the independent
  // client allowlist parse, converted to React elements. Anything unsafe falls back to the
  // deterministic grid — never dangerouslySetInnerHTML, never raw markup interpolation.
  const safe = generated && asset.svg !== undefined ? parseSafePixelSvg(asset.svg) : undefined
  const fallback = generated && asset.svg !== undefined && safe === undefined
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
      width={safe !== undefined ? safe.size * 8 : GRID * 8}
      height={safe !== undefined ? safe.size * 8 : GRID * 8}
      viewBox={safe !== undefined ? `0 0 ${String(safe.size)} ${String(safe.size)}` : `0 0 ${String(GRID)} ${String(GRID)}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={`${name} · ${label}`}
      data-swarm-pixel-avatar
      data-avatar-state={asset.state}
      data-avatar-reason={asset.reason}
      {...(fallback ? { 'data-avatar-fallback': 'unsafe-svg' } : {})}
      style={{ display: 'block', width: '100%', height: '100%', borderRadius: 4 }}
    >
      {safe !== undefined
        ? safe.rects.map((rect, index) => <rect key={String(index)} x={rect.x} y={rect.y} width={rect.width} height={rect.height} fill={rect.fill} {...(rect.opacity === undefined ? {} : { opacity: rect.opacity })} />)
        : <>
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
        </>}
    </svg>
  )
}
