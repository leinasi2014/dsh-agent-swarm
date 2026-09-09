// Windows candidate process boundaries (issue #126). freeze/accept use only the
// administrator-provisioned account adapter. Retain the full-token probe because
// the official
// WRITE_RESTRICTED token does not intersect DELETE. The controller-only account
// adapter below reuses the public process/Job lifecycle with a dedicated identity.
import koffi from 'koffi'
import { mkdtemp, rm, open } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { AclWriteGrant, workspaceWriteSid } from '@deepseek-ai/dsh-sandbox-windows-acl'
import {
  decodePtr, extendWin32ProcessBindings, spawnCurrentTokenJobProcess, spawnInheritedJobProcess, throwLastError,
  throwWin32, waitForProcessExit,
} from '@deepseek-ai/dsh-win32-process'

const PVOID = koffi.pointer('void')
const PPVOID = koffi.pointer(PVOID)
const U32PTR = koffi.pointer('uint32')
const FILE_READ_EXECUTE = 0x1200A9
const GENERIC_ALL = 0x10000000
const TOKEN_GROUPS = 2
const TOKEN_DEFAULT_DACL = 6
let bindings
const allocatedRoots = new Set()

function win32() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('candidate confinement requires Windows x64')
  }
  bindings ??= extendWin32ProcessBindings(({ kernel32, advapi32, bind }) => ({
    openProcess: bind(kernel32, 'OpenProcess', PVOID, ['uint32', 'int', 'uint32']),
    openProcessToken: bind(advapi32, 'OpenProcessToken', 'int', [PVOID, 'uint32', PPVOID]),
    createProcessWithLogonW: bind(advapi32, 'CreateProcessWithLogonW', 'int', ['str16', 'str16', PVOID, 'uint32', 'str16', 'str16', 'uint32', PVOID, 'str16', PVOID, PVOID]),
    equalSid: bind(advapi32, 'EqualSid', 'int', [PVOID, PVOID]),
    getTokenInformation: bind(advapi32, 'GetTokenInformation', 'int', [PVOID, 'int', PVOID, 'uint32', U32PTR]),
    createRestrictedToken: bind(advapi32, 'CreateRestrictedToken', 'int', [PVOID, 'uint32', 'uint32', PVOID, 'uint32', PVOID, 'uint32', PVOID, PPVOID]),
    setTokenInformation: bind(advapi32, 'SetTokenInformation', 'int', [PVOID, 'int', PVOID, 'uint32']),
    convertStringSidToSidW: bind(advapi32, 'ConvertStringSidToSidW', 'int', ['str16', PPVOID]),
    setEntriesInAclW: bind(advapi32, 'SetEntriesInAclW', 'uint32', ['uint32', PVOID, PVOID, PPVOID]),
    getNamedSecurityInfoW: bind(advapi32, 'GetNamedSecurityInfoW', 'uint32', ['str16', 'int', 'uint32', PPVOID, PPVOID, PPVOID, PPVOID, PPVOID]),
    setNamedSecurityInfoW: bind(advapi32, 'SetNamedSecurityInfoW', 'uint32', ['str16', 'int', 'uint32', PVOID, PVOID, PVOID, PVOID]),
    localFree: bind(kernel32, 'LocalFree', PVOID, [PVOID]),
    getFinalPathNameByHandleW: bind(kernel32, 'GetFinalPathNameByHandleW', 'uint32', [PVOID, PVOID, 'uint32', 'uint32']),
  }))
  return bindings
}

function parseSid(api, sid) {
  const slot = Buffer.alloc(8)
  if (!api.convertStringSidToSidW(sid, slot)) throwLastError(api, 'ConvertStringSidToSidW', sid)
  const pointer = decodePtr(slot)
  if (pointer === null) throw new Error(`null SID: ${sid}`)
  return pointer
}

function tokenInformation(api, token, kind) {
  const needed = Buffer.alloc(4)
  api.getTokenInformation(token, kind, null, 0, needed)
  const size = needed.readUInt32LE()
  if (!size) throwLastError(api, 'GetTokenInformation', `size for ${kind}`)
  const buffer = Buffer.alloc(size)
  if (!api.getTokenInformation(token, kind, buffer, size, needed)) throwLastError(api, 'GetTokenInformation', `${kind}`)
  return buffer
}

function explicitAccess(sid, mask) {
  const entry = Buffer.alloc(48)
  entry.writeUInt32LE(mask, 0)
  entry.writeUInt32LE(1, 4) // GRANT_ACCESS
  entry.writeUInt32LE(3, 8) // OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
  entry.writeUInt32LE(0, 28) // TRUSTEE_IS_SID
  entry.writeBigUInt64LE(sid, 40)
  return entry
}

function mergeAcl(api, currentAcl, sid, mask) {
  const slot = Buffer.alloc(8)
  const result = api.setEntriesInAclW(1, explicitAccess(sid, mask), currentAcl, slot)
  if (result !== 0) throwWin32(api, 'SetEntriesInAclW', result)
  const acl = decodePtr(slot)
  if (acl === null) throw new Error('SetEntriesInAclW returned a null ACL')
  return acl
}

function openCurrentToken(api) {
  const handle = api.openProcess(0x0400, 0, process.pid)
  if (handle === null) throwLastError(api, 'OpenProcess')
  try {
    const slot = Buffer.alloc(8)
    if (!api.openProcessToken(handle, 0x008B, slot)) throwLastError(api, 'OpenProcessToken')
    const token = decodePtr(slot)
    if (token === null) throw new Error('null current process token')
    return token
  } finally { api.closeHandle(handle) }
}

/** Allocate a private directory below a readable drive root, without changing
 * the drive ACL. Node realpath reads every ancestor; user AppData is private to
 * the PM SID and must not receive candidate grants merely to make pnpm start. */
export async function allocatePrivateCandidateRoot() {
  const api = win32()
  const drive = process.env.SYSTEMDRIVE
  if (!/^[A-Za-z]:$/.test(drive ?? '')) throw new Error('missing Windows system drive')
  const root = await mkdtemp(join(`${drive}\\`, 'dsh-candidate-'))
  const token = openCurrentToken(api)
  const allocatedSids = []
  let acl
  try {
    const user = tokenInformation(api, token, 1)
    const userSid = decodePtr(user)
    if (userSid === null) throw new Error('null token user SID')
    for (const sid of ['S-1-5-18', 'S-1-5-32-544']) allocatedSids.push(parseSid(api, sid))
    const entries = Buffer.concat([userSid, ...allocatedSids].map(sid => explicitAccess(sid, GENERIC_ALL)))
    const slot = Buffer.alloc(8)
    const created = api.setEntriesInAclW(3, entries, null, slot)
    if (created !== 0) throwWin32(api, 'SetEntriesInAclW', created, root)
    acl = decodePtr(slot)
    if (acl === null) throw new Error('null private directory ACL')
    // Protect this NEW directory from ambient inherited Users/AU grants.
    const applied = api.setNamedSecurityInfoW(root, 1, 0x80000004, null, null, acl, null)
    if (applied !== 0) throwWin32(api, 'SetNamedSecurityInfoW', applied, root)
    allocatedRoots.add(root)
    return root
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  } finally {
    if (acl !== undefined && acl !== null) api.localFree(acl)
    for (const sid of allocatedSids) api.localFree(sid)
    api.closeHandle(token)
  }
}

// Only called for newly allocated lane directories already carrying the
// corresponding revocable write grant. Its disposer revokes this same SID too.
function addLaneReadAccess(api, path, sid) {
  const daclSlot = Buffer.alloc(8)
  const descriptorSlot = Buffer.alloc(8)
  const result = api.getNamedSecurityInfoW(path, 1, 4, null, null, daclSlot, null, descriptorSlot)
  if (result !== 0) throwWin32(api, 'GetNamedSecurityInfoW', result, path)
  const descriptor = decodePtr(descriptorSlot)
  let merged
  try {
    const currentAcl = decodePtr(daclSlot)
    if (currentAcl === null) throw new Error(`candidate directory has a NULL DACL: ${path}`)
    merged = mergeAcl(api, currentAcl, sid, FILE_READ_EXECUTE)
    const applied = api.setNamedSecurityInfoW(path, 1, 4, null, null, merged, null)
    if (applied !== 0) throwWin32(api, 'SetNamedSecurityInfoW', applied, path)
  } finally {
    if (merged !== undefined) api.localFree(merged)
    if (descriptor !== null) api.localFree(descriptor)
  }
}

/** Reversible read/write capability on caller-owned, newly allocated domains. */
export function grantCandidateDirectories(identityRoot, directories) {
  const api = win32()
  if (!allocatedRoots.has(identityRoot)) throw new Error('candidate capability requires a newly allocated private root')
  for (const path of directories) {
    const local = relative(identityRoot, resolve(path))
    if (local.startsWith('..') || isAbsolute(local)) throw new Error('candidate grant escapes its private root')
  }
  const sid = workspaceWriteSid(identityRoot)
  const grant = AclWriteGrant.create(sid)
  const sidPointer = parseSid(api, sid)
  try {
    for (const path of directories) {
      grant.add(path, false)
      addLaneReadAccess(api, path, sidPointer)
    }
  } catch (error) {
    grant.dispose()
    throw error
  } finally {
    api.localFree(sidPointer)
  }
  let disposed = false
  return { sid, dispose: () => {
    if (disposed) return
    disposed = true
    try { grant.dispose() } finally { allocatedRoots.delete(identityRoot) }
  } }
}

function createFullRestrictedToken(api, capabilitySid) {
  const processHandle = api.openProcess(0x0400, 0, process.pid)
  if (processHandle === null) throwLastError(api, 'OpenProcess')
  const tokenSlot = Buffer.alloc(8)
  let currentToken
  let restrictedToken
  const allocatedSids = []
  try {
    if (!api.openProcessToken(processHandle, 0x008B, tokenSlot)) throwLastError(api, 'OpenProcessToken')
    currentToken = decodePtr(tokenSlot)
    if (currentToken === null) throw new Error('null process token')
    const groups = tokenInformation(api, currentToken, TOKEN_GROUPS)
    let logonSid
    for (let index = 0; index < groups.readUInt32LE(0); index++) {
      const offset = 8 + index * 16
      if (((groups.readUInt32LE(offset + 8) & 0xC0000000) >>> 0) === 0xC0000000) {
        logonSid = groups.readBigUInt64LE(offset)
        break
      }
    }
    if (logonSid === undefined) throw new Error('process token has no logon SID')
    // Users supplies system executable/DLL read access. It does not grant the
    // private PM home; caller SID and Authenticated Users are deliberately absent.
    for (const sid of ['S-1-1-0', 'S-1-5-32-545', capabilitySid]) allocatedSids.push(parseSid(api, sid))
    const restrictingSids = [logonSid, ...allocatedSids]
    const entries = Buffer.alloc(restrictingSids.length * 16)
    restrictingSids.forEach((sid, index) => entries.writeBigUInt64LE(sid, index * 16))
    const restrictedSlot = Buffer.alloc(8)
    // DISABLE_MAX_PRIVILEGE | LUA_TOKEN. Never WRITE_RESTRICTED: DELETE must
    // participate in the restricting-SID access check as well as file writes.
    if (!api.createRestrictedToken(currentToken, 5, 0, null, 0, null, restrictingSids.length, entries, restrictedSlot)) {
      throwLastError(api, 'CreateRestrictedToken')
    }
    restrictedToken = decodePtr(restrictedSlot)
    if (restrictedToken === null) throw new Error('null restricted token')
    // Grant kernel objects that honor TokenDefaultDacl. Named pipes use their
    // own default and still reject ordinary Node child stdio pipes; production
    // freeze/accept integration must resolve that instead of widening the token.
    const defaultDacl = tokenInformation(api, restrictedToken, TOKEN_DEFAULT_DACL)
    const acl = mergeAcl(api, decodePtr(defaultDacl), allocatedSids.at(-1), GENERIC_ALL)
    try {
      const info = Buffer.alloc(8)
      info.writeBigUInt64LE(acl)
      if (!api.setTokenInformation(restrictedToken, TOKEN_DEFAULT_DACL, info, info.length)) throwLastError(api, 'SetTokenInformation')
    } finally { api.localFree(acl) }
    const token = restrictedToken
    restrictedToken = undefined
    return token
  } finally {
    if (restrictedToken !== undefined && restrictedToken !== null) api.closeHandle(restrictedToken)
    if (currentToken !== undefined && currentToken !== null) api.closeHandle(currentToken)
    api.closeHandle(processHandle)
    for (const sid of allocatedSids) api.localFree(sid)
  }
}

/** Controller-only account adapter. Credentials are supplied in memory, never
 * via argv/environment or retained in the returned process. Directory access
 * and the account must already be provisioned by the trusted administrator.
 * expectedSid is an administrator-approved identity pinned by the controller.
 * password is UTF-16LE bytes without a NUL terminator: the adapter wipes its
 * native-call copy; the caller must wipe its own buffer after use.
 * This function does not provision accounts or grant ACLs.
 * The caller owns the returned Job/process handles and their teardown. */
export function spawnWindowsAccountCandidate(options) {
  const { account, password, expectedSid, command, args = [], cwd, env, stdio = { stdin: 0, stdout: 1, stderr: 2 }, inheritStdio = true } = options ?? {}
  if (typeof account !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,19}$/.test(account) || /^(?:CodexSandbox.*|Administrator|DefaultAccount|Guest|WDAGUtilityAccount)$/i.test(account)) {
    throw new Error('a dedicated local candidate account is required')
  }
  if (!Buffer.isBuffer(password) || password.length === 0 || password.length % 2 !== 0) throw new Error('candidate account credentials are not configured')
  for (let index = 0; index < password.length; index += 2) {
    if (password.readUInt16LE(index) === 0) throw new Error('candidate password buffer contains an embedded terminator')
  }
  if (typeof expectedSid !== 'string' || !/^S-1-5-21-\d+-\d+-\d+-\d+$/.test(expectedSid)) throw new Error('candidate account SID is not configured')
  if (Number(expectedSid.split('-').at(-1)) < 1000) throw new Error('candidate account must not be a built-in Windows identity')
  if (!isAbsolute(command ?? '') || !isAbsolute(cwd ?? '') || !Array.isArray(args) || args.some(arg => typeof arg !== 'string')) {
    throw new Error('candidate executable, cwd and argv must be explicit')
  }
  if (env === null || typeof env !== 'object' || Array.isArray(env)) throw new Error('candidate environment must be explicitly supplied')
  const api = win32()
  let expected, administrators, currentToken
  const nativePassword = Buffer.alloc(password.length + 2)
  password.copy(nativePassword)
  try {
    expected = parseSid(api, expectedSid)
    administrators = parseSid(api, 'S-1-5-32-544')
    currentToken = openCurrentToken(api)
    const currentUser = tokenInformation(api, currentToken, 1)
    if (api.equalSid(decodePtr(currentUser), expected)) throw new Error('candidate account must differ from the controller account')
    // Reuse the official paused-create -> Job assignment -> resume lifecycle.
    // Only replace its native process creation call; all other APIs are intact.
    const logonApi = { ...api, createProcessW(application, commandLine, _processAcl, _threadAcl, _inherit, flags, environment, directory, startup, processInfo) {
      try {
        if (commandLine.length > 1023) throw new Error('candidate logon command line exceeds the Windows logon limit')
        if (!inheritStdio) {
          // STARTUPINFOW x64 ABI: no copied controller handles in the account
          // launcher. It opens its own output files after logon and Job attach.
          const info = Buffer.from(koffi.view(startup, 104))
          info.writeUInt32LE(0, 60)
          info.fill(0, 80, 104)
        }
        if (!api.createProcessWithLogonW(account, '.', nativePassword, 1, application, commandLine, flags | 0x08000000, environment, directory, startup, processInfo)) {
          throwWin32(api, 'CreateProcessWithLogonW', api.getLastError())
        }
      } finally { nativePassword.fill(0) }
      // PROCESS_INFORMATION starts with two pointer-sized handles on x64.
      // The official struct decoder is private; use only its public pointer API.
      const handles = Buffer.from(koffi.view(processInfo, 16))
      const info = { hProcess: decodePtr(handles.subarray(0, 8)), hThread: decodePtr(handles.subarray(8, 16)) }
      let token
      try {
        if (info.hProcess === null || info.hThread === null) throw new Error('candidate logon returned incomplete process handles')
        const slot = Buffer.alloc(8)
        if (!api.openProcessToken(info.hProcess, 0x0008, slot)) throwLastError(api, 'OpenProcessToken', 'candidate identity check')
        token = decodePtr(slot)
        if (token === null) throw new Error('candidate token is missing')
        const user = tokenInformation(api, token, 1)
        if (!api.equalSid(decodePtr(user), expected)) throw new Error('candidate logon identity does not match its configured SID')
        if (tokenInformation(api, token, 20).readUInt32LE() !== 0) throw new Error('candidate account must not be elevated')
        const groups = tokenInformation(api, token, TOKEN_GROUPS)
        for (let index = 0; index < groups.readUInt32LE(); index++) {
          // Reject admin membership even when UAC marks it deny-only.
          if (api.equalSid(groups.readBigUInt64LE(8 + index * 16), administrators)) throw new Error('candidate account must not belong to Administrators')
        }
        return 1
      } catch (error) {
        // The official helper has not received ownership yet; it will release
        // its Job/struct after this throw. Never resume a rejected identity.
        if (info.hProcess !== null) api.terminateProcess(info.hProcess, 1)
        if (info.hThread !== null) api.closeHandle(info.hThread)
        if (info.hProcess !== null) api.closeHandle(info.hProcess)
        throw error
      } finally {
        if (token !== undefined && token !== null) api.closeHandle(token)
      }
    } }
    return spawnCurrentTokenJobProcess(logonApi, { command, applicationName: command, args, cwd, env, stdio })
  } finally {
    nativePassword.fill(0)
    if (currentToken !== undefined) api.closeHandle(currentToken)
    if (administrators !== undefined) api.localFree(administrators)
    if (expected !== undefined) api.localFree(expected)
  }
}

/** Native owner used by the controller session; handles never enter argv. */
export function windowsCandidateBindings() { return win32() }

/** Read only the opened candidate file's resolved handle. A candidate-created
 * junction must not turn the controller's artifact copy into a private read. */
export async function copyWindowsCandidateOutput(root, source, destination) {
  const file = await open(source, 'r')
  try {
    const api = win32()
    const buffer = Buffer.alloc(65_536)
    const size = api.getFinalPathNameByHandleW(api.uvGetOsfhandle(file.fd), buffer, 32_768, 0)
    if (size === 0 || size >= 32_768) throw new Error('candidate artifact final path is unavailable')
    const finalPath = buffer.toString('utf16le', 0, size * 2).replace(/^\\\\\?\\/, '')
    const local = relative(resolve(root), finalPath)
    if (local.startsWith('..') || isAbsolute(local) || local === '') throw new Error('candidate artifact resolves outside its execution root')
    const info = await file.stat()
    if (!info.isFile() || info.nlink !== 1) throw new Error('candidate artifact must be a regular single-link file')
    await pipeline(file.createReadStream({ autoClose: false }), createWriteStream(destination, { flags: 'wx' }))
  } finally { await file.close() }
}

/** The dedicated prefix process owns the Job until the candidate has exited. */
function runWindowsCandidate({ sid, command, args, cwd }) {
  const api = win32()
  const token = createFullRestrictedToken(api, sid)
  let child
  try {
    child = spawnInheritedJobProcess(api, { command, args, cwd, token })
    return waitForProcessExit(api, child.process)
  } finally {
    if (child !== undefined) api.closeHandle(child.job)
    api.closeHandle(token)
  }
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/scripts/promotion/windows-candidate.mjs')) {
  try {
    const [sid, cwd, command, ...args] = process.argv.slice(2)
    if (!sid || !cwd || !command) throw new Error('expected capability SID, cwd, executable and argv')
    process.exitCode = runWindowsCandidate({ sid, cwd, command, args })
  } catch (error) {
    console.error(`candidate-confinement: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 127
  }
}
