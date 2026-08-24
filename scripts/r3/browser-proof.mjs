import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'

const TEAM_NAME = /^(Team|团队)$/u
const TOOL_DETAILS = /^(Tool details|工具详情)$/u
const OPEN_CHAT = /^(Open Captain Chat|打开 Captain 对话)$/u
const SETTINGS = /^(Settings|设置)$/u
const SETTINGS_DIALOG = /^(Settings|设置)$/u
const CLOSE_DETAILS = /^(Close details|关闭详情)$/u
const MEMBERS = /^(Members|成员)$/u
const MEMORY = /^(Memory|记忆)$/u
const PLUGINS = /^(Plugins|插件)$/u
const PLUGIN_CONFIGURATION = /^(Plugin configuration|插件配置)$/u
const SHOW_SWARM_SETTINGS = /^(Show Agent Swarm settings|展开 Agent Swarm 设置)$/u
const HIDE_SWARM_SETTINGS = /^(Hide Agent Swarm settings|收起 Agent Swarm 设置)$/u

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

async function writeFailureEvidence(evidenceDir, label, page, records, error) {
  await page.screenshot({ path: join(evidenceDir, `${label}-failure.png`), fullPage: false }).catch(() => {})
  await writeFile(join(evidenceDir, `${label}-failure.json`), `${JSON.stringify({
    status: 'fail', error: error instanceof Error ? error.message : String(error),
    url: page.url(), consoleErrors: records.consoleErrors, pageErrors: records.pageErrors,
    requests: records.swarmRequests,
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
  await team.focus()
  await page.keyboard.press('Enter')
  const dashboard = page.locator('[data-swarm-team-dashboard]')
  await dashboard.waitFor({ state: 'visible', timeout: 20_000 })
  await page.locator('[data-swarm-team-dashboard][data-phase="ready"]').waitFor({ state: 'visible', timeout: 20_000 })
  return dashboard
}

async function frameState(page) {
  return await page.locator('[data-shell-overlay]').evaluate((overlay) => {
    const frame = overlay.parentElement
    if (!(frame instanceof HTMLElement)) throw new Error('official AppFrame parent is unavailable')
    const columns = getComputedStyle(frame).gridTemplateColumns
      .split(/\s+/u)
      .map(value => Number.parseFloat(value))
    const box = frame.getBoundingClientRect()
    return {
      collapsed: frame.hasAttribute('data-details-collapsed'),
      columns,
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
    }
  })
}

function detailsWidth(state) {
  return state.columns.at(-1) ?? 0
}

async function beginDetailsTransitionTrace(page) {
  await page.locator('[data-shell-overlay]').evaluate((overlay) => {
    const frame = overlay.parentElement
    if (!(frame instanceof HTMLElement)) throw new Error('official AppFrame parent is unavailable')
    const trace = []
    const sample = () => {
      trace.push({
        collapsed: frame.hasAttribute('data-details-collapsed'),
        columns: getComputedStyle(frame).gridTemplateColumns,
      })
    }
    const observer = new MutationObserver(sample)
    observer.observe(frame, { attributes: true, attributeFilter: ['data-details-collapsed', 'style'] })
    sample()
    globalThis.__swarmDetailsTransitionProof = { observer, trace }
  })
}

async function endDetailsTransitionTrace(page) {
  return await page.evaluate(() => {
    const proof = globalThis.__swarmDetailsTransitionProof
    if (proof === undefined) throw new Error('details transition trace was not started')
    proof.observer.disconnect()
    delete globalThis.__swarmDetailsTransitionProof
    return proof.trace
  })
}

async function openSettings(page) {
  const trigger = page.getByRole('button', { name: SETTINGS, exact: true })
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: SETTINGS_DIALOG })
  await dialog.waitFor({ state: 'visible', timeout: 10_000 })
  return dialog
}

async function switchLanguage(page, from, to, expectedLang) {
  const dialog = page.getByRole('dialog', { name: SETTINGS_DIALOG })
  await dialog.getByRole('button', { name: from, exact: true }).click()
  await page.getByRole('menuitem', { name: to, exact: true }).click()
  await page.getByRole('dialog', { name: SETTINGS_DIALOG }).waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForFunction(lang => document.documentElement.lang === lang, expectedLang)
}

async function themeState(page) {
  return await page.locator('[data-swarm-team-panel]').evaluate((card) => {
    const cardStyle = getComputedStyle(card)
    const bodyStyle = getComputedStyle(document.body)
    return {
      dark: document.body.hasAttribute('data-ds-dark-theme'),
      cardBackground: cardStyle.backgroundColor,
      cardColor: cardStyle.color,
      layerToken: cardStyle.getPropertyValue('--dsw-alias-bg-layer-1').trim(),
      baseToken: bodyStyle.getPropertyValue('--dsw-alias-bg-base').trim(),
    }
  })
}

async function chooseTheme(page, name, dark) {
  const dialog = page.getByRole('dialog', { name: SETTINGS_DIALOG })
  const button = dialog.getByRole('button', { name, exact: true })
  await button.click()
  await page.waitForFunction((expected) => document.body.hasAttribute('data-ds-dark-theme') === expected, dark)
  if (await button.getAttribute('aria-pressed') !== 'true') {
    throw new Error(`${name} theme control did not become selected`)
  }
  return await themeState(page)
}

async function assertPopulatedTeamData(page, evidenceDir, capturePrefix) {
  const dashboard = page.locator('[data-swarm-team-dashboard][data-phase="ready"]')
  await dashboard.getByRole('button', { name: MEMBERS, exact: true }).click()
  const memberBody = dashboard.locator('[data-swarm-team-body][data-swarm-team-view="members"]')
  await memberBody.getByRole('heading', { name: /profile-reviewer.*Active/u }).waitFor({ state: 'visible' })
  for (const value of [
    'Review member for populated browser acceptance.',
    'p0-profile-reviewer-session',
    'spawn',
    'p0-provider',
    'p0-model',
    'agent_swarm_list_tasks',
    'dsh-plugin-development',
  ]) {
    if (await memberBody.getByText(value, { exact: true }).count() < 1) {
      throw new Error(`populated member profile did not render ${value}`)
    }
  }
  if (capturePrefix !== undefined) await page.screenshot({ path: join(evidenceDir, `${capturePrefix}-members.png`), fullPage: false })

  await dashboard.getByRole('button', { name: MEMORY, exact: true }).click()
  const memoryBody = dashboard.locator('[data-swarm-team-body][data-swarm-team-view="memory"]')
  for (const value of [
    'P0 shared decision: keep browser evidence claim-local.',
    'P0 personal lesson: verify populated state after reload.',
    'p0:team-memory',
    'p0:personal-memory',
  ]) {
    await memoryBody.getByText(value, { exact: true }).waitFor({ state: 'visible' })
  }
  if (capturePrefix !== undefined) await page.screenshot({ path: join(evidenceDir, `${capturePrefix}-memory.png`), fullPage: false })
  return {
    member: 'profile-reviewer',
    rosterCount: 1,
    memoryCount: 2,
    scopes: ['team', 'member'],
    persistedReadback: capturePrefix === undefined,
  }
}

async function openAgentSwarmSettings(page) {
  const dialog = await openSettings(page)
  await dialog.getByRole('button', { name: PLUGINS, exact: true }).click()
  await dialog.getByRole('tab', { name: PLUGIN_CONFIGURATION, exact: true }).click()
  const card = dialog.locator('[data-swarm-settings-card]')
  await card.waitFor({ state: 'visible', timeout: 20_000 })
  if (await card.getAttribute('data-open') !== 'true') {
    await card.getByRole('button', { name: SHOW_SWARM_SETTINGS }).click()
  }
  await card.getByRole('button', { name: HIDE_SWARM_SETTINGS }).waitFor({ state: 'visible' })
  return { dialog, card }
}

async function assertAgentSwarmSettings(page, expected, screenshotPath) {
  const { card } = await openAgentSwarmSettings(page)
  for (const [field, value] of Object.entries(expected)) {
    const input = card.locator(`#swarm-settings-${field}`)
    await input.waitFor({ state: 'visible' })
    if (await input.inputValue() !== value) {
      throw new Error(`Agent Swarm setting ${field} did not read back ${value}`)
    }
  }
  if (screenshotPath !== undefined) await page.screenshot({ path: screenshotPath, fullPage: false })
  await page.keyboard.press('Escape')
  return { ...expected, persistedReadback: true }
}

async function configureAgentSwarmSettings(page, evidenceDir) {
  const expected = {
    memoryQueryMaxCandidates: '7',
    memoryQueryTimeoutMs: '3000',
    memberDenyTools: 'agent_swarm_list_tasks',
    memberSkills: 'dsh-plugin-development',
  }
  const { card } = await openAgentSwarmSettings(page)
  for (const [field, value] of Object.entries(expected)) {
    await card.locator(`#swarm-settings-${field}`).fill(value)
  }
  const save = card.getByRole('button', { name: 'Save', exact: true })
  if (await save.isDisabled()) throw new Error('Agent Swarm settings Save stayed disabled for valid representative values')
  await save.click()
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-swarm-settings-action="save"]')
    return button instanceof HTMLButtonElement && button.disabled
      && document.querySelector('[data-swarm-settings-pending]') === null
  })
  await page.screenshot({ path: join(evidenceDir, 'r3-settings-agent-swarm.png'), fullPage: false })
  await page.keyboard.press('Escape')
  return await assertAgentSwarmSettings(page, expected)
}

export async function runR3ActiveBrowserProof({
  port, evidenceDir, rootSessionId, teamId, browserExecutable, selectionSource, fixture, representative,
}) {
  if (fixture?.exactRoot !== true || fixture?.workspaceAttached !== true
    || fixture?.sessionNonBlank !== true || fixture?.rootSessionId !== rootSessionId) {
    throw new Error('browser proof requires an exact nonblank root attached through the official Workspace API')
  }
  if (representative?.source !== 'synthetic-authoritative-storage-fixture'
    || representative?.rosterCount !== 1 || representative?.memoryCount !== 2
    || representative?.member?.phase !== 'active') {
    throw new Error(`browser proof requires the pinned populated Team fixture: ${JSON.stringify(representative)}`)
  }
  const { browser, identity } = await launchBrowser(browserExecutable)
  const context = await browser.newContext({
    locale: 'en-US',
    reducedMotion: 'reduce',
    viewport: { width: 1440, height: 1000 },
  })
  await seedOfficialSelection(context, rootSessionId)
  const page = await context.newPage()
  const records = recordBrowser(page)
  try {
    await page.goto(`http://127.0.0.1:${String(port)}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    const onboarding = await completeOfficialOnboarding(page)
    if (await officialCurrentSessionId(page) !== rootSessionId) {
      throw new Error('official Session selection did not rehydrate the exact proof root')
    }
    const dashboard = await openReadyDashboard(page)
    const frameworkBinding = records.swarmRequests.find(request => request.body?.method === 'binding')
    if (frameworkBinding?.body?.target?.rootSessionId !== rootSessionId) {
      throw new Error('official Session slot did not emit the exact proof root as the R2 target hint')
    }
    const panel = page.locator('[data-swarm-team-panel]')
    const teamTrigger = page.getByRole('button', { name: TEAM_NAME })
    const toolTrigger = page.getByRole('button', { name: TOOL_DETAILS })
    const actionPair = page.locator('[data-swarm-team-actions]')
    await panel.waitFor({ state: 'visible' })
    if (await panel.getAttribute('aria-modal') === 'true') {
      throw new Error('Team dashboard unexpectedly claimed modal semantics')
    }
    if (await teamTrigger.getAttribute('aria-expanded') !== 'true'
      || !await teamTrigger.isVisible() || !await toolTrigger.isVisible()
      || await actionPair.count() !== 1) {
      throw new Error('persistent Team / Tool details action pair was not visible beside the Session utilities')
    }
    const desktopBox = await panel.boundingBox()
    const desktopTriggerBox = await teamTrigger.boundingBox()
    const desktopFrame = await frameState(page)
    const desktopDetailsWidth = detailsWidth(desktopFrame)
    const composer = page.getByRole('textbox').last()
    const desktopComposerBox = await composer.boundingBox()
    if (desktopBox === null || desktopTriggerBox === null || desktopComposerBox === null
      || desktopFrame.collapsed || desktopDetailsWidth < 300 || desktopDetailsWidth > 440
      || await page.locator('[data-swarm-team-panel]').count() !== 1
      || Math.abs(desktopBox.width - desktopDetailsWidth) > 2
      || Math.abs(desktopBox.x + desktopBox.width - desktopFrame.box.width) > 2
      || Math.abs(desktopBox.y - desktopFrame.box.y) > 2
      || Math.abs(desktopBox.height - desktopFrame.box.height) > 2
      || desktopComposerBox.x + desktopComposerBox.width > desktopBox.x + 2) {
      throw new Error(`wide Team did not own the official details column with Chat reflow: ${JSON.stringify({ card: desktopBox, trigger: desktopTriggerBox, frame: desktopFrame, composer: desktopComposerBox })}`)
    }
    if (!await dashboard.getByText('R2 isolated Profile team', { exact: true }).isVisible()) {
      throw new Error('browser Team name did not come from the real R2 producer')
    }
    await page.screenshot({ path: join(evidenceDir, 'r3-team-dashboard.png'), fullPage: false })
    const populated = await assertPopulatedTeamData(page, evidenceDir, 'r3-team-populated')
    await dashboard.getByRole('button', { name: /^(Overview|概览)$/u, exact: true }).click()
    const settings = await configureAgentSwarmSettings(page, evidenceDir)

    await composer.click()
    await panel.waitFor({ state: 'visible', timeout: 10_000 })
    if (!await composer.evaluate(element => element === document.activeElement)) {
      throw new Error('docked Team prevented the official Chat composer from receiving focus')
    }

    await beginDetailsTransitionTrace(page)
    await toolTrigger.click()
    await panel.waitFor({ state: 'hidden', timeout: 10_000 })
    const officialClose = page.getByRole('button', { name: CLOSE_DETAILS })
    await officialClose.waitFor({ state: 'visible', timeout: 10_000 })
    const toolFrame = await frameState(page)
    const transitionTrace = await endDetailsTransitionTrace(page)
    const traceCollapsed = transitionTrace.some(sample => sample.collapsed
      || Number.parseFloat(sample.columns.split(/\s+/u).at(-1) ?? '0') < 1)
    if (toolFrame.collapsed || Math.abs(detailsWidth(toolFrame) - desktopDetailsWidth) > 2
      || traceCollapsed || await teamTrigger.getAttribute('aria-expanded') !== 'false'
      || !await toolTrigger.evaluate(element => element === document.activeElement)
      || await page.getByText('Click a tool row in the message flow to view its details', { exact: true }).count() !== 1) {
      throw new Error(`Tool details handoff closed or replaced the official details column: ${JSON.stringify({ frame: toolFrame, transitionTrace })}`)
    }
    await page.screenshot({ path: join(evidenceDir, 'r3-tool-details.png'), fullPage: false })

    await teamTrigger.click()
    await page.locator('[data-swarm-team-dashboard][data-phase="ready"]').waitFor({ state: 'visible', timeout: 20_000 })
    if (await page.locator('[data-swarm-team-panel]').count() !== 1 || (await frameState(page)).collapsed) {
      throw new Error('Team did not reacquire the official details column after Tool details')
    }
    await teamTrigger.click()
    await panel.waitFor({ state: 'hidden', timeout: 10_000 })
    const closedFrame = await frameState(page)
    if (await teamTrigger.getAttribute('aria-expanded') !== 'false') {
      throw new Error('second Team trigger click did not close the official Team column')
    }
    if (!closedFrame.collapsed || detailsWidth(closedFrame) !== 0
      || await page.locator('[data-swarm-team-card], [data-swarm-team-layer]').count() !== 0) {
      throw new Error(`closed Team left a details or floating surface: ${JSON.stringify(closedFrame)}`)
    }
    await teamTrigger.click()
    await page.locator('[data-swarm-team-dashboard][data-phase="ready"]').waitFor({ state: 'visible', timeout: 20_000 })
    if (await page.locator('[data-swarm-team-panel]').count() !== 1) {
      throw new Error('third Team trigger click did not restore the official Team surface')
    }

    await page.setViewportSize({ width: 680, height: 900 })
    await panel.waitFor({ state: 'hidden', timeout: 10_000 })
    const narrowBox = await panel.boundingBox()
    const narrowPanelVisible = await panel.isVisible()
    const narrowTriggerBox = await teamTrigger.boundingBox()
    const narrowFrame = await frameState(page)
    if (narrowTriggerBox === null || narrowPanelVisible
      || (narrowBox !== null && narrowBox.width > 0)
      || !narrowFrame.collapsed || detailsWidth(narrowFrame) !== 0
      || await page.locator('[data-swarm-team-dashboard]').count() !== 1
      || await page.locator('[data-swarm-team-card], [data-swarm-team-layer]').count() !== 0
      || !await teamTrigger.isVisible()) {
      throw new Error(`narrow Team did not follow the official details concession: ${JSON.stringify({ panel: narrowBox, panelVisible: narrowPanelVisible, trigger: narrowTriggerBox, frame: narrowFrame })}`)
    }
    await page.screenshot({ path: join(evidenceDir, 'r3-team-dashboard-narrow.png'), fullPage: false })
    await page.setViewportSize({ width: 1440, height: 1000 })
    await panel.waitFor({ state: 'visible', timeout: 10_000 })

    const localeIdentity = await dashboard.elementHandle()
    await openSettings(page)
    await switchLanguage(page, 'English', '中文', 'zh-CN')
    await page.getByRole('heading', { name: '智能体团队', exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
    const zhSameDashboard = await localeIdentity.evaluate((element, current) => element === current,
      await dashboard.elementHandle())
    if (!zhSameDashboard || await page.getByRole('button', { name: '团队', exact: true }).count() !== 1
      || await page.getByRole('button', { name: '工具详情', exact: true }).count() !== 1) {
      throw new Error('DSH locale switch remounted Team or left its action copy in English')
    }
    const zhSettingsDialog = page.getByRole('dialog', { name: '设置', exact: true })
    await zhSettingsDialog.getByRole('button', { name: '插件', exact: true }).click()
    await zhSettingsDialog.getByRole('tab', { name: '插件配置', exact: true }).click()
    await zhSettingsDialog.getByRole('button', { name: '展开 Agent Swarm 设置', exact: true }).waitFor({ state: 'visible' })
    await page.keyboard.press('Escape')
    await page.screenshot({ path: join(evidenceDir, 'r3-team-dashboard-locale-zh.png'), fullPage: false })
    await openSettings(page)
    await switchLanguage(page, '中文', 'English', 'en')
    await page.getByRole('heading', { name: 'Agent Team', exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
    const enSameDashboard = await localeIdentity.evaluate((element, current) => element === current,
      await dashboard.elementHandle())
    if (!enSameDashboard || await page.getByRole('button', { name: 'Team', exact: true }).count() !== 1
      || await page.getByRole('button', { name: 'Tool details', exact: true }).count() !== 1) {
      throw new Error('DSH locale switch back to English remounted Team or left stale copy')
    }
    await page.keyboard.press('Escape')

    await page.emulateMedia({ colorScheme: 'light' })
    await openSettings(page)
    const lightTheme = await chooseTheme(page, 'Light', false)
    const darkTheme = await chooseTheme(page, 'Dark', true)
    if (darkTheme.layerToken === lightTheme.layerToken
      || darkTheme.cardBackground === lightTheme.cardBackground
      || darkTheme.cardColor === lightTheme.cardColor) {
      throw new Error(`Team surface did not consume DSH theme tokens: ${JSON.stringify({ lightTheme, darkTheme })}`)
    }
    await page.screenshot({ path: join(evidenceDir, 'r3-team-dashboard-theme-dark.png'), fullPage: false })
    const systemLightTheme = await chooseTheme(page, 'System', false)
    if (systemLightTheme.layerToken !== lightTheme.layerToken
      || systemLightTheme.cardBackground !== lightTheme.cardBackground) {
      throw new Error(`System-light theme did not resolve through the same DSH tokens: ${JSON.stringify({ lightTheme, systemLightTheme })}`)
    }
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.waitForFunction(() => document.body.hasAttribute('data-ds-dark-theme'))
    const systemDarkTheme = await themeState(page)
    if (systemDarkTheme.layerToken !== darkTheme.layerToken
      || systemDarkTheme.cardBackground !== darkTheme.cardBackground) {
      throw new Error(`System-dark theme did not resolve through the same DSH tokens: ${JSON.stringify({ darkTheme, systemDarkTheme })}`)
    }
    await page.emulateMedia({ colorScheme: 'light' })
    await page.waitForFunction(() => !document.body.hasAttribute('data-ds-dark-theme'))
    await page.keyboard.press('Escape')

    const refresh = page.getByRole('button', { name: 'Refresh', exact: true })
    await refresh.focus()
    await page.keyboard.press('Escape')
    await panel.waitFor({ state: 'hidden', timeout: 10_000 })
    if (!await teamTrigger.evaluate(element => element === document.activeElement)) {
      throw new Error('Escape did not restore focus to the Team trigger')
    }
    await page.keyboard.press('Enter')
    await page.locator('[data-swarm-team-dashboard][data-phase="ready"]').waitFor({ state: 'visible', timeout: 20_000 })

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

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 })
    await openReadyDashboard(page)
    const populatedReload = await assertPopulatedTeamData(page, evidenceDir)
    const settingsReload = await assertAgentSwarmSettings(page, {
      memoryQueryMaxCandidates: '7', memoryQueryTimeoutMs: '3000',
      memberDenyTools: 'agent_swarm_list_tasks', memberSkills: 'dsh-plugin-development',
    })
    await teamTrigger.click()
    await page.locator('[data-swarm-team-panel]').waitFor({ state: 'hidden', timeout: 10_000 })
    const reloadedSessionId = await officialCurrentSessionId(page)
    if (reloadedSessionId !== rootSessionId) {
      throw new Error(`official Session selection did not survive reload: ${String(reloadedSessionId)}`)
    }

    assertReadOnlyRequests(records)
    assertCleanBrowser(records, 'active browser')
    const result = {
      status: 'pass', rootSessionId, teamId, browser: identity, fixture, ...onboarding,
      bootstrap: { ...bootstrapEvidence(rootSessionId, selectionSource), frameworkTargetObserved: true },
      geometry: {
        desktop: { card: desktopBox, trigger: desktopTriggerBox, frame: desktopFrame, composer: desktopComposerBox },
        toolDetails: { frame: toolFrame, transitionTrace },
        closed: { frame: closedFrame },
        narrow: { panel: narrowBox, panelVisible: narrowPanelVisible, trigger: narrowTriggerBox, frame: narrowFrame },
      },
      nonModal: { ariaModal: false, dockedChatInteractionPreserved: true, officialComposerFocused: true },
      surfaces: {
        wideTeamUsesOfficialDetailsColumn: true,
        toolHandoffKeptDetailsOpen: true,
        toolHandoffFocusRetained: true,
        narrowTeamUsesOfficialConcession: true,
        floatingTeamSurfaceAbsent: true,
      },
      locale: { sequence: ['en', 'zh-CN', 'en'], sameDashboardElement: true, settingsFollowedDsh: true },
      populated: { initial: populated, reload: populatedReload, fixture: representative },
      settings: { initial: settings, reload: settingsReload },
      theme: { light: lightTheme, dark: darkTheme, systemLight: systemLightTheme, systemDark: systemDarkTheme },
      keyboard: ['focus Team', 'Enter', 'focus Chat while docked', 'focus Tool details', 'Enter', 'trigger reopen', 'trigger close', 'trigger reopen', 'Escape with focus return', 'Enter', 'focus Open Captain Chat', 'Enter', 'Team trigger after reload'],
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
    }
    await writeFile(join(evidenceDir, 'r3-browser-active.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    return result
  } catch (error) {
    await writeFailureEvidence(evidenceDir, 'r3-browser-active', page, records, error)
    throw error
  } finally {
    await browser.close()
  }
}

export async function runR3ReloadBrowserProof({
  port, evidenceDir, rootSessionId, teamId, browserExecutable, selectionSource, fixture, representative,
}) {
  const { browser, identity } = await launchBrowser(browserExecutable)
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1000 } })
  await seedOfficialSelection(context, rootSessionId)
  const page = await context.newPage()
  const records = recordBrowser(page)
  try {
    await page.goto(`http://127.0.0.1:${String(port)}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    const onboarding = await completeOfficialOnboarding(page)
    await openReadyDashboard(page)
    const populated = await assertPopulatedTeamData(page, evidenceDir, 'r3-profile-reload-populated')
    const settings = await assertAgentSwarmSettings(page, {
      memoryQueryMaxCandidates: '7', memoryQueryTimeoutMs: '3000',
      memberDenyTools: 'agent_swarm_list_tasks', memberSkills: 'dsh-plugin-development',
    }, join(evidenceDir, 'r3-profile-reload-settings.png'))
    assertReadOnlyRequests(records)
    assertCleanBrowser(records, 'profile-reload browser')
    const result = {
      status: 'pass', rootSessionId, teamId, browser: identity, fixture, representative,
      ...onboarding, bootstrap: { ...bootstrapEvidence(rootSessionId, selectionSource), frameworkTargetObserved: true },
      populated, settings, requests: records.swarmRequests,
      consoleErrors: records.consoleErrors, pageErrors: records.pageErrors,
    }
    await writeFile(join(evidenceDir, 'r3-browser-profile-reload.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    return result
  } catch (error) {
    await writeFailureEvidence(evidenceDir, 'r3-browser-profile-reload', page, records, error)
    throw error
  } finally {
    await context.close()
    await browser.close()
  }
}

async function assertAgentSwarmSettingsAbsent(page) {
  const dialog = await openSettings(page)
  await dialog.getByRole('button', { name: PLUGINS, exact: true }).click()
  await dialog.getByRole('tab', { name: PLUGIN_CONFIGURATION, exact: true }).click()
  await dialog.getByText('Shell', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
  const absent = await dialog.locator('[data-swarm-settings-card]').count() === 0
  await page.keyboard.press('Escape')
  if (!absent) throw new Error('disabled or removed Agent Swarm left its Settings card mounted')
  return true
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
    const settingsCardAbsent = await assertAgentSwarmSettingsAbsent(page)
    await page.screenshot({ path: join(evidenceDir, 'r3-r0-fail-closed.png'), fullPage: false })
    assertCleanBrowser(records, 'R0 browser')
    const result = {
      status: 'pass', browser: identity, bootstrap: bootstrapEvidence(rootSessionId, selectionSource), ...onboarding,
      routeUnavailable: true, ...routeEvidence,
      teamActionAbsent, settingsCardAbsent, renderedData: false,
      requests: records.swarmRequests, consoleErrors: records.consoleErrors, pageErrors: records.pageErrors,
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
    const settingsCardAbsent = await assertAgentSwarmSettingsAbsent(page)
    assertCleanBrowser(records, 'removed browser')
    const result = {
      status: 'pass', browser: identity, bootstrap: bootstrapEvidence(rootSessionId, selectionSource), ...onboarding,
      teamActionAbsent: true, settingsCardAbsent,
      consoleErrors: records.consoleErrors, pageErrors: records.pageErrors,
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
