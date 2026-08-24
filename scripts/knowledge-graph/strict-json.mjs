import { fail } from './diagnostics.mjs'

const whitespace = new Set([' ', '\t', '\r', '\n'])
export const JSON_LIMITS = Object.freeze({ bytes: 5 * 1024 * 1024, depth: 128, tokens: 500_000, stringCodeUnits: 1_000_000 })

export function parseStrictJson(text, label = '<json>') {
  if (typeof text !== 'string') fail('KG_JSON_INPUT', `${label} must be UTF-8 text`)
  if (text.charCodeAt(0) === 0xfeff) fail('KG_JSON_BOM', `${label} must not contain a BOM`)
  if (Buffer.byteLength(text, 'utf8') > JSON_LIMITS.bytes) fail('KG_JSON_SIZE_LIMIT', `${label} exceeds ${JSON_LIMITS.bytes} UTF-8 bytes`)

  let offset = 0
  let tokens = 0
  const skipWhitespace = () => {
    while (whitespace.has(text[offset])) offset += 1
  }
  const syntax = message => fail('KG_JSON_SYNTAX', `${label}:${offset}: ${message}`)

  const scanString = () => {
    if (text[offset] !== '"') syntax('expected string')
    const start = offset
    offset += 1
    while (offset < text.length) {
      const char = text[offset]
      if (char === '"') {
        offset += 1
        let value
        try {
          value = JSON.parse(text.slice(start, offset))
        } catch {
          syntax('invalid JSON string')
        }
        if (value.length > JSON_LIMITS.stringCodeUnits) fail('KG_JSON_STRING_LIMIT', `${label}:${start}: decoded string exceeds ${JSON_LIMITS.stringCodeUnits} code units`)
        return value
      }
      if (char === '\\') {
        offset += 1
        const escaped = text[offset]
        if (escaped === 'u') {
          const hex = text.slice(offset + 1, offset + 5)
          if (!/^[0-9a-fA-F]{4}$/u.test(hex)) syntax('invalid Unicode escape')
          offset += 5
          continue
        }
        if (!'"\\/bfnrt'.includes(escaped ?? '')) syntax('invalid escape')
        offset += 1
        continue
      }
      if (char.charCodeAt(0) < 0x20) syntax('unescaped control character')
      offset += 1
    }
    syntax('unterminated string')
  }

  const scanNumber = () => {
    const match = text.slice(offset).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u)
    if (!match) syntax('invalid number')
    offset += match[0].length
  }

  const scanLiteral = literal => {
    if (!text.startsWith(literal, offset)) syntax(`expected ${literal}`)
    offset += literal.length
  }

  const scanValue = (depth = 0) => {
    if (depth > JSON_LIMITS.depth) fail('KG_JSON_DEPTH_LIMIT', `${label}:${offset}: nesting exceeds ${JSON_LIMITS.depth}`)
    tokens += 1
    if (tokens > JSON_LIMITS.tokens) fail('KG_JSON_TOKEN_LIMIT', `${label}:${offset}: token count exceeds ${JSON_LIMITS.tokens}`)
    skipWhitespace()
    const char = text[offset]
    if (char === '{') {
      offset += 1
      skipWhitespace()
      const keys = new Set()
      if (text[offset] === '}') {
        offset += 1
        return
      }
      while (offset < text.length) {
        skipWhitespace()
        const key = scanString()
        if (keys.has(key)) fail('KG_JSON_DUPLICATE_KEY', `${label}:${offset}: duplicate key ${JSON.stringify(key)}`)
        keys.add(key)
        skipWhitespace()
        if (text[offset] !== ':') syntax('expected colon')
        offset += 1
        scanValue(depth + 1)
        skipWhitespace()
        if (text[offset] === '}') {
          offset += 1
          return
        }
        if (text[offset] !== ',') syntax('expected comma or closing brace')
        offset += 1
      }
      syntax('unterminated object')
    }
    if (char === '[') {
      offset += 1
      skipWhitespace()
      if (text[offset] === ']') {
        offset += 1
        return
      }
      while (offset < text.length) {
        scanValue(depth + 1)
        skipWhitespace()
        if (text[offset] === ']') {
          offset += 1
          return
        }
        if (text[offset] !== ',') syntax('expected comma or closing bracket')
        offset += 1
      }
      syntax('unterminated array')
    }
    if (char === '"') return void scanString()
    if (char === 't') return scanLiteral('true')
    if (char === 'f') return scanLiteral('false')
    if (char === 'n') return scanLiteral('null')
    return scanNumber()
  }

  skipWhitespace()
  scanValue()
  skipWhitespace()
  if (offset !== text.length) syntax('trailing content')
  try {
    return JSON.parse(text)
  } catch (error) {
    fail('KG_JSON_SYNTAX', `${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function assertNfc(value, path = '$', depth = 0) {
  if (depth > JSON_LIMITS.depth) fail('KG_JSON_DEPTH_LIMIT', `${path} exceeds normalized depth ${JSON_LIMITS.depth}`)
  if (typeof value === 'string') {
    if (value.normalize('NFC') !== value) fail('KG_JSON_NON_NFC', `${path} is not NFC-normalized`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNfc(item, `${path}[${index}]`, depth + 1))
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key.normalize('NFC') !== key) fail('KG_JSON_NON_NFC', `${path} contains a non-NFC key`)
      assertNfc(item, `${path}.${key}`, depth + 1)
    }
  }
}
