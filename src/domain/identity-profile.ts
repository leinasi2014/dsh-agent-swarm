/**
 * Captain-declared member identity profile: bounded text fields plus a
 * strictly allowlisted *pixel-avatar* SVG.
 *
 * The avatar is deliberately NOT a general SVG parser. It admits exactly one
 * shape — a single `<svg viewBox="0 0 N N">` root (N in 8..32) whose only
 * children are self-closing `<rect>` elements (≤ 256) carrying at most
 * `x/y/width/height/fill/opacity`. Any other element (`g`, `path`, `circle`,
 * `ellipse`, `line`, `poly*`, `text`, `use`, `image`, `a`, …), any other
 * attribute (`id`, `class`, `style`, `transform`, `href`/`xlink:`, `on*`,
 * URL/`style`/`url()`), any script/foreignObject/animation, any entity, and
 * any texture/noise is rejected by construction. This small grammar is enough
 * to draw arbitrary pixel-art people/animals/shapes and is trivially safe to
 * publish back to a browser.
 *
 * Validation runs at member admission (in `provisionMember`) before the
 * durable record commits, so the stored `pixelAvatarSvg` is always the
 * sanitized allowlisted form or absent.
 */
import { TeamDomainError } from './error.js'

/** Codepoint bounds for the free-text identity fields. */
export const MAX_MEMBER_DISPLAY_NAME = 128
export const MAX_MEMBER_PROFESSION = 256
export const MAX_MEMBER_PERSONALITY = 1024

/** Upper bound (code units) on the whole pixel-avatar SVG string. */
export const MAX_PIXEL_AVATAR_LENGTH = 16_384
/** Maximum number of self-closing `<rect>` children. */
export const MAX_PIXEL_AVATAR_RECTS = 256
/** Inclusive square viewBox edge range: `viewBox="0 0 N N"` with 8 ≤ N ≤ 32. */
export const MIN_PIXEL_AVATAR_GRID = 8
export const MAX_PIXEL_AVATAR_GRID = 32
/** Per-attribute value length bound (code units). */
export const MAX_PIXEL_AVATAR_ATTR_LENGTH = 64

/** Bounded public announcement list on the Team aggregate. */
export const MAX_CAPTAIN_ANNOUNCEMENTS = 32
/** Per-announcement text bound (code points), matching admission. */
export const MAX_CAPTAIN_ANNOUNCEMENT_TEXT = 4096

export interface MemberIdentityInput {
  readonly displayName?: string
  readonly profession?: string
  readonly personality?: string
  readonly pixelAvatarSvg?: string
}

export interface NormalizedMemberIdentity {
  readonly displayName?: string
  readonly profession?: string
  readonly personality?: string
  readonly pixelAvatarSvg?: string
}

function unsafe(detail: string): never {
  throw new TeamDomainError(`member pixel avatar violates the strict allowlist: ${detail}`, 'TEAM_MEMBER_AVATAR_UNSAFE')
}

/** Rect attributes permitted on each self-closing `<rect>`. */
const RECT_ATTRS = new Set(['x', 'y', 'width', 'height', 'fill', 'opacity'])
/** Svg-root attribute permitted. `width`/`height`/`xmlns` are intentionally not
 *  admitted — the root may carry only `viewBox`. */
const SVG_ATTRS = new Set(['viewBox'])
/** Allowed fill values: `#RGB`, `#RRGGBB`, or `currentColor`. */
const FILL_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$|^currentColor$/u
const NUMBER_RE = /^(?:0|[1-9]\d*)(?:\.\d+)?$/u
const OPACITY_RE = /^(?:0|1|0(?:\.\d+)?|1(?:\.0+)?)$/u

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r'
}

/** Strict attribute scanner for one element open tag. Returns name/value pairs. */
function parseAttrs(tag: string, allowed: ReadonlySet<string>, owner: string): Array<readonly [string, string]> {
  const out: Array<readonly [string, string]> = []
  const seen = new Set<string>()
  let i = 0
  const len = tag.length
  while (i < len) {
    while (i < len && isWhitespace(tag[i]!)) i += 1
    if (i >= len) break
    const nameStart = i
    // Attribute names start lowercase and may contain camelCase and hyphens
    // (e.g. `viewBox`, `fill-opacity`); each is still matched exactly against
    // the strict per-element allowlist afterwards.
    while (i < len && /[a-zA-Z]/.test(tag[i]!)) i += 1
    while (i < len && /[a-zA-Z0-9-]/.test(tag[i]!)) i += 1
    const name = tag.slice(nameStart, i)
    if (!/^[a-z][a-zA-Z0-9-]*$/.test(name) || !allowed.has(name)) unsafe(`${owner} attribute "${name}" is not allowlisted`)
    while (i < len && isWhitespace(tag[i]!)) i += 1
    if (tag[i] !== '=') unsafe(`${owner} attribute "${name}" must have a quoted value`)
    i += 1
    while (i < len && isWhitespace(tag[i]!)) i += 1
    const quote = tag[i]
    if (quote !== '"' && quote !== "'") unsafe(`${owner} attribute "${name}" must use a quoted value`)
    i += 1
    let value = ''
    while (i < len && tag[i] !== quote) {
      value += tag[i]!
      i += 1
    }
    if (i >= len) unsafe(`${owner} attribute "${name}" is unterminated`)
    i += 1
    if ([...value].length > MAX_PIXEL_AVATAR_ATTR_LENGTH) unsafe(`${owner} attribute "${name}" is too long`)
    if (seen.has(name)) unsafe(`${owner} attribute "${name}" is duplicated`)
    seen.add(name)
    out.push([name, value])
  }
  return out
}

function boundNumber(raw: string, label: string): void {
  if (!NUMBER_RE.test(raw)) unsafe(`${label} must be a non-negative number`)
}

/**
 * Strict allowlist validation for one pixel avatar. Returns the trimmed SVG
 * (the allowlisted original, never rewritten). Throws `TEAM_MEMBER_AVATAR_UNSAFE`
 * on any structural or attribute violation. Length-bounded and deterministic.
 */
export function sanitizePixelAvatarSvg(raw: string): string {
  const value = raw.trim()
  if (value === '') unsafe('empty avatar')
  if (value.length > MAX_PIXEL_AVATAR_LENGTH) unsafe(`exceeds ${MAX_PIXEL_AVATAR_LENGTH} code units`)

  // Belt-and-suspenders substring firewall over the whole document; the strict
  // grammar already rejects these, but one cheap scan makes the invariant
  // readable and independent of the tokenizer.
  const lower = value.toLowerCase()
  for (const token of [
    '<script', '<style', '<foreignobject', '<animate', '<set', '<use', '<image',
    '<text', '<a ', '<g ', '<circle', '<ellipse', '<line ', '<polyline', '<polygon',
    '<path', 'url(', 'javascript:', 'onload', 'onerror', 'onclick', 'onmouse', 'onfocus',
    'href', 'xlink', '&#' , '<?' , '<!',
  ]) {
    if (lower.includes(token)) unsafe(`forbidden token "${token}"`)
  }

  const rootMatch = /^\s*<svg\b([^>]*)>(?:\s*)([\s\S]*?)(?:\s*)<\/svg>\s*$/su.exec(value)
  if (rootMatch === null) unsafe('must be exactly one <svg>…</svg> root')
  const rootAttrs = parseAttrs(rootMatch[1]!, SVG_ATTRS, 'svg')
  const rootAttrNames = new Set(rootAttrs.map(([name]) => name))
  if (!rootAttrNames.has('viewBox')) unsafe('svg must declare viewBox')

  for (const [name, attrValue] of rootAttrs) {
    if (name === 'viewBox') {
      const m = /^0\s+0\s+(\d{1,2})\s+(\d{1,2})$/u.exec(attrValue)
      if (m === null) unsafe('viewBox must be "0 0 N N"')
      const a = Number(m![1]); const b = Number(m![2])
      if (a !== b || a < MIN_PIXEL_AVATAR_GRID || a > MAX_PIXEL_AVATAR_GRID) {
        unsafe(`viewBox edge must be an integer in ${MIN_PIXEL_AVATAR_GRID}..${MAX_PIXEL_AVATAR_GRID}`)
      }
    } else {
      // Unreachable: parseAttrs already rejected any non-allowlisted root attr.
      unsafe(`svg attribute "${name}" is not allowlisted`)
    }
  }

  const body = rootMatch[2]!.trim()
  if (body !== '') {
    // The body must be whitespace plus self-closing `<rect …/>` tags only.
    let count = 0
    let index = 0
    const bodyLength = body.length
    while (index < bodyLength) {
      while (index < bodyLength && isWhitespace(body[index]!)) index += 1
      if (index >= bodyLength) break
      if (!body.startsWith('<rect', index)) unsafe('children must be self-closing <rect …/> only')
      let end = index
      while (end < bodyLength && body[end] !== '>') end += 1
      if (end >= bodyLength) unsafe('unterminated <rect> child')
      const tag = body.slice(index, end + 1)
      const rectMatch = /^<rect\b([^>]*?)\s*\/>$/u.exec(tag)
      if (rectMatch === null) unsafe('children must be self-closing <rect …/> only')
      const attrs = parseAttrs(rectMatch[1]!, RECT_ATTRS, 'rect')
      for (const [name, attrValue] of attrs) {
        switch (name) {
          case 'x':
          case 'y':
          case 'width':
          case 'height': boundNumber(attrValue, `rect.${name}`); break
          case 'fill': if (!FILL_RE.test(attrValue)) unsafe(`rect.fill must be #RGB/#RRGGBB/currentColor`); break
          case 'opacity': if (!OPACITY_RE.test(attrValue) || Number(attrValue) > 1) unsafe(`rect.opacity must be in 0..1`); break
          default: unsafe(`rect attribute "${name}" is not allowlisted`)
        }
      }
      count += 1
      index = end + 1
    }
    if (count > MAX_PIXEL_AVATAR_RECTS) unsafe(`more than ${MAX_PIXEL_AVATAR_RECTS} <rect> children`)
  }
  return value
}

/** Non-throwing allowlist predicate used by the persisted-state validator. */
export function isSafePixelAvatarSvg(value: string): boolean {
  try {
    sanitizePixelAvatarSvg(value)
    return true
  } catch {
    return false
  }
}

function optionalBounded(value: string | undefined, label: string, max: number): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  if ([...trimmed].length > max) {
    throw new TeamDomainError(`member ${label} exceeds ${max} code points`, 'TEAM_MEMBER_IDENTITY_INVALID')
  }
  return trimmed
}

/**
 * Validate a Captain-declared identity block and return the normalized form.
 * Free-text fields are trimmed; an empty string is treated as absent so the
 * read honestly reports `not_generated`. The pixel avatar must pass the strict
 * allowlist ({@link sanitizePixelAvatarSvg}). Called inside `provisionMember`
 * before the durable record commits.
 */
export function normalizeMemberIdentity(input: MemberIdentityInput): NormalizedMemberIdentity {
  const out: {
    displayName?: string
    profession?: string
    personality?: string
    pixelAvatarSvg?: string
  } = {}
  const displayName = optionalBounded(input.displayName, 'displayName', MAX_MEMBER_DISPLAY_NAME)
  const profession = optionalBounded(input.profession, 'profession', MAX_MEMBER_PROFESSION)
  const personality = optionalBounded(input.personality, 'personality', MAX_MEMBER_PERSONALITY)
  if (displayName !== undefined) out.displayName = displayName
  if (profession !== undefined) out.profession = profession
  if (personality !== undefined) out.personality = personality
  if (input.pixelAvatarSvg !== undefined) out.pixelAvatarSvg = sanitizePixelAvatarSvg(input.pixelAvatarSvg)
  return out
}

/** Normalize one Captain-published announcement: trimmed, non-empty, bounded. */
export function normalizeAnnouncementText(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') {
    throw new TeamDomainError('announcement text must be non-empty', 'TEAM_CAPTAIN_ANNOUNCEMENT_INVALID')
  }
  if ([...trimmed].length > MAX_CAPTAIN_ANNOUNCEMENT_TEXT) {
    throw new TeamDomainError(`announcement exceeds ${MAX_CAPTAIN_ANNOUNCEMENT_TEXT} code points`, 'TEAM_CAPTAIN_ANNOUNCEMENT_INVALID')
  }
  return trimmed
}
