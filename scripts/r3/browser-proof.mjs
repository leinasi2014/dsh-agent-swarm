import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'

const TEAM_NAME = /^(Team|团队)$/u
const OPEN_CHAT = /^(Open Captain Chat|打开 Captain 对话)$/u

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
    const dialog = page.getByRole('dialog', { name: 'Agent Team' })
    await dialog.waitFor({ state: 'visible' })
    if (!await dashboard.getByText('R2 isolated Profile team', { exact: true }).isVisible()) {
      throw new Error('browser Team name did not come from the real R2 producer')
    }
    await page.screenshot({ path: join(evidenceDir, 'r3-team-dashboard.png'), fullPage: false })

    const openChat = page.getByRole('button', { name: OPEN_CHAT })
    await openChat.focus()
    await page.keyboard.press('Enter')
    await dialog.waitFor({ state: 'hidden', timeout: 20_000 })
    const selected = page.locator('[role="treeitem"][aria-selected="true"]')
    await selected.waitFor({ state: 'visible', timeout: 10_000 })
    await page.getByRole('textbox').last().waitFor({ state: 'visible', timeout: 10_000 })
    const selectedSessionId = await officialCurrentSessionId(page)
    if (selectedSessionId !== rootSessionId) {
      throw new Error(`official Session selection did not match the R2 root: ${String(selectedSessionId)}`)
    }

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 })
    await openReadyDashboard(page)
    await page.keyboard.press('Escape')
    await page.getByRole('dialog', { name: 'Agent Team' }).waitFor({ state: 'hidden', timeout: 10_000 })
    const reloadedSessionId = await officialCurrentSessionId(page)
    if (reloadedSessionId !== rootSessionId) {
      throw new Error(`official Session selection did not survive reload: ${String(reloadedSessionId)}`)
    }

    assertReadOnlyRequests(records)
    assertCleanBrowser(records, 'active browser')
    const result = {
      status: 'pass', rootSessionId, teamId, browser: identity, fixture, ...onboarding,
      bootstrap: { ...bootstrapEvidence(rootSessionId, selectionSource), frameworkTargetObserved: true },
      keyboard: ['focus Team', 'Enter', 'focus Open Captain Chat', 'Enter', 'Escape after reload'],
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
    assertCleanBrowser(records, 'R0 browser')
    const result = {
      status: 'pass', browser: identity, bootstrap: bootstrapEvidence(rootSessionId, selectionSource), ...onboarding,
      routeUnavailable: true, ...routeEvidence,
      teamActionAbsent, renderedData: false,
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
    assertCleanBrowser(records, 'removed browser')
    const result = {
      status: 'pass', browser: identity, bootstrap: bootstrapEvidence(rootSessionId, selectionSource), ...onboarding,
      teamActionAbsent: true,
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
