/** Streaming visible-text heuristic: fixed work per character, no retained chunk. */
import type { GuardNotice } from './execution-guard-tools.js'

export class TextProgress {
  private readonly tail: string[] = Array.from({ length: 256 }, () => '')
  private readonly matches = new Uint16Array(257)
  private readonly tailBytes = new Uint8Array(256)
  private readonly tailSubstantive = new Uint8Array(256)
  private readonly periodBytes = new Uint16Array(257)
  private readonly periodSubstantive = new Uint16Array(257)
  private position = 0
  private length = 0
  private warned = false
  private lineStart = true
  private prefix = ''
  private fence: string | undefined
  private fenceLength = 0
  private opening = false
  private openingRun = false
  private closeRun = 0
  private closeSpaces = 0
  private closePhase: 'space' | 'run' | 'tail' | 'invalid' = 'space'

  /** Retained visible characters are at most 256 code points (at most 1 KiB). */
  get retainedBytes(): number { return Buffer.byteLength(this.tail.join('') + this.prefix) }
  private resetPattern(): void {
    this.tail.fill(''); this.matches.fill(0); this.length = 0; this.position = 0
    this.tailBytes.fill(0); this.tailSubstantive.fill(0)
    this.periodBytes.fill(0); this.periodSubstantive.fill(0)
  }
  private visible(character: string): GuardNotice | undefined {
    let warning: GuardNotice | undefined
    const bytes = Buffer.byteLength(character)
    const substantive = character.trim() === '' ? 0 : 1
    for (let period = 12; period <= 256; period += 1) {
      const index = (this.position - period + 256) % 256
      const full = this.length >= period
      // Each candidate window drops one point and gains one point. Never
      // rescan a periodic suffix: whitespace must cost the same as prose.
      this.periodBytes[period] = this.periodBytes[period]! + bytes - (full ? this.tailBytes[index]! : 0)
      this.periodSubstantive[period] = this.periodSubstantive[period]! + substantive - (full ? this.tailSubstantive[index]! : 0)
      if (!full) continue
      this.matches[period] = character === this.tail[index] ? Math.min(8_192, this.matches[period]! + 1) : 0
      const count = Math.floor((this.matches[period]! + period) / period)
      if (count < 16 || this.periodSubstantive[period] === 0) continue
      const repeatedBytes = this.periodBytes[period]! * count
      if (count >= 32 && repeatedBytes >= 512) return { level: 'CRITICAL', detector: 'visible-text', count }
      if (!this.warned && repeatedBytes >= 256) {
        this.warned = true
        warning = { level: 'WARNING', detector: 'visible-text', count }
      }
    }
    this.tail[this.position] = character
    this.tailBytes[this.position] = bytes
    this.tailSubstantive[this.position] = substantive
    this.position = (this.position + 1) % 256
    this.length = Math.min(256, this.length + 1)
    return warning
  }
  private fenced(character: string): void {
    if (this.opening) {
      if (this.openingRun && character === this.fence) this.fenceLength = Math.min(Number.MAX_SAFE_INTEGER, this.fenceLength + 1)
      else this.openingRun = false
      if (character !== '\n') return
      this.opening = false
    } else if (character === '\n') {
      if (this.closeRun >= this.fenceLength && this.closePhase !== 'invalid') {
        this.fence = undefined
        this.lineStart = true
      }
    } else if (this.closePhase === 'space' && character === ' ' && this.closeSpaces < 3) this.closeSpaces += 1
    else if ((this.closePhase === 'space' || this.closePhase === 'run') && character === this.fence) {
      this.closePhase = 'run'; this.closeRun = Math.min(Number.MAX_SAFE_INTEGER, this.closeRun + 1)
    } else if ((this.closePhase === 'run' || this.closePhase === 'tail') && (character === ' ' || character === '\r' || character === '\t')) this.closePhase = 'tail'
    else this.closePhase = 'invalid'
    if (character === '\n') { this.closeRun = 0; this.closeSpaces = 0; this.closePhase = 'space' }
  }
  feed(text: string): GuardNotice[] {
    const notices: GuardNotice[] = []
    for (const character of text) {
      if (this.fence !== undefined) { this.fenced(character); continue }
      let visible = character
      if (this.lineStart) {
        this.prefix += character
        const trimmed = this.prefix.trimStart()
        if (trimmed.length === 0 && character === ' ' && this.prefix.length <= 3) continue
        if ((trimmed[0] === '`' || trimmed[0] === '~') && [...trimmed].every(point => point === trimmed[0])) {
          if (trimmed.length < 3) continue
          this.fence = trimmed[0]; this.fenceLength = 3; this.opening = true; this.openingRun = true
          this.prefix = ''; this.resetPattern(); continue
        }
        visible = this.prefix; this.prefix = ''; this.lineStart = false
      }
      for (const point of visible) {
        const notice = this.visible(point)
        if (notice !== undefined) notices.push(notice)
        if (notice?.level === 'CRITICAL') return notices
      }
      if (character === '\n') this.lineStart = true
    }
    return notices
  }
}
