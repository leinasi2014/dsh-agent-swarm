// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { chatState, teamState } from './helpers/public-chat-fixtures.js'

// #276 typing-jitter regression (user report: the chat window jitters on every typed character).
// Root suspicion under measurement: per keystroke draft persistence toggles draftStatus saving↔ready, and the
// space-occupying save notice reflows header/messages/composer/textarea. This RED drives the real save cadence
// through the real React mount and locks every layout rect across both saving and ready frames.
// failure/conflict recovery semantics stay asserted where they live today; this cell only forbids normal-input reflow.

type Driver = { mountChat: (team: unknown, chat: unknown, activity?: unknown, goal?: unknown) => Promise<void>; updateChat: (team: unknown, chat: unknown) => void }

it('#276 typing through draft persistence cycles keeps chat layout rects stable', async () => {
  const { publicImagesBrowserScript } = await import('./helpers/public-images-browser.js')
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ channel: 'msedge', headless: true }), script = await publicImagesBrowserScript()
  const team = teamState(), chat = chatState(team)
  try {
    const page = await browser.newPage({ viewport: { width: 813, height: 900 } })
    await page.setContent(`<style>body{margin:0;font-family:system-ui;--dsw-alias-label-primary:#223047;--dsw-alias-label-secondary:#69778c;--dsw-alias-bg-base:#f8f9fc;--dsw-alias-bg-layer-1:white;--dsw-alias-border-l2:#d8deea;--dsw-alias-state-business-primary:#4267bc}#fixture-root{height:900px}.fixture-modal-root{position:fixed;inset:0;z-index:20;display:flex;align-items:center;justify-content:center}.fixture-modal-mask{position:absolute;inset:0;background:#0009}.fixture-modal-dialog{position:relative}</style><div id="fixture-root"></div>`)
    await page.addScriptTag({ content: script })
    await page.evaluate(async ({ team: teamValue, chat: chatValue }) => { await (window as unknown as Driver).mountChat(teamValue, chatValue) }, { team, chat })
    await page.locator('.swarm-public__composer textarea').waitFor()
    const geometry = () => page.evaluate(() => {
      const rect = (selector: string) => { const box = document.querySelector(selector)!.getBoundingClientRect(); return [box.x, box.y, box.width, box.height] }
      return { header: rect('.swarm-public__header'), messages: rect('.swarm-public__messages'), composer: rect('.swarm-public__composer'), input: rect('.swarm-public__composer textarea') }
    })
    const baseline = await geometry()
    let text = ''
    for (const char of '逐字输入不应抖动') {
      text += char
      // 真实逐字节奏（root 以 controller 实测校准）：草稿文本更新先于 saving，持久完成回 ready。
      await page.evaluate(({ team: teamValue, chat: chatValue, text: next }: { team: unknown; chat: typeof chat; text: string }) => {
        (window as unknown as Driver).updateChat(teamValue, { ...chatValue, draft: { ...chatValue.draft, text: next }, draftStatus: 'saving' })
      }, { team, chat, text })
      expect(await geometry(), `saving frame must not reflow while typing "${text}"`).toEqual(baseline) // 占位保存提示即抖动根因
      await page.evaluate(({ team: teamValue, chat: chatValue, text: next }: { team: unknown; chat: typeof chat; text: string }) => {
        (window as unknown as Driver).updateChat(teamValue, { ...chatValue, draft: { ...chatValue.draft, text: next }, draftStatus: 'ready' })
      }, { team, chat, text })
      expect(await geometry(), `ready frame must not drift after "${text}"`).toEqual(baseline)
    }
    // 恢复语义不弱化：loading/conflict/unavailable 三态仍可见可恢复（覆盖面格），只是正常 saving 不再占行。
    const statusState = async (draftStatus: string) => { await page.evaluate(({ team: teamValue, chat: chatValue, status }: { team: unknown; chat: typeof chat; status: string }) => {
      (window as unknown as Driver).updateChat(teamValue, { ...chatValue, draftStatus: status })
    }, { team, chat, status: draftStatus }) }
    await statusState('conflict')
    expect(await page.locator('[data-public-draft-status="conflict"]').count()).toBe(1)
    expect(await page.locator('[data-public-draft-status="conflict"] button').count()).toBe(1) // useStoredDraft 可达
    await statusState('unavailable')
    expect(await page.locator('[data-public-draft-status="unavailable"]').count()).toBe(1)
    expect(await page.locator('[data-public-draft-status="unavailable"] button').count()).toBe(1) // retryDraftStorage 可达
    await statusState('loading')
    expect(await page.locator('[data-public-draft-status="loading"]').count()).toBe(1) // hydration 期一次性提示仍可见（非逐字抖动源）
  } finally { await browser.close() }
}, 60_000)
