import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { SWARM_READ_RPC_FIXTURES_V1 } from '../src/rpc/read-rpc-artifact.js'
import { retirementBrowserScript } from './helpers/retirement-browser.js'

function fixture() {
  const values = SWARM_READ_RPC_FIXTURES_V1.values
  const teams = structuredClone(values.teams)
  teams.teams = [{ ...teams.teams[0]!, name: '角色美术制作与参考核验', displayName: '团队队长', phase: 'active' }]
  Object.assign(teams.binding, { mainSessionId: 'actual-main' })
  return { open: true, phase: 'ready', targetSessionId: 'actual-main', data: { capabilities: values.capabilities,
    projection: values.snapshot, teams, captainMembers: values.captainMembers, captainAnnouncements: values.captainAnnouncements, captainDiagnostics: values.captainDiagnostics } }
}
const preview = { schemaVersion: 1, teamName: '角色美术制作与参考核验', teamRevision: 4, phase: 'active', previewDigest: 'a'.repeat(64), deletion: { available: true },
  counts: { sessions: 3, memories: 2, humanInteractions: 1, workflowRuns: 1, protectedSessions: 1, unfinishedTasks: 2, activeAttempts: 1 } }

it('keeps a 166px sidebar readable and portals usable in light/dark narrow viewports, preserving a pending target across Session changes', async () => {
  const script = await retirementBrowserScript()
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 813, height: 731 } })
    // An HTTP origin makes the real sessionStorage-backed retry client available.
    await page.route('http://localhost/', route => route.fulfill({ body: '<!doctype html><html><body><div id="fixture-root" style="width:166px;height:100vh;overflow:hidden;border-right:1px solid #9994"></div></body></html>', contentType: 'text/html' }))
    await page.goto('http://localhost/')
    await page.addStyleTag({ content: 'body{margin:0;background:var(--dsw-alias-bg-base);font:14px system-ui;--dsw-alias-bg-base:#fff;--dsw-alias-label-primary:#223047;--dsw-alias-label-secondary:#69778c;--dsw-alias-label-tertiary:#69778c;--dsw-alias-border-l2:#d8deea;--dsw-alias-state-business-primary:#4267bc}' })
    await page.addScriptTag({ content: script })
    const state = fixture()
    await page.evaluate(({ state, preview }) => (window as never as { mountRetirement(a: unknown, b: unknown): void }).mountRetirement(state, preview), { state, preview })
    await page.locator('[data-swarm-group]').click()
    const captain = page.locator('[data-swarm-group-captain]')
    const dimensions = await captain.evaluate(node => {
      const small = node.querySelector('small')!, box = node.getBoundingClientRect()
      return { height: box.height, right: box.right, smallHeight: small.getBoundingClientRect().height, nowrap: getComputedStyle(small).whiteSpace }
    })
    expect(dimensions.height).toBeLessThan(45)
    expect(dimensions.right).toBeLessThanOrEqual(166)
    expect(dimensions.smallHeight).toBeLessThanOrEqual(19)
    expect(dimensions.nowrap).toBe('nowrap')
    const screenshots = process.env['SWARM_UI_EVIDENCE_DIR']
    if (screenshots) { await mkdir(screenshots, { recursive: true }); await page.screenshot({ path: `${screenshots}/retirement-sidebar-166.png` }) }
    await page.locator('.swarm-groups__more').click()
    const menu = page.getByRole('menu')
    const menuBounds = await menu.boundingBox()
    expect(menuBounds!.x + menuBounds!.width).toBeGreaterThan(166)
    expect(await menu.locator('button').first().evaluate(node => node === document.activeElement)).toBe(true)
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.locator('[data-retirement-confirm-name]').fill(preview.teamName)
    for (const [width, dark] of [[813, false], [390, true], [320, true]] as const) {
      await page.setViewportSize({ width, height: 731 })
      if (dark) await page.addStyleTag({ content: 'body{--dsw-alias-bg-base:#202124;--dsw-alias-label-primary:#e5e7eb;--dsw-alias-label-secondary:#a0a8b7;--dsw-alias-border-l2:#41434a}' })
      const bounds = await page.getByRole('dialog').boundingBox()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
      expect(await page.getByRole('dialog').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
      if (screenshots) await page.screenshot({ path: `${screenshots}/retirement-delete-${dark ? 'dark' : 'light'}-${width}.png` })
    }
    // Opening another Main and losing the deleted Team cannot retarget this operation.
    await page.evaluate(() => (window as never as { updateRetirement(a: unknown): void }).updateRetirement({ open: true, phase: 'loading', targetSessionId: 'other-main', data: undefined }))
    expect(await page.getByRole('dialog').count()).toBe(1)
    expect(await page.locator('[data-retirement-confirm-name]').inputValue()).toBe(preview.teamName)
    await page.evaluate(state => (window as never as { updateRetirement(a: unknown): void }).updateRetirement(state), { ...state, targetSessionId: 'other-main', data: { ...state.data, teams: { ...state.data.teams, binding: { ...state.data.teams.binding, mainSessionId: 'other-main' }, teams: [] } } })
    await page.locator('[data-retirement-confirm]').click()
    await page.getByRole('button', { name: '查询结果', exact: true }).waitFor()
    const calls = await page.evaluate(() => (window as never as { calls: { method: string; input: { target: { rootSessionId: string } } }[] }).calls)
    expect(calls.find(call => call.method.endsWith('/execute'))?.input.target.rootSessionId).toBe('actual-main')
    await page.getByRole('button', { name: '查询结果', exact: true }).click()
    expect(await page.getByRole('dialog').count()).toBe(1)
    expect((await page.evaluate(() => (window as never as { calls: { method: string; input: { target: { rootSessionId: string } } }[] }).calls)).at(-1)?.input.target.rootSessionId).toBe('actual-main')
  } finally { await browser.close() }
}, 60_000)

it('recovers the original delete request after a real page reload when the Team is absent, without another execute', async () => {
  const script = await retirementBrowserScript()
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  try {
    const page = await browser.newPage()
    await page.route('http://localhost/', route => route.fulfill({ body: '<!doctype html><html><body><div id="fixture-root"></div></body></html>', contentType: 'text/html' }))
    await page.goto('http://localhost/')
    await page.addScriptTag({ content: script })
    await page.evaluate(({ state, preview }) => (window as never as { mountRetirement(a: unknown, b: unknown): void }).mountRetirement(state, preview), { state: fixture(), preview })
    await page.locator('.swarm-groups__more').click()
    await page.getByRole('menuitem', { name: '永久删除', exact: true }).click()
    await page.locator('[data-retirement-confirm-name]').fill(preview.teamName)
    await page.locator('[data-retirement-confirm]').click()
    await page.getByRole('button', { name: '继续原请求', exact: true }).waitFor()
    const original = await page.evaluate(() => (window as never as { calls: { method: string; input: import('../src/shared/team-retirement.js').RetirementRequest }[] }).calls.find(call => call.method.endsWith('/execute'))!.input)
    await page.reload()
    await page.addScriptTag({ content: script })
    const result = { schemaVersion: 1, target: original.target, requestId: original.requestId, action: original.action,
      state: 'completed', counts: preview.counts, replayed: true, teamRevision: 5 }
    await page.evaluate(({ preview, result }) => (window as never as { mountRetirement(a: unknown, b: unknown, c: unknown): void }).mountRetirement(
      { open: true, phase: 'loading', targetSessionId: 'other-main', data: undefined }, preview, result), { preview, result })
    expect(await page.locator('[data-swarm-group]').count()).toBe(0)
    await page.locator('[data-retirement-saved-request]').click()
    await page.waitForFunction(() => (window as never as { completed: unknown[] }).completed.length === 1)
    const recovered = await page.evaluate(() => ({ calls: (window as never as { calls: unknown[] }).calls,
      completed: (window as never as { completed: unknown[] }).completed, saved: sessionStorage.length }))
    expect(recovered.calls).toEqual([{ method: 'team/v1/requestResult', input: { schemaVersion: 1, target: original.target, requestId: original.requestId } }])
    expect(recovered.completed).toEqual([result])
    expect(recovered.saved).toBe(0)
    expect(await page.locator('[data-retirement-requests]').count()).toBe(0)
  } finally { await browser.close() }
}, 60_000)
