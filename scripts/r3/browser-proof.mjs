import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'

const TEAM_NAME = /^(Team|团队)$/u
const OPEN_CHAT = /^(Open Captain Chat|打开 Captain 对话)$/u

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

async function openReadyDashboard(page) {
  const team = await selectRootSession(page)
  await team.focus()
  await page.keyboard.press('Enter')
  const dashboard = page.locator('[data-swarm-team-dashboard]')
  await dashboard.waitFor({ state: 'visible', timeout: 20_000 })
  await page.locator('[data-swarm-team-dashboard][data-phase="ready"]').waitFor({ state: 'visible', timeout: 20_000 })
  return dashboard
}

export async function runR3ActiveBrowserProof({ port, evidenceDir, rootSessionId, teamId }) {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const records = recordBrowser(page)
  try {
    await page.goto(`http://127.0.0.1:${String(port)}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    const dashboard = await openReadyDashboard(page)
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

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 })
    await openReadyDashboard(page)
    await page.keyboard.press('Escape')
    await page.getByRole('dialog', { name: 'Agent Team' }).waitFor({ state: 'hidden', timeout: 10_000 })

    assertReadOnlyRequests(records)
    if (records.pageErrors.length > 0) throw new Error(`browser page errors: ${records.pageErrors.join(' | ')}`)
    const result = {
      status: 'pass', rootSessionId, teamId,
      keyboard: ['focus Team', 'Enter', 'focus Open Captain Chat', 'Enter', 'Escape after reload'],
      handoff: { officialSessionSelected: true, chatTextboxVisible: true },
      reload: true,
      requests: records.swarmRequests,
      consoleErrors: records.consoleErrors,
      pageErrors: records.pageErrors,
    }
    await writeFile(join(evidenceDir, 'r3-browser-active.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    return result
  } finally {
    await browser.close()
  }
}

export async function runR3R0BrowserProof({ port, evidenceDir }) {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  const records = recordBrowser(page)
  try {
    await page.goto(`http://127.0.0.1:${String(port)}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    const team = await selectRootSession(page)
    await team.click()
    await page.locator('[data-swarm-team-dashboard][data-phase="error"]').waitFor({ state: 'visible', timeout: 20_000 })
    if (await page.locator('[data-swarm-team-dashboard] section').count() !== 0) {
      throw new Error('R0 browser rendered Team data without an active read Host')
    }
    await page.screenshot({ path: join(evidenceDir, 'r3-r0-fail-closed.png'), fullPage: false })
    const result = { status: 'pass', routeUnavailable: true, renderedData: false, requests: records.swarmRequests }
    await writeFile(join(evidenceDir, 'r3-browser-r0.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    return result
  } finally {
    await browser.close()
  }
}

export async function runR3RemovedBrowserProof({ port, evidenceDir }) {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ locale: 'en-US' })
  const page = await context.newPage()
  try {
    await page.goto(`http://127.0.0.1:${String(port)}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    const rows = page.getByRole('treeitem')
    if (await rows.count() > 0) await rows.first().click()
    const absent = await page.getByRole('button', { name: TEAM_NAME }).count() === 0
    if (!absent) throw new Error('removed package left the Team client action mounted')
    const result = { status: 'pass', teamActionAbsent: true }
    await writeFile(join(evidenceDir, 'r3-browser-removed.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    return result
  } finally {
    await browser.close()
  }
}
