import { describe, expect, it } from 'vitest'
import { identityPatch } from '../src/tools/identity-parameters.js'
import { isSafePixelAvatarSvg } from '../src/domain/identity-profile.js'

const palette = ['#172638', '#31435c', '#d99972', '#f4c39c', '#477d86', '#91bbc1', '#ac6a59', '#e8d5b1']
const rows = Array.from({ length: 32 }, (_, y) => y < 4 || y >= 28 ? '.'.repeat(32)
  : '....' + '0011223344556677'.repeat(2).slice(0, 24) + '....')
const input = { biography: 'Pixel portrait test', pixel_avatar: { palette, rows } }

describe('model-authored pixel avatar grid', () => {
  it('compiles an exact 32x32 palette grid into safe SVG without changing pixel colors or transparency', () => {
    const svg = identityPatch(input).pixelAvatarSvg
    expect(svg).toBeDefined()
    expect(isSafePixelAvatarSvg(svg!)).toBe(true)
    const reconstructed = Array.from({ length: 32 }, () => Array<string | undefined>(32))
    for (const rect of svg!.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" fill="(#[0-9a-f]{6})"\/>/g)) {
      const [, x, y, w, h, color] = rect
      for (let row = Number(y); row < Number(y) + Number(h); row++) {
        for (let col = Number(x); col < Number(x) + Number(w); col++) reconstructed[row]![col] = color!
      }
    }
    expect(reconstructed).toEqual(rows.map(row => [...row].map(pixel => pixel === '.' ? undefined : palette[Number.parseInt(pixel, 16)])))
    expect(new Set(reconstructed.flat().filter(Boolean)).size).toBe(8)
    expect((svg!.match(/<rect /g) ?? []).length).toBeLessThan(50)
  })

  it('rejects ambiguous input and invalid grids before any profile can be saved', () => {
    const invalid = [
      { ...input, pixel_avatar_svg: '<svg viewBox="0 0 32 32"><rect x="0" y="0" width="32" height="32" fill="#fff"/></svg>' },
      { ...input, pixel_avatar: { palette: ['url(https://example.test/x)'], rows } },
      { ...input, pixel_avatar: { palette, rows: rows.slice(1) } },
      { ...input, pixel_avatar: { palette, rows: ['x'.repeat(32), ...rows.slice(1)] } },
      { ...input, pixel_avatar: { palette, rows: ['F'.repeat(32), ...rows.slice(1)] } },
      { ...input, pixel_avatar: { palette, rows: ['0'.repeat(31), ...rows.slice(1)] } },
      { ...input, pixel_avatar: { palette, rows: Array(32).fill('.'.repeat(32)) } },
      { ...input, pixel_avatar: { palette, rows: Array.from({ length: 32 }, (_, y) => (y % 2 ? '01' : '10').repeat(16)) } },
    ]
    for (const candidate of invalid) expect(() => identityPatch(candidate)).toThrow()
  })
})
