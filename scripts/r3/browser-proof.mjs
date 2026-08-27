import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'

const TEAM_NAME = /^(Team|团队)$/u
const OPEN_CHAT = /^(Open Captain Chat|打开 Captain 对话)$/u
const TOOL_DETAILS = /^(Tool details|工具详情)$/u
const GEOMETRY_SETTLE_TIMEOUT_MS = 5_000
const GEOMETRY_SAMPLE_MS = 50
const GEOMETRY_STABILITY_PX = 2
const VISIBLE_CHAT_ERROR = /(?:Failed to load history:|历史加载失败：|This turn failed|本轮失败|此轮失败)/u

async function launchBrowser(executablePath) {
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath === undefined ? {} : { executablePath }),
  })
  return {
    browser,
    identity: {
      engine: 'chromium',
      executablePath: executablePath ?? chromium.executablePath(),
      version: browser.version(),
    },
  }
}

async function selectRootSession(page) {
  const team = page.getByRole('button', { name: TEAM_NAME })
  if (await team.count() > 0) return team
  const rows = page.getByRole('treeitem')
  await rows.first().waitFor({ state: 'visible', timeout: 20_000 })
  const blank = rows.filter({ hasText: /New Session|新会话/u })
  await (await blank.count() > 0 ? blank.first() : rows.first()).click()
  await team.waitFor({ state: 'visible', timeout: 20_000 })
  return team
}

function recordBrowser(page) {
  const consoleErrors = []
  const pageErrors = []
  const swarmRequests = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', (request) => {
    if (!request.url().endsWith('/swarm/v1')) return
    let body
    try { body = request.postDataJSON() } catch { body = request.postData() }
    swarmRequests.push({ method: request.method(), body })
  })
  return { consoleErrors, pageErrors, swarmRequests }
}

function assertReadOnlyRequests(records) {
  const allowed = new Set(['capabilities', 'binding', 'status', 'snapshot', 'page'])
  if (records.swarmRequests.length === 0) throw new Error('browser emitted no /swarm/v1 request')
  for (const request of records.swarmRequests) {
    if (request.method !== 'POST' || !allowed.has(request.body?.method)) {
      throw new Error(`browser emitted a non-read /swarm request: ${JSON.stringify(request)}`)
    }
  }
}

function assertCleanBrowser(records, label) {
  if (records.pageErrors.length > 0) throw new Error(`${label} page errors: ${records.pageErrors.join(' | ')}`)
  if (records.consoleErrors.length > 0) throw new Error(`${label} console errors: ${records.consoleErrors.join(' | ')}`)
}

async function assertNoVisibleChatErrors(page, phase) {
  const errors = await page.locator('body').evaluate((root, source) => {
    const matcher = new RegExp(source, 'u')
    const values = new Set()
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node.textContent?.trim() ?? ''
      const element = node.parentElement
      if (!matcher.test(text) || element === null) continue
      const box = element.getBoundingClientRect()
      if (box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden') values.add(text)
    }
    return [...values]
  }, VISIBLE_CHAT_ERROR.source)
  if (errors.length > 0) throw new Error(`${phase} renders a visible Chat error: ${errors.join(' | ')}`)
  return errors
}

async function officialCurrentSessionId(page) {
  const raw = await page.evaluate(() => globalThis.localStorage.getItem('dsh.sessions.current'))
  if (raw === null) return undefined
  try { return JSON.parse(raw).sessionId } catch { return undefined }
}

async function seedOfficialSelection(context, rootSessionId) {
  await context.addInitScript((sessionId) => {
    if (globalThis.location.protocol === 'http:' || globalThis.location.protocol === 'https:') {
      globalThis.localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId }))
    }
  }, rootSessionId)
}

function bootstrapEvidence(rootSessionId, selectionSource) {
  return {
    key: 'dsh.sessions.current',
    value: { sessionId: rootSessionId },
    purpose: 'isolated-proof-initial-ui-selection',
    authority: false,
    officialSource: selectionSource,
  }
}

async function writeFailureEvidence(evidenceDir, label, page, records, error, geometry) {
  await page.screenshot({ path: join(evidenceDir, `${label}-failure.png`), fullPage: false }).catch(() => {})
  await writeFile(join(evidenceDir, `${label}-failure.json`), `${JSON.stringify({
    status: 'fail', error: error instanceof Error ? error.message : String(error),
    url: page.url(), consoleErrors: records.consoleErrors, pageErrors: records.pageErrors,
    requests: records.swarmRequests, geometry,
  }, null, 2)}\n`, 'utf8').catch(() => {})
}

async function dismissOfficialTestingNotice(page) {
  const dialog = page.getByRole('dialog', { name: /^(Internal Testing Notice|内测声明)$/u })
  const present = await dialog.waitFor({ state: 'visible', timeout: 60_000 }).then(() => true, () => false)
  if (!present) return { officialTestingNoticePresent: false, officialTestingNoticeDismissed: false }
  const button = dialog.getByRole('button', { name: /^(Continue|继续)$/u })
  await button.focus()
  await page.keyboard.press('Enter')
  await button.waitFor({ state: 'hidden', timeout: 10_000 })
  return { officialTestingNoticePresent: true, officialTestingNoticeDismissed: true }
}

async function skipOfficialApiKeyOnboarding(page) {
  const dialog = page.getByRole('dialog', { name: /^(Add an API key to get started|添加一个 API Key 开始使用)$/u })
  const present = await dialog.waitFor({ state: 'visible', timeout: 60_000 }).then(() => true, () => false)
  if (!present) return { officialApiKeyOnboardingPresent: false, officialApiKeyOnboardingSkipped: false }
  const button = dialog.getByRole('button', { name: /^(Configure later|稍后配置)$/u })
  await button.focus()
  await page.keyboard.press('Enter')
  await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
  return { officialApiKeyOnboardingPresent: true, officialApiKeyOnboardingSkipped: true }
}

async function completeOfficialOnboarding(page) {
  return {
    ...await dismissOfficialTestingNotice(page),
    ...await skipOfficialApiKeyOnboarding(page),
  }
}

async function openReadyDashboard(page) {
  const team = await selectRootSession(page)
  const composer = page.getByRole('textbox').last()
  await composer.waitFor({ state: 'visible', timeout: 10_000 })
  const beforeComposerBox = await composer.boundingBox()
  await team.focus()
  await page.keyboard.press('Enter')
  const dashboard = page.locator('[data-swarm-team-dashboard]')
  await dashboard.waitFor({ state: 'visible', timeout: 20_000 })
  await page.locator('[data-swarm-team-dashboard][data-phase="ready"]').waitFor({ state: 'visible', timeout: 20_000 })
  if (await team.getAttribute('aria-expanded') !== 'true') throw new Error('Team toolbar toggle did not report its open state')
  return { dashboard, beforeComposerBox }
}

function boxesStable(previous, next) {
  return previous !== null && next !== null
    && ['x', 'y', 'width', 'height'].every(key => Math.abs(previous[key] - next[key]) <= GEOMETRY_STABILITY_PX)
}

async function waitForWideDetails(page, beforeComposerBox, label, geometry) {
  const panel = page.locator('[role="complementary"][data-swarm-team-panel]')
  const composer = page.getByRole('textbox').last()
  const deadline = Date.now() + GEOMETRY_SETTLE_TIMEOUT_MS
  let previous = null
  while (Date.now() < deadline) {
    const [panelBox, composerBox] = await Promise.all([panel.boundingBox(), composer.boundingBox()])
    const value = { beforeComposerBox, panelBox, composerBox }
    geometry[label] = value
    const valid = beforeComposerBox !== null && panelBox !== null && composerBox !== null
      && panelBox.width >= 300 && composerBox.width <= beforeComposerBox.width + GEOMETRY_STABILITY_PX
      && composerBox.x + composerBox.width <= panelBox.x + 2
    if (valid && boxesStable(previous?.panelBox ?? null, panelBox) && boxesStable(previous?.composerBox ?? null, composerBox)) return value
    previous = value
    await page.waitForTimeout(GEOMETRY_SAMPLE_MS)
  }
  throw new Error(`${label} native Details geometry did not settle: ${JSON.stringify(geometry[label])}`)
}

async function waitForNarrowDetailsConcession(page, label, geometry) {
  const frame = page.locator('[data-details-collapsed]')
  const panel = page.locator('[data-swarm-team-panel]')
  const deadline = Date.now() + GEOMETRY_SETTLE_TIMEOUT_MS
  while (Date.now() < deadline) {
    const [frameCount, panelCount, visible] = await Promise.all([frame.count(), panel.count(), panel.isVisible()])
    const box = panelCount === 1 ? await panel.boundingBox() : null
    const value = { frameCount, panelCount, visible, box }
    geometry[label] = value
    if (frameCount === 1 && panelCount === 1 && !visible && box?.width === 0) return value
    await page.waitForTimeout(GEOMETRY_SAMPLE_MS)
  }
  throw new Error(`${label} did not use the official narrow Details concession: ${JSON.stringify(geometry[label])}`)
}

async function assertNoPluginFallback(page, label) {
  const dialogCount = await page.getByRole('dialog', { name: 'Agent Team' }).count()
  const fixed = await page.locator('[data-swarm-team-panel]').evaluate(element => {
    for (let current = element; current !== null; current = current.parentElement) {
      if (getComputedStyle(current).position === 'fixed') return true
    }
    return false
  })
  if (dialogCount !== 0 || fixed) throw new Error(`${label} rendered a removed Team overlay fallback`)
}

async function assertChineseLocale(browser, rootSessionId, port) {
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } })
  await seedOfficialSelection(context, rootSessionId)
  const page = await context.newPage()
  try {
    await page.goto(`http://127.0.0.1:${String(port)}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await completeOfficialOnboarding(page)
    const team = await selectRootSession(page)
    await team.click()
    await page.locator('[data-swarm-team-dashboard][data-phase="ready"]').waitFor({ state: 'visible', timeout: 20_000 })
    if (await page.getByRole('button', { name: /^团队$/u }).count() !== 1) throw new Error('official Chinese locale did not rerender the Team action')
    return true
  } finally {
    await context.close()
  }
}

/** Exercise a real browser transport failure against the read route, then let the controller recover. */
async function exerciseDisconnectRecovery(page, panel, records) {
  const handler = async route => {
    const request = route.request()
    let body
    try { body = request.postDataJSON() } catch { body = undefined }
    if (body?.method === 'snapshot') return await route.abort('connectionfailed')
    return await route.continue()
  }
  await page.route('**/swarm/v1', handler)
  const consoleErrorsBefore = records.consoleErrors.length
  try {
    await page.getByRole('button', { name: /^Refresh$/u }).click()
    await panel.locator('[role="alert"]').waitFor({ state: 'visible', timeout: 10_000 })
  } finally {
    await page.unroute('**/swarm/v1', handler)
  }
  const expectedConsoleErrors = records.consoleErrors.splice(consoleErrorsBefore)
  if (expectedConsoleErrors.length === 0 || expectedConsoleErrors.some(message => message !== 'Failed to load resource: net::ERR_CONNECTION_FAILED')) {
    throw new Error(`disconnect injection emitted an unexpected console error: ${expectedConsoleErrors.join(' | ')}`)
  }
  await page.getByRole('button', { name: /^Refresh$/u }).click()
  await page.locator('[data-swarm-team-panel][data-phase="ready"]').waitFor({ state: 'visible', timeout: 10_000 })
  return { recovered: true, expectedConsoleErrors }
}

export async function runR3ActiveBrowserProof({
  port, evidenceDir, rootSessionId, teamId, browserExecutable, selectionSource, fixture,
}) {
  if (fixture?.exactRoot !== true || fixture?.workspaceAttached !== true
    || fixture?.sessionNonBlank !== true || fixture?.rootSessionId !== rootSessionId) {
    throw new Error('browser proof requires an exact nonblank root attached through the official Workspace API')
  }
  const { browser, identity } = await launchBrowser(browserExecutable)
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1000 } })
  await seedOfficialSelection(context, rootSessionId)
  const page = await context.newPage()
  const records = recordBrowser(page)
  const geometry = {}
  try {
    await page.goto(`http://127.0.0.1:${String(port)}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    const onboarding = await completeOfficialOnboarding(page)
    if (await officialCurrentSessionId(page) !== rootSessionId) {
      throw new Error('official Session selection did not rehydrate the exact proof root')
    }
    const { dashboard, beforeComposerBox } = await openReadyDashboard(page)
    const activeDashboard = await assertNoVisibleChatErrors(page, 'active Team dashboard')
    const frameworkBinding = records.swarmRequests.find(request => request.body?.method === 'binding')
    if (frameworkBinding?.body?.target?.rootSessionId !== rootSessionId) {
      throw new Error('official Session slot did not emit the exact proof root as the R2 target hint')
    }
    const panel = page.locator('[role="complementary"][data-swarm-team-panel]')
    await panel.waitFor({ state: 'visible' })
    await assertNoPluginFallback(page, 'wide Team')
    const initial = await waitForWideDetails(page, beforeComposerBox, 'initial', geometry)
    if (!await dashboard.getByText('R2 isolated Profile team', { exact: true }).isVisible()) {
      throw new Error('browser Team name did not come from the real R2 producer')
    }
    await page.screenshot({ path: join(evidenceDir, 'r3-team-dashboard.png'), fullPage: false })
    const faultInjection = await exerciseDisconnectRecovery(page, panel, records)

    await page.getByRole('button', { name: TOOL_DETAILS }).click()
    await panel.waitFor({ state: 'hidden', timeout: 10_000 })
    const toolComposer = await page.getByRole('textbox').last().boundingBox()
    await page.getByRole('button', { name: TEAM_NAME }).click()
    await panel.waitFor({ state: 'visible', timeout: 10_000 })
    const afterTool = await waitForWideDetails(page, beforeComposerBox, 'afterTool', geometry)
    await page.setViewportSize({ width: 680, height: 900 })
    const narrow = await waitForNarrowDetailsConcession(page, 'narrow', geometry)
    await page.setViewportSize({ width: 1440, height: 1000 })
    await panel.waitFor({ state: 'visible', timeout: 10_000 })
    const recovered = await waitForWideDetails(page, beforeComposerBox, 'recovered', geometry)
    const localeRerendered = await assertChineseLocale(browser, rootSessionId, port)

    const openChat = page.getByRole('button', { name: OPEN_CHAT })
    await openChat.focus()
    await page.keyboard.press('Enter')
    await panel.waitFor({ state: 'hidden', timeout: 20_000 })
    const selected = page.locator('[role="treeitem"][aria-selected="true"]')
    await selected.waitFor({ state: 'visible', timeout: 10_000 })
    await page.getByRole('textbox').last().waitFor({ state: 'visible', timeout: 10_000 })
    const selectedSessionId = await officialCurrentSessionId(page)
    if (selectedSessionId !== rootSessionId) {
      throw new Error(`official Session selection did not match the R2 root: ${String(selectedSessionId)}`)
    }
    const initialCaptainChat = await assertNoVisibleChatErrors(page, 'initial Captain Chat')

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 })
    const reloaded = await openReadyDashboard(page)
    const reloadDashboard = await assertNoVisibleChatErrors(page, 'reloaded Team dashboard')
    const reloadGeometry = await waitForWideDetails(page, reloaded.beforeComposerBox, 'reload', geometry)
    await page.getByRole('button', { name: TEAM_NAME }).click()
    await page.locator('[data-swarm-team-panel]').waitFor({ state: 'hidden', timeout: 10_000 })
    const reloadedSessionId = await officialCurrentSessionId(page)
    if (reloadedSessionId !== rootSessionId) {
      throw new Error(`official Session selection did not survive reload: ${String(reloadedSessionId)}`)
    }
    const reloadCaptainChat = await assertNoVisibleChatErrors(page, 'reload Captain Chat')

    assertReadOnlyRequests(records)
    assertCleanBrowser(records, 'active browser')
    const result = {
      status: 'pass', rootSessionId, teamId, browser: identity, fixture, ...onboarding,
      bootstrap: { ...bootstrapEvidence(rootSessionId, selectionSource), frameworkTargetObserved: true },
      surfaces: {
        wideDetailsLease: true, toolHandoff: true, narrowNativeDetailsConcession: true,
        narrowSubtreeMountedHidden: true, noPluginFallbackOverlay: true, samePanelRestored: true,
        chatReflow: true, localeRerendered, disconnectRecovery: faultInjection.recovered,
      },
      geometry: { initial, toolComposer, afterTool, narrow, recovered, reloadGeometry },
      faultInjection,
      keyboard: ['focus Team', 'Enter', 'Tool details', 'Team', 'narrow recovery', 'Chinese locale', 'focus Open Captain Chat', 'Enter', 'Team toggle close after reload'],
      handoff: {
        officialSessionSelected: true,
        officialSelectionSource: 'localStorage:dsh.sessions.current',
        currentSessionId: selectedSessionId,
        reloadedSessionId,
        chatTextboxVisible: true,
      },
      reload: true,
      requests: records.swarmRequests,
      consoleErrors: records.consoleErrors,
      pageErrors: records.pageErrors,
      visibleErrors: { activeDashboard, initialCaptainChat, reloadDashboard, reloadCaptainChat },
    }
    await writeFile(join(evidenceDir, 'r3-browser-active.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    return result
  } catch (error) {
    await writeFailureEvidence(evidenceDir, 'r3-browser-active', page, records, error, geometry)
    throw error
  } finally {
    await browser.close()
  }
}

export async function runR3R0BrowserProof({
  port, evidenceDir, rootSessionId, browserExecutable, selectionSource, routeEvidence,
}) {
  if (routeEvidence?.routeObserved?.status !== 405 || routeEvidence?.routeObserved?.bodyBytes !== 0
    || routeEvidence?.routeObserved?.contentType !== null
    || routeEvidence?.routeOwner !== 'official-host-fallback'
    || routeEvidence?.swarmRouteRegistered !== false) {
    throw new Error('R0 browser proof requires the runner-owned exact official Host fallback evidence')
  }
  const { browser, identity } = await launchBrowser(browserExecutable)
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } })
  await seedOfficialSelection(context, rootSessionId)
  const page = await context.newPage()
  const records = recordBrowser(page)
  try {
    await page.goto(`http://127.0.0.1:${String(port)}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    const onboarding = await completeOfficialOnboarding(page)
    if (await officialCurrentSessionId(page) !== rootSessionId) {
      throw new Error('R0 official Session selection did not rehydrate the exact proof root')
    }
    const teamActionAbsent = await page.getByRole('button', { name: TEAM_NAME }).count() === 0
    const dashboardAbsent = await page.locator('[data-swarm-team-dashboard]').count() === 0
    if (!teamActionAbsent || !dashboardAbsent) throw new Error('R0-disabled plugin left a Team client surface mounted')
    await page.screenshot({ path: join(evidenceDir, 'r3-r0-fail-closed.png'), fullPage: false })
    const visibleErrors = await assertNoVisibleChatErrors(page, 'R0 browser')
    assertCleanBrowser(records, 'R0 browser')
    const result = {
      status: 'pass', browser: identity, bootstrap: bootstrapEvidence(rootSessionId, selectionSource), ...onboarding,
      routeUnavailable: true, ...routeEvidence,
      teamActionAbsent, renderedData: false,
      requests: records.swarmRequests, consoleErrors: records.consoleErrors, pageErrors: records.pageErrors, visibleErrors,
    }
    await writeFile(join(evidenceDir, 'r3-browser-r0.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    return result
  } catch (error) {
    await writeFailureEvidence(evidenceDir, 'r3-browser-r0', page, records, error)
    throw error
  } finally {
    await browser.close()
  }
}

export async function runR3RemovedBrowserProof({ port, evidenceDir, rootSessionId, browserExecutable, selectionSource }) {
  const { browser, identity } = await launchBrowser(browserExecutable)
  const context = await browser.newContext({ locale: 'en-US' })
  await seedOfficialSelection(context, rootSessionId)
  const page = await context.newPage()
  const records = recordBrowser(page)
  try {
    await page.goto(`http://127.0.0.1:${String(port)}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    const onboarding = await completeOfficialOnboarding(page)
    const rows = page.getByRole('treeitem')
    if (await rows.count() > 0) await rows.first().click()
    const absent = await page.getByRole('button', { name: TEAM_NAME }).count() === 0
    if (!absent) throw new Error('removed package left the Team client action mounted')
    const visibleErrors = await assertNoVisibleChatErrors(page, 'removed browser')
    assertCleanBrowser(records, 'removed browser')
    const result = {
      status: 'pass', browser: identity, bootstrap: bootstrapEvidence(rootSessionId, selectionSource), ...onboarding,
      teamActionAbsent: true,
      consoleErrors: records.consoleErrors, pageErrors: records.pageErrors, visibleErrors,
    }
    await writeFile(join(evidenceDir, 'r3-browser-removed.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    return result
  } catch (error) {
    await writeFailureEvidence(evidenceDir, 'r3-browser-removed', page, records, error)
    throw error
  } finally {
    await browser.close()
  }
}
