/** Compile model-authored pixels into the existing bounded, allowlisted SVG asset. */
import { TeamDomainError } from './error.js'
import { sanitizePixelAvatarSvg } from './identity-profile.js'

export interface PixelAvatarGrid { readonly palette: readonly string[]; readonly rows: readonly string[] }
interface Rect { x: number; y: number; width: number; height: number; fill: string }

function invalid(message: string): never { throw new TeamDomainError(`pixel avatar grid: ${message}`, 'TEAM_MEMBER_AVATAR_UNSAFE') }

export function compilePixelAvatarGrid(input: PixelAvatarGrid): string {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalid('expected palette and rows')
  if (Object.keys(input).some(key => key !== 'palette' && key !== 'rows')) invalid('unknown field')
  if (!Array.isArray(input.palette) || input.palette.length < 1 || input.palette.length > 16
    || input.palette.some(color => typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color))) invalid('palette must contain 1-16 #RRGGBB colors')
  if (!Array.isArray(input.rows) || input.rows.length !== 32
    || input.rows.some(row => typeof row !== 'string' || !/^[.0-9a-f]{32}$/i.test(row))) invalid('supply exactly 32 rows, each 32 pixels using . or 0-9/A-F')
  const palette = input.palette.map(color => color.toLowerCase())
  const rects: Rect[] = []
  let previous = new Map<string, Rect>()
  for (let y = 0; y < 32; y++) {
    const row = input.rows[y]!.toUpperCase()
    const current = new Map<string, Rect>()
    for (let x = 0; x < 32;) {
      const pixel = row[x]!
      let end = x + 1
      while (end < 32 && row[end] === pixel) end++
      if (pixel !== '.') {
        const fill = palette[Number.parseInt(pixel, 16)]
        if (fill === undefined) invalid(`row ${y + 1} uses a missing palette color ${pixel}`)
        const key = `${x}:${end - x}:${fill}`
        let rect = previous.get(key)
        if (rect === undefined) { rect = { x, y, width: end - x, height: 1, fill }; rects.push(rect) }
        else rect.height++
        current.set(key, rect)
      }
      x = end
    }
    previous = current
  }
  if (rects.length === 0) invalid('avatar is fully transparent')
  if (rects.length > 256) invalid('too many isolated pixel runs; simplify tiny checkerboard details (maximum 256 rectangles)')
  return sanitizePixelAvatarSvg('<svg viewBox="0 0 32 32">' + rects.map(rect =>
    `<rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" fill="${rect.fill}"/>`).join('') + '</svg>')
}
