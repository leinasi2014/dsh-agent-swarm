import { describe, expect, it } from 'vitest'
import { hasUnconfirmedPublicMention, normalizePublicContent, publicContentSchema, publicMentionStarts,
  publicMentionIds, renderPublicContent, renderPublicText } from '../src/shared/public-content.js'

describe('public content shared admission and rendering', () => {
  it('keeps exact ordered IDs and escapes while normalizing only adjacent text and outside whitespace', () => {
    const content = normalizePublicContent([{ type: 'text', text: '  请' }, { type: 'text', text: '检查' },
      { type: 'mention', memberId: 'b' }, { type: 'mention', memberId: 'a' }, { type: 'mention', memberId: 'b' },
      { type: 'text', text: String.raw` 与 \@literal  ` }])
    expect(publicMentionIds(content)).toEqual(['b', 'a'])
    expect(renderPublicContent(content, [{ memberId: 'b', label: '乙' }, { memberId: 'a', label: '甲' }]))
      .toBe('请检查@乙@甲@乙 与 @literal')
    expect(content.at(-1)).toEqual({ type: 'text', text: String.raw` 与 \@literal` })
  })
  it('shares candidate starts for Chinese, punctuation, email, package and decorator text', () => {
    expect(publicMentionStarts('请@甲，@乙 a@example.com foo_bar@x')).toEqual([1, 4])
    expect(hasUnconfirmedPublicMention([{ type: 'text', text: '@pkg/x' }])).toBe(true)
    expect(publicMentionStarts(String.raw`\@pkg/x \@decorator`)).toEqual([])
    expect(publicMentionStarts(String.raw`\\@甲`)).toEqual([2])
    expect(renderPublicText(String.raw`\@a \\\@b \\@c \path`)).toBe(String.raw`@a \@b \\@c \path`)
  })
  it('rejects wire labels and alternate addressing while literal rendering never reparses legacy or Agent text', () => {
    expect(publicContentSchema.safeParse([{ type: 'mention', memberId: 'a', label: 'captain' }]).success).toBe(false)
    expect(renderPublicContent([{ type: 'text', text: String.raw`\@literal @person` }], [], true)).toBe(String.raw`\@literal @person`)
  })
})
