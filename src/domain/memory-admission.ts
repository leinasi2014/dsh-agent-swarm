/** Mandatory admission for new shared memory, not a rewrite of Session logs. */
import { Buffer } from 'node:buffer'
import { expectDomain } from './error.js'
import { nonEmpty } from './team-domain-shared.js'

const REDACTED = '[REDACTED]'
const PLACEHOLDER = /^(?:\*+|\[redacted\]|<redacted>|redacted|masked|已脱敏)$/iu
// Horizontal separators keep an empty label from consuming the next line.
const SEPARATOR = String.raw`[\t ]*(?:[\x60*'"]{0,2})[\t ]*(?:[:：=|]|\bis\b|是|为)[\t ]*`
// Paired emphasis is one value, including spaces, before the unquoted atom.
const EMPHASIS = String.raw`\*\*(?:(?!\*\*)[^\r\n])+\*\*|\*[^*\r\n]+\*`
const VALUE = String.raw`(?:${EMPHASIS}|"(?:\\[^\r\n]|[^"\\\r\n])*"|'(?:\\[^\r\n]|[^'\\\r\n])*'|\x60(?:\\[^\r\n]|[^\x60\\\r\n])*\x60|“[^”\r\n]*”|‘[^’\r\n]*’|<redacted>|\[redacted\]|[^\s,;，；。|&?#]+)`
const CREDENTIAL = String.raw`api[\t _-]*key|access[\t _-]*token|refresh[\t _-]*token|password|passwd|pwd|secret|authorization|token|key|API密钥|访问令牌|刷新令牌|密码|口令|密钥|令牌`
const PHONE_LABEL = String.raw`phone|mobile|telephone|tel|手机号|联系电话|电话|手机`
const PERSONAL_LABEL = String.raw`identity[\t _-]*(?:number|no)|id[\t _-]*(?:number|no)|(?:credit[\t _-]*|bank[\t _-]*)?card[\t _-]*(?:number|no)|身份证号?|证件号|银行卡号|信用卡号`
const labelled = (labels: string, value: string): RegExp => new RegExp(
  String.raw`((?<![A-Za-z0-9_])(?:${labels})${SEPARATOR})(${value})`, 'giu',
)
const credentials = labelled(CREDENTIAL, String.raw`(?:Bearer[\t ]+)?${VALUE}`)
// Grouped numbers consume complete numeric-led atoms, including an attached
// X/letter/hyphen suffix. Never accept a digits-only prefix of the final atom.
// Ordinary prose and the existing URL/table delimiters remain outside it.
const GROUPED_NUMBER = String.raw`\d[^\s,;，；。|&?#]*(?:[\t ]+\d[^\s,;，；。|&?#]*)+`
const personal = labelled(PERSONAL_LABEL, String.raw`(?:${GROUPED_NUMBER}|${VALUE})`)
const phone = labelled(PHONE_LABEL, String.raw`(?:(?:\+?\d|\(\d)[\d\t ().-]*\d\)?|${VALUE})`)
const email = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu
// A standalone mainland mobile, optionally +86/86-prefixed. Identifier/path
// characters at either boundary exclude task IDs and arbitrary numeric keys.
const mobile = /(?<![\p{L}\p{N}_./-])(?:\+?86[\t -]?)?1[3-9]\d{9}(?![\p{L}\p{N}_.-])/gu

function redactValue(value: string): string {
  if (PLACEHOLDER.test(value)) return value
  for (const marker of ['**', '*']) {
    if (value.length > marker.length * 2 && value.startsWith(marker) && value.endsWith(marker)) {
      return marker + redactValue(value.slice(marker.length, -marker.length)) + marker
    }
  }
  const quotes: Record<string, string> = { '"': '"', "'": "'", '`': '`', '“': '”', '‘': '’' }
  const closing = quotes[value[0]!]
  if (closing !== undefined && value.endsWith(closing)) {
    return value[0] + redactValue(value.slice(1, -1)) + closing
  }
  const bearer = /^Bearer[\t ]+/iu.exec(value)?.[0] ?? ''
  const body = value.slice(bearer.length)
  if (PLACEHOLDER.test(body)) return value
  return bearer + REDACTED
}

/** Fixed field errors never embed the original memory or a matched value. */
export function admitMemoryText(value: string, label: string, maxBytes: number): string {
  expectDomain(typeof value === 'string', `${label} must be a string`, 'TEAM_INPUT_INVALID')
  expectDomain(Buffer.byteLength(value, 'utf8') <= maxBytes, `${label} is too large`, 'TEAM_INPUT_LIMIT')
  const original = nonEmpty(value, label, maxBytes)
  const transformed = original
    .replace(credentials, (_match, prefix: string, secret: string) => prefix + redactValue(secret))
    .replace(personal, (_match, prefix: string, pii: string) => prefix + redactValue(pii))
    .replace(phone, (_match, prefix: string, pii: string) => prefix + redactValue(pii))
    .replace(email, REDACTED)
    .replace(mobile, REDACTED)
  return nonEmpty(transformed, label, maxBytes)
}
