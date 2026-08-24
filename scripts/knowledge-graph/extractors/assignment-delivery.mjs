import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import ts from 'typescript'
import { taggedSha256 } from '../canonical.mjs'
import { fail } from '../diagnostics.mjs'
import { callBinding, compareText, visit } from './ast.mjs'

const SLICE_ID = 'assignment-delivery-recovery-v1'
const SOURCE_FILES = [
  'src/domain/team-domain-board.ts',
  'src/domain/team-domain-port.ts',
  'src/domain/types.ts',
  'src/runtime/frame-visibility.ts',
  'src/runtime/prompts.ts',
  'src/runtime/scheduling.ts',
  'src/runtime/session-acceptance.ts',
]
const TEST_FILES = [
  'tests/assignment-visibility.spec.ts',
  'tests/scheduling-discipline.spec.ts',
  'tests/team-assignment-checkpoint.spec.ts',
]

const functionSpecs = [
  ['src/domain/team-domain-board.ts', undefined, 'acknowledgeAssignment'],
  ['src/domain/team-domain-board.ts', undefined, 'claimTask'],
  ['src/domain/team-domain-board.ts', undefined, 'cancelAttempt'],
  ['src/domain/team-domain-board.ts', undefined, 'seatAttempt'],
  ['src/runtime/frame-visibility.ts', undefined, 'framePredicate'],
  ['src/runtime/frame-visibility.ts', undefined, 'frameVisibility'],
  ['src/runtime/frame-visibility.ts', undefined, 'waitForFrameClaim'],
  ['src/runtime/prompts.ts', undefined, 'assignmentPrompt'],
  ['src/runtime/scheduling.ts', 'SchedulingPass', 'commitAssignmentAcknowledgement'],
  ['src/runtime/scheduling.ts', 'SchedulingPass', 'dispatchAssignment'],
  ['src/runtime/scheduling.ts', 'SchedulingPass', 'rollbackUndeliveredAssignment'],
  ['src/runtime/scheduling.ts', 'SchedulingPass', 'settleReservedAssignment'],
  ['src/runtime/session-acceptance.ts', undefined, 'messageClaimed'],
  ['src/runtime/session-acceptance.ts', undefined, 'messagePending'],
]

const officialSpecs = [
  ['packages/subagent/subagent/src/continuation.ts', 'SubagentContinuationManager', 'admitWaking'],
  ['packages/subagent/subagent/src/continuation.ts', 'SubagentContinuationManager', 'coldResume'],
  ['packages/subagent/subagent/src/continuation.ts', 'SubagentContinuationManager', 'followup'],
  ['packages/subagent/subagent/src/continuation.ts', 'SubagentContinuationManager', 'submit'],
  ['packages/subagent/subagent/src/continuation.ts', 'SubagentContinuationManager', 'submitAdmitted'],
  ['packages/subagent/subagent/src/index.ts', 'SubagentRuntime', 'followup'],
]

function declarationName(node) {
  return node.name && ts.isIdentifier(node.name) ? node.name.text : undefined
}

function containingClass(node) {
  let current = node.parent
  while (current !== undefined) {
    if (ts.isClassDeclaration(current)) return declarationName(current)
    current = current.parent
  }
  return undefined
}

function findCallable(sourceFile, className, name) {
  const matches = []
  visit(sourceFile, node => {
    if (!(ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node))) return
    if (declarationName(node) === name && containingClass(node) === className) matches.push(node)
  })
  if (matches.length !== 1) fail('KG_SEMANTIC_SOURCE_DECLARATION', `${sourceFile.fileName}:${className ?? '<module>'}.${name} must resolve exactly once`)
  return matches[0]
}

function position(sourceFile, node) {
  const point = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  return { line: point.line + 1, column: point.character + 1 }
}

function tokenValue(node) {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isNumericLiteral(node)) return node.text
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false
  return undefined
}

function semanticAst(node, checker) {
  const item = { kind: ts.SyntaxKind[node.kind] }
  const token = tokenValue(node)
  if (token !== undefined) item.token = token
  if (ts.isBinaryExpression(node)) item.operator = ts.SyntaxKind[node.operatorToken.kind]
  if (ts.isCallExpression(node)) {
    const binding = callBinding(node, checker)
    if (binding !== undefined) {
      item.call = {
        syntaxMethod: binding.syntaxMethod,
        method: binding.method,
        declarationFiles: binding.declarationFiles.map(value => value.replace(/^.*\/node_modules\//u, 'package:')),
        origin: binding.origin ?? null,
      }
    }
  }
  const children = []
  ts.forEachChild(node, child => children.push(semanticAst(child, checker)))
  if (children.length > 0) item.children = children
  return item
}

function callsOf(node, checker, sourceFile) {
  const calls = []
  visit(node, candidate => {
    if (!ts.isCallExpression(candidate)) return
    const binding = callBinding(candidate, checker)
    if (binding === undefined) return
    calls.push({
      syntaxMethod: binding.syntaxMethod,
      method: binding.method,
      declarationFiles: binding.declarationFiles.map(value => value.replace(/^.*\/node_modules\//u, 'package:')),
      ...position(sourceFile, candidate),
    })
  })
  return calls
}

function literalProperties(node) {
  const objects = []
  visit(node, candidate => {
    if (!ts.isObjectLiteralExpression(candidate)) return
    const record = {}
    for (const property of candidate.properties) {
      if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) continue
      const value = tokenValue(property.initializer)
      if (value !== undefined) record[property.name.text] = value
    }
    if (Object.keys(record).length > 0) objects.push(record)
  })
  return objects
}

function comparisonsOf(node) {
  const values = []
  const expression = candidate => {
    if (ts.isIdentifier(candidate)) return candidate.text
    if (ts.isStringLiteral(candidate) || ts.isNumericLiteral(candidate)) return JSON.stringify(candidate.text)
    if (candidate.kind === ts.SyntaxKind.TrueKeyword || candidate.kind === ts.SyntaxKind.FalseKeyword) return String(candidate.kind === ts.SyntaxKind.TrueKeyword)
    if (ts.isPropertyAccessExpression(candidate)) return `${expression(candidate.expression)}.${candidate.name.text}`
    if (ts.isParenthesizedExpression(candidate) || ts.isNonNullExpression(candidate)) return expression(candidate.expression)
    return ts.SyntaxKind[candidate.kind]
  }
  visit(node, candidate => {
    if (!ts.isBinaryExpression(candidate)) return
    values.push(`${expression(candidate.left)} ${ts.tokenToString(candidate.operatorToken.kind) ?? ts.SyntaxKind[candidate.operatorToken.kind]} ${expression(candidate.right)}`)
  })
  return [...new Set(values)].sort(compareText)
}

function callableFact(file, className, name, sourceFile, checker) {
  const node = findCallable(sourceFile, className, name)
  const ast = semanticAst(node, checker)
  return {
    id: `${file}#${className === undefined ? '' : `${className}.`}${name}`,
    file, className: className ?? null, name,
    anchor: position(sourceFile, node),
    calls: callsOf(node, checker, sourceFile),
    comparisons: comparisonsOf(node),
    literalObjects: literalProperties(node),
    semanticDigest: taggedSha256('dsh-agent-swarm/kg1-d1/source-callable/v1', ast),
  }
}

function declarationFileMatches(call, checker, suffix) {
  const binding = callBinding(call, checker)
  return binding !== undefined && binding.declarationFiles.some(file => file.replaceAll('\\', '/').endsWith(suffix))
}

function boundCall(node, checker, method, suffix) {
  return ts.isCallExpression(node)
    && callBinding(node, checker)?.method === method
    && declarationFileMatches(node, checker, suffix)
}

function unwrapExpression(node) {
  if (node === undefined) return undefined
  let current = node
  while (ts.isAwaitExpression(current) || ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current)) current = current.expression
  return current
}

function pathOf(node) {
  const current = unwrapExpression(node)
  if (current === undefined) return undefined
  if (current.kind === ts.SyntaxKind.ThisKeyword) return 'this'
  if (ts.isIdentifier(current) || ts.isPrivateIdentifier(current)) return current.text
  if (ts.isPropertyAccessExpression(current)) {
    const receiver = pathOf(current.expression)
    return receiver === undefined ? undefined : `${receiver}.${current.name.text}`
  }
  return undefined
}

function directCall(statement) {
  if (!ts.isExpressionStatement(statement)) return undefined
  const expression = unwrapExpression(statement.expression)
  return ts.isCallExpression(expression) ? expression : undefined
}

function callsWithin(node, predicate) {
  const matches = []
  visit(node, candidate => {
    if (ts.isCallExpression(candidate) && predicate(candidate)) matches.push(candidate)
  })
  return matches
}

function directReturnValue(statement, value) {
  return ts.isReturnStatement(statement) && statement.expression?.kind === value
}

function directBareReturn(statement) { return ts.isReturnStatement(statement) && statement.expression === undefined }

function exactEquality(node, left, right, operator = ts.SyntaxKind.EqualsEqualsEqualsToken) {
  const current = unwrapExpression(node)
  return ts.isBinaryExpression(current)
    && current.operatorToken.kind === operator
    && pathOf(current.left) === left
    && (pathOf(current.right) === right || (ts.isStringLiteral(current.right) && JSON.stringify(current.right.text) === right))
}

function directIfReturn(statement, left, literal, returnKind) {
  return ts.isIfStatement(statement)
    && exactEquality(statement.expression, left, JSON.stringify(literal))
    && directReturnValue(statement.thenStatement, returnKind)
    && statement.elseStatement === undefined
}

function variableInitializer(statement, name) {
  if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return undefined
  const declaration = statement.declarationList.declarations[0]
  return ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer !== undefined
    ? unwrapExpression(declaration.initializer)
    : undefined
}

function callArguments(call) { return call.arguments.map(argument => pathOf(argument) ?? argument.getText().replace(/\s+/gu, ' ')) }

function directAwaitedCall(statement) {
  if (!ts.isExpressionStatement(statement) || !ts.isAwaitExpression(statement.expression)) return undefined
  const expression = unwrapExpression(statement.expression)
  return expression !== undefined && ts.isCallExpression(expression) ? expression : undefined
}

function numericValue(node) {
  const current = unwrapExpression(node)
  return current !== undefined && ts.isNumericLiteral(current) ? Number(current.text.replaceAll('_', '')) : undefined
}

function timeoutValue(node, checker) {
  const call = unwrapExpression(node)
  return call !== undefined && ts.isCallExpression(call)
    && pathOf(call.expression) === 'AbortSignal.timeout'
    && boundCall(call, checker, 'timeout', 'lib.dom.d.ts')
    && call.arguments.length === 1
    ? numericValue(call.arguments[0]) : undefined
}

function exactPaths(call, paths) {
  return call.arguments.length === paths.length && call.arguments.every((argument, index) => pathOf(argument) === paths[index])
}

function exactSessionId(node, checker, valuePath) {
  const call = unwrapExpression(node)
  return call !== undefined && ts.isCallExpression(call)
    && boundCall(call, checker, 'SessionId', '@deepseek-ai/dsh-session/lib/types/types.d.ts')
    && exactPaths(call, [valuePath])
}

function property(object, name) {
  if (!ts.isObjectLiteralExpression(object)) return undefined
  const matches = object.properties.filter(item => (ts.isPropertyAssignment(item) || ts.isShorthandPropertyAssignment(item))
    && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && item.name.text === name)
  return matches.length === 1 ? matches[0] : undefined
}

function propertyValue(item) {
  return item === undefined ? undefined : ts.isPropertyAssignment(item) ? item.initializer : item.name
}

function exactFollowupPayload(node) {
  const array = unwrapExpression(node)
  if (array === undefined || !ts.isArrayLiteralExpression(array) || array.elements.length !== 1) return false
  const item = unwrapExpression(array.elements[0])
  if (item === undefined || !ts.isObjectLiteralExpression(item) || item.properties.length !== 2) return false
  const type = propertyValue(property(item, 'type'))
  const text = propertyValue(property(item, 'text'))
  return type !== undefined && ts.isStringLiteral(type) && type.text === 'text' && pathOf(text) === 'frame'
}

function exactFollowupOptions(node, checker) {
  const object = unwrapExpression(node)
  if (object === undefined || !ts.isObjectLiteralExpression(object) || object.properties.length !== 2) return undefined
  const source = unwrapExpression(propertyValue(property(object, 'source')))
  const signal = propertyValue(property(object, 'signal'))
  const kind = source && ts.isObjectLiteralExpression(source) ? propertyValue(property(source, 'kind')) : undefined
  const plugin = source && ts.isObjectLiteralExpression(source) ? propertyValue(property(source, 'plugin')) : undefined
  if (source === undefined || !ts.isObjectLiteralExpression(source) || source.properties.length !== 2
    || kind === undefined || !ts.isStringLiteral(kind) || kind.text !== 'plugin'
    || plugin === undefined || !ts.isStringLiteral(plugin) || plugin.text !== 'dsh-agent-swarm') return undefined
  return timeoutValue(signal, checker)
}

function buildDispatchProof(node, checker) {
  const statements = node.body?.statements ?? []
  const frameIndex = statements.findIndex(statement => variableInitializer(statement, 'frame') !== undefined)
  const frameCall = frameIndex < 0 ? undefined : variableInitializer(statements[frameIndex], 'frame')
  const followupIndex = frameIndex + 1
  const followupTry = statements[followupIndex]
  const followupCall = followupTry && ts.isTryStatement(followupTry) ? directAwaitedCall(followupTry.tryBlock.statements[0]) : undefined
  const followupTimeoutMs = followupCall === undefined ? undefined : exactFollowupOptions(followupCall.arguments[3], checker)
  const followupExact = followupCall !== undefined
    && boundCall(followupCall, checker, 'followup', '@deepseek-ai/dsh-subagent/lib/types/index.d.ts')
    && followupCall.arguments.length === 4
    && pathOf(followupCall.arguments[0]) === 'captain'
    && exactSessionId(followupCall.arguments[1], checker, 'attempt.memberSessionId')
    && exactFollowupPayload(followupCall.arguments[2])
    && followupTimeoutMs !== undefined
  const catchStatements = followupTry && ts.isTryStatement(followupTry) ? followupTry.catchClause?.block.statements ?? [] : []
  const rollbackCall = catchStatements.length === 2 ? directAwaitedCall(catchStatements[0]) : undefined
  const rollbackDiagnostic = rollbackCall?.arguments[5] === undefined ? undefined : unwrapExpression(rollbackCall.arguments[5])
  const catchRollbackReturn = rollbackCall !== undefined
    && boundCall(rollbackCall, checker, 'rollbackUndeliveredAssignment', '/src/runtime/scheduling.ts')
    && rollbackCall.arguments.length === 6
    && rollbackCall.arguments.slice(0, 5).every((argument, index) => pathOf(argument) === ['scope', 'team.id', 'captain.id', 'task.id', 'attempt.id'][index])
    && rollbackDiagnostic !== undefined && ts.isTemplateExpression(rollbackDiagnostic)
    && rollbackDiagnostic.head.text === 'assignment delivery failed: '
    && directBareReturn(catchStatements[1])
  const waitIndex = followupIndex + 1
  const waitTry = statements[waitIndex]
  const waitStatements = waitTry && ts.isTryStatement(waitTry) ? waitTry.tryBlock.statements : []
  const member = waitStatements.length === 2 ? variableInitializer(waitStatements[0], 'member') : undefined
  const memberGet = member && ts.isCallExpression(member) ? member : undefined
  const waitIf = waitStatements[1]
  const waitCondition = waitIf && ts.isIfStatement(waitIf) ? unwrapExpression(waitIf.expression) : undefined
  const right = waitCondition && ts.isBinaryExpression(waitCondition)
    && waitCondition.operatorToken.kind === ts.SyntaxKind.BarBarToken ? unwrapExpression(waitCondition.right) : undefined
  const negated = right && ts.isPrefixUnaryExpression(right) && right.operator === ts.SyntaxKind.ExclamationToken ? right.operand : undefined
  const awaited = negated && ts.isAwaitExpression(negated) ? unwrapExpression(negated.expression) : undefined
  const waitCall = awaited && ts.isCallExpression(awaited) ? awaited : undefined
  const waitTimeoutMs = waitCall === undefined ? undefined : timeoutValue(waitCall.arguments[3], checker)
  const waitExact = memberGet !== undefined && boundCall(memberGet, checker, 'get', '@deepseek-ai/dsh-agent/lib/types/index.d.ts')
    && memberGet.arguments.length === 1 && exactSessionId(memberGet.arguments[0], checker, 'attempt.memberSessionId')
    && waitCondition !== undefined && ts.isBinaryExpression(waitCondition)
    && exactEquality(waitCondition.left, 'member', 'undefined')
    && waitCall !== undefined && boundCall(waitCall, checker, 'waitForFrameClaim', '/src/runtime/frame-visibility.ts')
    && waitCall.arguments.length === 4
    && ['this.ctx', 'member', 'frame'].every((value, index) => pathOf(waitCall.arguments[index]) === value)
    && waitTimeoutMs !== undefined
    && directBareReturn(waitIf.thenStatement)
  const waitErrorReturns = waitTry !== undefined && ts.isTryStatement(waitTry)
    && directBareReturn(waitTry.catchClause?.block.statements.at(-1))
  const ackCall = directAwaitedCall(statements[waitIndex + 1])
  const ackExact = ackCall !== undefined && boundCall(ackCall, checker, 'commitAssignmentAcknowledgement', '/src/runtime/scheduling.ts')
    && exactPaths(ackCall, ['scope', 'team.id', 'task', 'attempt.id'])
    && waitIndex + 1 === statements.length - 1
    && callsWithin(node.body, call => boundCall(call, checker, 'commitAssignmentAcknowledgement', '/src/runtime/scheduling.ts')).length === 1
  return {
    frameArguments: frameCall && ts.isCallExpression(frameCall) ? callArguments(frameCall) : [],
    frameBound: frameCall !== undefined && ts.isCallExpression(frameCall)
      && boundCall(frameCall, checker, 'assignmentPrompt', '/src/runtime/prompts.ts')
      && exactPaths(frameCall, ['team', 'task', 'attempt.id', 'executionRootPath']),
    followupExact,
    followupArguments: followupCall === undefined ? [] : callArguments(followupCall),
    followupTimeoutMs,
    rejectedRollbackThenReturn: catchRollbackReturn,
    successWaitAfterFollowup: waitIndex === followupIndex + 1,
    waitExact,
    waitTimeoutMs,
    waitErrorReturns,
    ackOnlyAfterWait: ackExact,
  }
}

function buildSettleProof(node, checker) {
  const statements = node.body?.statements ?? []
  const visibilityStatement = statements.find(statement => variableInitializer(statement, 'visibility') !== undefined)
  const visibilityDeclaration = visibilityStatement && ts.isVariableStatement(visibilityStatement)
    ? visibilityStatement.declarationList.declarations[0] : undefined
  const visibilityInit = visibilityDeclaration?.initializer === undefined ? undefined : unwrapExpression(visibilityDeclaration.initializer)
  const visibilityCall = visibilityInit && ts.isCallExpression(visibilityInit) && boundCall(visibilityInit, checker, 'frameVisibility', '/src/runtime/frame-visibility.ts')
    ? visibilityInit : undefined
  const promptCall = visibilityCall === undefined ? undefined
    : callsWithin(visibilityCall, call => boundCall(call, checker, 'assignmentPrompt', '/src/runtime/prompts.ts'))[0]
  const visibilityIndex = statements.indexOf(visibilityStatement)
  const tail = statements.slice(-3)
  const absent = tail[0]
  const claimed = tail[1]
  const claimedCalls = claimed && ts.isIfStatement(claimed)
    ? [directAwaitedCall(claimed.thenStatement)].filter(call => call !== undefined
      && boundCall(call, checker, 'commitAssignmentAcknowledgement', '/src/runtime/scheduling.ts')) : []
  const visibilityTimeoutMs = visibilityCall === undefined ? undefined : timeoutValue(visibilityCall.arguments[3], checker)
  const label = visibilityCall?.arguments[4] === undefined ? undefined : unwrapExpression(visibilityCall.arguments[4])
  const labelExact = label !== undefined && ts.isTemplateExpression(label) && label.head.text === 'assignment '
    && label.templateSpans.length === 1 && pathOf(label.templateSpans[0].expression) === 'attempt.id'
    && label.templateSpans[0].literal.text === ''
  return {
    visibilityBound: visibilityCall !== undefined && visibilityCall.arguments.length === 5
      && pathOf(visibilityCall.arguments[0]) === 'this.ctx'
      && pathOf(visibilityCall.arguments[1]) === 'attempt.memberSessionId'
      && promptCall !== undefined && exactPaths(promptCall, ['team', 'task', 'attempt.id', 'executionRootPath'])
      && visibilityTimeoutMs !== undefined && labelExact,
    frameArguments: promptCall === undefined ? [] : callArguments(promptCall),
    promptBound: promptCall !== undefined,
    visibilityTimeoutMs,
    absentReturnsFalse: directIfReturn(absent, 'visibility', 'absent', ts.SyntaxKind.FalseKeyword),
    claimedAcknowledges: claimed !== undefined && ts.isIfStatement(claimed)
      && exactEquality(claimed.expression, 'visibility', '"claimed"')
      && claimed.elseStatement === undefined && claimedCalls.length === 1
      && exactPaths(claimedCalls[0], ['scope', 'team.id', 'task', 'attempt.id']),
    pendingUnknownReturnTrue: directReturnValue(tail[2], ts.SyntaxKind.TrueKeyword),
    exactTail: visibilityIndex >= 0 && visibilityIndex < statements.length - 3
      && statements.slice(visibilityIndex + 1).filter(ts.isIfStatement).length === 2
      && callsWithin(node.body, call => boundCall(call, checker, 'frameVisibility', '/src/runtime/frame-visibility.ts')).length === 1,
    visibilityTypeFourStates: visibilityDeclaration !== undefined
      && checker.getTypeAtLocation(visibilityDeclaration.name).types?.map(type => type.value).filter(value => typeof value === 'string').sort().join('|') === 'absent|claimed|pending|unknown',
    noFollowup: callsWithin(node.body, call => callBinding(call, checker)?.method === 'followup').length === 0,
  }
}

function buildRollbackProof(node, checker) {
  const statements = node.body?.statements ?? []
  const onlyTry = statements.length === 1 && ts.isTryStatement(statements[0]) ? statements[0] : undefined
  const block = onlyTry?.tryBlock
  const body = block?.statements ?? []
  const snapshot = body.length === 6 ? variableInitializer(body[0], 'snapshot') : undefined
  const task = body.length === 6 ? variableInitializer(body[1], 'task') : undefined
  const attempt = body.length === 6 ? variableInitializer(body[2], 'attempt') : undefined
  const currentGuard = body[3]
  const reservedGuard = body[4]
  const cancel = body.length === 6 ? directAwaitedCall(body[5]) : undefined
  const exactFind = (callNode, receiver, identity) => {
    if (callNode === undefined || !ts.isCallExpression(callNode) || pathOf(callNode.expression) !== `${receiver}.find` || callNode.arguments.length !== 1) return false
    const callback = unwrapExpression(callNode.arguments[0])
    if (callback === undefined || !ts.isArrowFunction(callback) || callback.parameters.length !== 1 || pathOf(callback.parameters[0].name) !== 'candidate') return false
    return exactEquality(callback.body, 'candidate.id', identity)
  }
  const currentExact = currentGuard !== undefined && ts.isIfStatement(currentGuard)
    && exactEquality(currentGuard.expression, 'task.currentAttemptId', 'attemptId', ts.SyntaxKind.ExclamationEqualsEqualsToken)
    && directBareReturn(currentGuard.thenStatement) && currentGuard.elseStatement === undefined
  const reservedExpression = reservedGuard !== undefined && ts.isIfStatement(reservedGuard) ? unwrapExpression(reservedGuard.expression) : undefined
  const reservedExact = reservedExpression !== undefined && ts.isBinaryExpression(reservedExpression)
    && reservedExpression.operatorToken.kind === ts.SyntaxKind.BarBarToken
    && exactEquality(reservedExpression.left, 'attempt.phase', '"running"', ts.SyntaxKind.ExclamationEqualsEqualsToken)
    && exactEquality(reservedExpression.right, 'attempt.assignmentPhase', '"reserved"', ts.SyntaxKind.ExclamationEqualsEqualsToken)
    && directBareReturn(reservedGuard.thenStatement) && reservedGuard.elseStatement === undefined
  return {
    snapshotBound: snapshot !== undefined && ts.isCallExpression(snapshot)
      && boundCall(snapshot, checker, 'snapshot', '/src/domain/team-domain-port.ts')
      && exactPaths(snapshot, ['scope', 'teamId', 'captainId']),
    taskFromSnapshot: exactFind(task, 'snapshot.team.tasks', 'taskId'),
    attemptFromSnapshot: exactFind(attempt, 'snapshot.team.attempts', 'attemptId'),
    exactCurrentGuard: currentExact,
    exactReservedGuard: reservedExact,
    guardsDominateCancel: body.length === 6 && currentExact && reservedExact,
    cancelArguments: cancel === undefined ? [] : callArguments(cancel),
    cancelBound: cancel !== undefined && boundCall(cancel, checker, 'cancelAttempt', '/src/domain/team-domain-port.ts')
      && exactPaths(cancel, ['scope', 'teamId', 'captainId', 'taskId', 'task.revision', 'diagnostic']),
  }
}

function buildFrameProof(framePredicateNode) {
  const statements = framePredicateNode.body && ts.isBlock(framePredicateNode.body) ? framePredicateNode.body.statements : []
  const returned = statements.length === 1 && ts.isReturnStatement(statements[0]) ? unwrapExpression(statements[0].expression) : undefined
  const some = returned && ts.isArrowFunction(returned) ? unwrapExpression(returned.body) : undefined
  const callback = some && ts.isCallExpression(some) && pathOf(some.expression) === 'candidate.content.some'
    && some.arguments.length === 1 && ts.isArrowFunction(some.arguments[0]) ? some.arguments[0] : undefined
  const condition = callback === undefined ? undefined : unwrapExpression(callback.body)
  return {
    exactTextEquality: condition !== undefined && ts.isBinaryExpression(condition)
      && condition.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      && exactEquality(condition.left, 'block.type', '"text"')
      && exactEquality(condition.right, 'block.text', 'frame'),
    noFuzzyTextMatch: condition !== undefined && callsWithin(condition, () => true).length === 0,
  }
}

function buildPromptProof(promptNode) {
  const statements = promptNode.body?.statements ?? []
  const last = statements.at(-1)
  const returned = last !== undefined && ts.isReturnStatement(last) ? last : undefined
  const template = returned === undefined ? undefined : unwrapExpression(returned.expression)
  const expressions = template && ts.isTemplateExpression(template) ? template.templateSpans.map(span => pathOf(span.expression)) : []
  const counts = new Map(expressions.map(value => [value, expressions.filter(candidate => candidate === value).length]))
  return {
    trustedIdentityTuple: counts.get('team.id') === 1 && counts.get('task.id') === 2
      && counts.get('task.revision') === 2 && counts.get('attemptId') === 2,
    trustedHeaderOrder: expressions.slice(0, 4).join('|') === 'team.id|task.id|task.revision|attemptId',
    submitGuidanceTuple: expressions.slice(-3).join('|') === 'task.id|task.revision|attemptId',
  }
}

function buildSeatProof(seatNode, claimNode, checker) {
  const statements = seatNode.body?.statements ?? []
  const replace = statements.map(directCall).find(call => call !== undefined && boundCall(call, checker, 'replaceTask', '/src/domain/team-domain-shared.ts'))
  const push = statements.map(directCall).find(call => call !== undefined && pathOf(call.expression) === 'team.attempts.push')
  const budgetAssign = statements.map(directCall).find(call => call !== undefined && boundCall(call, checker, 'assign', 'lib.es2015.core.d.ts')
    && pathOf(call.expression) === 'Object.assign')
  const budgetObject = budgetAssign?.arguments.length === 2 && pathOf(budgetAssign.arguments[0]) === 'team'
    ? unwrapExpression(budgetAssign.arguments[1]) : undefined
  const budgetProperty = budgetObject && ts.isObjectLiteralExpression(budgetObject) && budgetObject.properties.length === 1
    ? propertyValue(property(budgetObject, 'budget')) : undefined
  const budget = unwrapExpression(budgetProperty)
  const spread = budget && ts.isObjectLiteralExpression(budget) ? budget.properties[0] : undefined
  const used = budget && ts.isObjectLiteralExpression(budget) ? propertyValue(property(budget, 'usedRequests')) : undefined
  const usedExpression = unwrapExpression(used)
  const budgetExact = budget !== undefined && ts.isObjectLiteralExpression(budget) && budget.properties.length === 2
    && spread !== undefined && ts.isSpreadAssignment(spread) && pathOf(spread.expression) === 'team.budget'
    && usedExpression !== undefined && ts.isBinaryExpression(usedExpression)
    && usedExpression.operatorToken.kind === ts.SyntaxKind.PlusToken
    && pathOf(usedExpression.left) === 'team.budget.usedRequests' && numericValue(usedExpression.right) === 1
  const seatCalls = callsWithin(claimNode.body, call => boundCall(call, checker, 'seatAttempt', '/src/domain/team-domain-board.ts'))
  const withinTransact = seatCalls.length === 1 && (() => {
    let current = seatCalls[0].parent
    while (current !== undefined && current !== claimNode) {
      if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && current.parent && ts.isCallExpression(current.parent)
        && boundCall(current.parent, checker, 'transact', '/src/domain/team-domain-port.ts')) return true
      current = current.parent
    }
    return false
  })()
  return {
    replaceTask: replace !== undefined && exactPaths(replace, ['team', 'task']),
    appendAttempt: push !== undefined && exactPaths(push, ['attempt']),
    incrementUsedRequests: budgetAssign !== undefined && budgetExact,
    seatCallBound: seatCalls.length === 1,
    sameTransaction: withinTransact,
  }
}

function buildOfficialProof(callables, nodes, checker) {
  const byName = new Map(callables.map((fact, index) => [fact.id, nodes[index]]))
  const runtime = byName.get('packages/subagent/subagent/src/index.ts#SubagentRuntime.followup')
  const coldResume = byName.get('packages/subagent/subagent/src/continuation.ts#SubagentContinuationManager.coldResume')
  const followup = byName.get('packages/subagent/subagent/src/continuation.ts#SubagentContinuationManager.followup')
  const submitAdmitted = byName.get('packages/subagent/subagent/src/continuation.ts#SubagentContinuationManager.submitAdmitted')
  const submit = byName.get('packages/subagent/subagent/src/continuation.ts#SubagentContinuationManager.submit')
  const admit = byName.get('packages/subagent/subagent/src/continuation.ts#SubagentContinuationManager.admitWaking')
  const statements = admit?.body?.statements ?? []
  const tryStatement = statements.find(ts.isTryStatement)
  const send = tryStatement?.tryBlock.statements.map(directCall).find(call => call !== undefined && pathOf(call.expression) === 'send')
  const caught = tryStatement?.catchClause?.block.statements ?? []
  const deletion = caught.map(directCall).find(call => call !== undefined && pathOf(call.expression) === 'activation.accepted.delete')
  const directThrow = caught.at(-1)
  const addIndex = statements.findIndex(statement => pathOf(directCall(statement)?.expression) === 'activation.accepted.add')
  const tryIndex = statements.indexOf(tryStatement)
  const wakeIndex = statements.findIndex(statement => pathOf(directCall(statement)?.expression) === 'this.wake')
  const returnIndex = statements.findIndex(statement => ts.isReturnStatement(statement) && pathOf(statement.expression) === 'messageId')
  const soleReturnedCall = target => {
    const body = target?.body?.statements ?? []
    if (body.length !== 1 || !ts.isReturnStatement(body[0])) return undefined
    const expression = unwrapExpression(body[0].expression)
    return expression !== undefined && ts.isCallExpression(expression) ? expression : undefined
  }
  const runtimeCall = soleReturnedCall(runtime)
  const submitLast = submitAdmitted?.body?.statements.at(-1)
  const submitReturn = submitLast && ts.isReturnStatement(submitLast)
    ? unwrapExpression(submitLast.expression) : undefined
  const followupSubmitCalls = callsWithin(followup?.body, call => boundCall(call, checker, 'submitAdmitted', '/packages/subagent/subagent/src/continuation.ts'))
  const submitStatements = submit?.body?.statements ?? []
  const acceptedInitializer = submitStatements.map(statement => variableInitializer(statement, 'accepted')).find(Boolean)
  const acceptedCall = acceptedInitializer && ts.isCallExpression(acceptedInitializer) ? acceptedInitializer : undefined
  const callback = acceptedCall?.arguments[2] && ts.isArrowFunction(acceptedCall.arguments[2]) ? acceptedCall.arguments[2] : undefined
  const callbackStatements = callback?.body && ts.isBlock(callback.body) ? callback.body.statements : []
  const agentFollowup = callbackStatements.length === 1 ? directCall(callbackStatements[0]) : undefined
  const submitAdmittedStatements = submitAdmitted?.body?.statements ?? []
  const authorizeIndex = submitAdmittedStatements.findIndex(statement => {
    const call = directCall(statement)
    return call !== undefined && boundCall(call, checker, 'authorizeLineage', '/packages/subagent/subagent/src/continuation.ts')
  })
  const authorizeCall = authorizeIndex < 0 ? undefined : directCall(submitAdmittedStatements[authorizeIndex])
  const coldStatements = coldResume?.body?.statements ?? []
  const coldAssertIndex = coldStatements.findIndex(statement => {
    const call = directCall(statement)
    return call !== undefined && boundCall(call, checker, 'assertAdmitting', '/packages/subagent/subagent/src/continuation.ts')
  })
  const coldAuthorizeIndex = coldStatements.findIndex(statement => {
    const call = directCall(statement)
    return call !== undefined && boundCall(call, checker, 'authorizeLineage', '/packages/subagent/subagent/src/continuation.ts')
  })
  const coldAssert = coldAssertIndex < 0 ? undefined : directCall(coldStatements[coldAssertIndex])
  const coldAuthorize = coldAuthorizeIndex < 0 ? undefined : directCall(coldStatements[coldAuthorizeIndex])
  const followupStatements = followup?.body?.statements ?? []
  const followupFirst = directCall(followupStatements[0])
  const facadeExact = runtimeCall !== undefined && boundCall(runtimeCall, checker, 'followup', '/packages/subagent/subagent/src/continuation.ts')
    && exactPaths(runtimeCall, ['parent', 'childId', 'content', 'options'])
  const submitAdmittedExact = submitReturn !== undefined && ts.isCallExpression(submitReturn)
    && boundCall(submitReturn, checker, 'submit', '/packages/subagent/subagent/src/continuation.ts')
    && exactPaths(submitReturn, ['activation', 'content', 'source', 'parent'])
    && authorizeCall !== undefined && authorizeIndex < submitAdmittedStatements.length - 1
    && exactPaths(authorizeCall, ['parent', 'activation.childId', 'activation.handle.agent.session.header.parentSession'])
  const coldAuthorizationExact = coldAssert !== undefined && exactPaths(coldAssert, ['parent'])
    && coldAuthorize !== undefined && exactPaths(coldAuthorize, ['parent', 'childId', 'loaded.meta.parentSession'])
    && coldAssertIndex < coldAuthorizeIndex
  return {
    runtimeFacadeDelegates: facadeExact,
    managerUsesSubmitAdmitted: followupSubmitCalls.length === 1 && followupSubmitCalls[0].parent
      && ts.isReturnStatement(followupSubmitCalls[0].parent)
      && exactPaths(followupSubmitCalls[0], ['activation', 'content', 'options.source', 'parent', 'options.signal']),
    managerAuthorizesLiveAndCold: followupFirst !== undefined
      && boundCall(followupFirst, checker, 'assertAdmitting', '/packages/subagent/subagent/src/continuation.ts')
      && exactPaths(followupFirst, ['parent'])
      && coldAuthorizationExact,
    submitAdmittedReturnsSubmit: submitAdmittedExact,
    submitUsesAdmitWaking: acceptedCall !== undefined
      && boundCall(acceptedCall, checker, 'admitWaking', '/packages/subagent/subagent/src/continuation.ts')
      && acceptedCall.arguments.length === 3 && pathOf(acceptedCall.arguments[0]) === 'activation'
      && pathOf(acceptedCall.arguments[1]) === 'message.id'
      && agentFollowup !== undefined && boundCall(agentFollowup, checker, 'followup', '/packages/core/agent/lib/types/runtime-types.d.ts')
      && exactPaths(agentFollowup, ['message'])
      && submitStatements.some(statement => ts.isReturnStatement(statement) && pathOf(statement.expression) === 'accepted'),
    acceptedBeforeSend: addIndex >= 0 && tryIndex > addIndex && send !== undefined,
    catchDeletesThenThrows: deletion !== undefined && ts.isThrowStatement(directThrow) && pathOf(directThrow.expression) === 'error',
    successWakesThenReturns: wakeIndex > tryIndex && returnIndex > wakeIndex,
  }
}

function claimGraceMs(waitNode, checker) {
  const parameter = waitNode.parameters.find(item => pathOf(item.name) === 'graceMs')
  if (parameter?.initializer === undefined || !ts.isIdentifier(parameter.initializer)) return undefined
  const symbol = checker.getSymbolAtLocation(parameter.initializer)
  const declaration = symbol?.valueDeclaration
  return declaration && ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined
    && declaration.getSourceFile() === waitNode.getSourceFile() ? numericValue(declaration.initializer) : undefined
}

function buildProofs(callableNodes, callables, checker, officialNodes, officialCallables, officialChecker) {
  const nodeById = new Map(callables.map((fact, index) => [fact.id, callableNodes[index]]))
  const dispatch = buildDispatchProof(nodeById.get('src/runtime/scheduling.ts#SchedulingPass.dispatchAssignment'), checker)
  const settle = buildSettleProof(nodeById.get('src/runtime/scheduling.ts#SchedulingPass.settleReservedAssignment'), checker)
  const prompt = buildPromptProof(nodeById.get('src/runtime/prompts.ts#assignmentPrompt'))
  return {
    dispatch,
    settle,
    rollback: buildRollbackProof(nodeById.get('src/runtime/scheduling.ts#SchedulingPass.rollbackUndeliveredAssignment'), checker),
    frame: buildFrameProof(nodeById.get('src/runtime/frame-visibility.ts#framePredicate')),
    prompt,
    frameRebuildExact: JSON.stringify(dispatch.frameArguments) === JSON.stringify(settle.frameArguments),
    seat: buildSeatProof(nodeById.get('src/domain/team-domain-board.ts#seatAttempt'), nodeById.get('src/domain/team-domain-board.ts#claimTask'), checker),
    official: buildOfficialProof(officialCallables, officialNodes, officialChecker),
    bounds: {
      followupTimeoutMs: dispatch.followupTimeoutMs,
      waitTimeoutMs: dispatch.waitTimeoutMs,
      visibilityTimeoutMs: settle.visibilityTimeoutMs,
      claimGraceMs: claimGraceMs(nodeById.get('src/runtime/frame-visibility.ts#waitForFrameClaim'), checker),
    },
  }
}

function parseRegistry(text) {
  const documents = []
  let current
  for (const line of text.split(/\r?\n/u)) {
    if (line.startsWith('  - documentId: ')) {
      current = { documentId: line.slice('  - documentId: '.length) }
      documents.push(current)
    } else if (current !== undefined && line.startsWith('    ')) {
      const separator = line.indexOf(': ')
      if (separator > 4) current[line.slice(4, separator)] = line.slice(separator + 2)
    } else if (line.length > 0 && !line.startsWith('    ')) current = undefined
  }
  return documents
}

function markdownSection(text, heading) {
  const lines = text.split(/\r?\n/u)
  const start = lines.findIndex(line => line === heading)
  if (start < 0) fail('KG_SEMANTIC_CONTRACT_SECTION', `missing stable contract section ${heading}`)
  let end = lines.length
  const level = heading.indexOf(' ')
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.startsWith('#'.repeat(level)) && line[level] === ' ') { end = index; break }
  }
  return lines.slice(start, end).join('\n')
}

function requireCall(fact, method, suffix, code = 'KG_SEMANTIC_SOURCE_CALL') {
  if (!fact.calls.some(call => call.method === method
    && call.declarationFiles.length > 0
    && (suffix === undefined || call.declarationFiles.some(file => file.replaceAll('\\', '/').endsWith(suffix))))) {
    fail(code, `${fact.id} does not prove bound call ${method}${suffix === undefined ? '' : ` from ${suffix}`}`)
  }
}

function requireProof(record, code, label) {
  const missing = Object.entries(record).filter(([, value]) => value === false || value === undefined || value === null || (Array.isArray(value) && value.length === 0)).map(([key]) => key)
  if (missing.length > 0) fail(code, `${label} structural proof failed`, { missing })
}

function hasComparison(fact, comparison) {
  return fact.comparisons.includes(comparison)
}

export function validateAssignmentDeliveryFacts(facts) {
  const byName = new Map(facts.callables.map(item => [item.id, item]))
  const fact = id => {
    const value = byName.get(id)
    if (value === undefined) fail('KG_SEMANTIC_SOURCE_DECLARATION', `missing semantic callable ${id}`)
    return value
  }
  const claim = fact('src/domain/team-domain-board.ts#claimTask')
  for (const call of ['transact', 'actorMembership', 'taskRevision', 'isTaskReady', 'budgetAvailable', 'reservationAdmissible', 'seatAttempt']) requireCall(claim, call)
  if (!claim.literalObjects.some(value => value.phase === 'running' && value.assignmentPhase === 'reserved')) fail('KG_SEMANTIC_SOURCE_STATE', 'claimTask does not prove a running/reserved attempt')
  if (!claim.literalObjects.some(value => value.status === 'in_progress')) fail('KG_SEMANTIC_SOURCE_STATE', 'claimTask does not prove in_progress task seating')

  const acknowledge = fact('src/domain/team-domain-board.ts#acknowledgeAssignment')
  for (const call of ['transact', 'assertCurrentAttempt', 'attemptOf', 'replaceAttempt']) requireCall(acknowledge, call)
  if (!hasComparison(acknowledge, "attempt.phase === \"running\"") || !acknowledge.literalObjects.some(value => value.assignmentPhase === 'delivered')) {
    fail('KG_SEMANTIC_SOURCE_STATE', 'acknowledgeAssignment lacks exact running -> delivered proof')
  }

  const dispatch = fact('src/runtime/scheduling.ts#SchedulingPass.dispatchAssignment')
  requireCall(dispatch, 'followup', '@deepseek-ai/dsh-subagent/lib/types/index.d.ts')
  requireCall(dispatch, 'waitForFrameClaim', '/src/runtime/frame-visibility.ts')
  requireCall(dispatch, 'commitAssignmentAcknowledgement', '/src/runtime/scheduling.ts')
  requireCall(dispatch, 'assignmentPrompt', '/src/runtime/prompts.ts')
  requireCall(dispatch, 'rollbackUndeliveredAssignment', '/src/runtime/scheduling.ts')
  const rollback = fact('src/runtime/scheduling.ts#SchedulingPass.rollbackUndeliveredAssignment')
  for (const fragment of ['task.currentAttemptId !== attemptId', 'attempt.phase !== "running"', 'attempt.assignmentPhase !== "reserved"']) {
    if (!hasComparison(rollback, fragment)) fail('KG_SEMANTIC_GUARD', `rollback lacks exact guard ${fragment}`)
  }
  requireCall(rollback, 'snapshot', '/src/domain/team-domain-port.ts')
  requireCall(rollback, 'cancelAttempt', '/src/domain/team-domain-port.ts')

  const settle = fact('src/runtime/scheduling.ts#SchedulingPass.settleReservedAssignment')
  requireCall(settle, 'frameVisibility', '/src/runtime/frame-visibility.ts')
  requireCall(settle, 'commitAssignmentAcknowledgement', '/src/runtime/scheduling.ts')
  if (!hasComparison(settle, 'visibility === "absent"') || !hasComparison(settle, 'visibility === "claimed"')) {
    fail('KG_SEMANTIC_SOURCE_STATE', 'reserved fold lacks claimed/absent split')
  }
  const visibility = fact('src/runtime/frame-visibility.ts#frameVisibility')
  for (const call of ['messageClaimed', 'messagePending', 'flush', 'inspect']) requireCall(visibility, call)
  const wait = fact('src/runtime/frame-visibility.ts#waitForFrameClaim')
  requireCall(wait, 'messageClaimed', '/src/runtime/session-acceptance.ts')
  requireCall(wait, 'flush', '@deepseek-ai/dsh-session/lib/types/index.d.ts')
  const claimed = fact('src/runtime/session-acceptance.ts#messageClaimed')
  const pending = fact('src/runtime/session-acceptance.ts#messagePending')
  if (!hasComparison(claimed, 'event.type === "user/message"')) fail('KG_SEMANTIC_SESSION_CLAIM', 'claimed proof is not user/message')
  requireCall(pending, 'pendingInboxMessages')

  const official = new Map(facts.official.callables.map(item => [item.id, item]))
  const officialFact = suffix => {
    const value = [...official.values()].find(item => item.id.endsWith(suffix))
    if (value === undefined) fail('KG_SEMANTIC_OFFICIAL_SOURCE', `missing official callable ${suffix}`)
    return value
  }
  requireCall(officialFact('#SubagentContinuationManager.submitAdmitted'), 'submit', '/packages/subagent/subagent/src/continuation.ts')
  requireCall(officialFact('#SubagentContinuationManager.submit'), 'admitWaking', '/packages/subagent/subagent/src/continuation.ts')
  requireCall(officialFact('#SubagentContinuationManager.followup'), 'submitAdmitted', '/packages/subagent/subagent/src/continuation.ts')
  requireCall(officialFact('#SubagentRuntime.followup'), 'followup', '/packages/subagent/subagent/src/continuation.ts')

  requireProof(facts.proofs.prompt, 'KG_SEMANTIC_FRAME_PROOF', 'trusted assignment prompt identity')
  if (!facts.proofs.frameRebuildExact) fail('KG_SEMANTIC_FRAME_PROOF', 'dispatch and recovery do not rebuild the same assignmentPrompt arguments')
  if (JSON.stringify(facts.proofs.dispatch.frameArguments) !== JSON.stringify(['team', 'task', 'attempt.id', 'executionRootPath'])) {
    fail('KG_SEMANTIC_FRAME_PROOF', 'dispatch assignmentPrompt arguments drifted', { arguments: facts.proofs.dispatch.frameArguments })
  }
  const expectedBounds = { followupTimeoutMs: 30000, waitTimeoutMs: 30000, visibilityTimeoutMs: 30000, claimGraceMs: 5000 }
  const boundsComplete = Object.keys(expectedBounds).every(key => facts.bounds[key] !== undefined)
  if (boundsComplete && JSON.stringify(facts.bounds) !== JSON.stringify(expectedBounds)) {
    fail('KG_SEMANTIC_BOUND', 'assignment delivery bounds drifted from registered stable contract', { expected: expectedBounds, actual: facts.bounds })
  }
  requireProof(facts.proofs.dispatch, 'KG_SEMANTIC_CONTROL_FLOW', 'dispatch assignment')
  requireProof(facts.proofs.settle, 'KG_SEMANTIC_CONTROL_FLOW', 'reserved four-state fold')
  requireProof(facts.proofs.rollback, 'KG_SEMANTIC_ROLLBACK_PROOF', 'exact rollback')
  requireProof(facts.proofs.frame, 'KG_SEMANTIC_FRAME_PROOF', 'exact frame predicate')
  requireProof(facts.proofs.seat, 'KG_SEMANTIC_BUDGET_ATOMIC', 'claim seatAttempt atomic budget charge')
  requireProof(facts.proofs.official, 'KG_SEMANTIC_OFFICIAL_CONTROL_FLOW', 'official inbox admission')
  requireProof(facts.bounds, 'KG_SEMANTIC_BOUND', 'assignment delivery bounds')
  if (JSON.stringify(facts.proofs.rollback.cancelArguments) !== JSON.stringify(['scope', 'teamId', 'captainId', 'taskId', 'task.revision', 'diagnostic'])) {
    fail('KG_SEMANTIC_ROLLBACK_PROOF', 'rollback cancelAttempt must use fresh task.revision', { arguments: facts.proofs.rollback.cancelArguments })
  }
  if (facts.official.commit !== facts.official.registeredCommit || facts.official.tree !== facts.official.registeredTree) fail('KG_SEMANTIC_OFFICIAL_PIN', 'official checkout does not match the registered release baseline')
  const requiredContracts = new Map(facts.contracts.map(item => [item.documentId, item]))
  for (const id of ['core-protocol', 'testing-verification']) {
    const contract = requiredContracts.get(id)
    if (contract?.role !== 'stable-authority') fail('KG_SEMANTIC_CONTRACT_UNSTABLE', `${id} is not a registered stable authority`)
  }
  if (requiredContracts.get('i1b-v2-effect-ledger-decision')?.role === 'stable-authority') fail('KG_SEMANTIC_CONTRACT_UNSTABLE', 'proposal document cannot masquerade as a stable assignment contract')
  if (!facts.tests.every(item => item.titles.length > 0)) fail('KG_SEMANTIC_TEST_TRACE', 'assignment slice test trace is incomplete')
  return facts
}

function testFact(file, sourceFile, checker) {
  const titles = []
  visit(sourceFile, node => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== 'it') return
    const title = node.arguments[0]
    if (title && (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title))) titles.push(title.text)
  })
  return { file, titles, semanticDigest: taggedSha256('dsh-agent-swarm/kg1-d1/test/v1', semanticAst(sourceFile, checker)) }
}

function overrideCompilerHost(options, overrides) {
  const host = ts.createCompilerHost(options, true)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const replacement = overrides.get(resolve(fileName).toLowerCase())
    return replacement === undefined
      ? original(fileName, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(fileName, replacement, languageVersion, true, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  }
  return host
}

export async function extractAssignmentDeliveryFacts(rootInput, options = {}) {
  const root = resolve(rootInput)
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json')
  if (configPath === undefined) fail('KG_SEMANTIC_TSCONFIG', 'tsconfig.json is missing')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
  const rootNames = [...new Set([...parsed.fileNames, ...SOURCE_FILES.map(file => resolve(root, file)), ...TEST_FILES.map(file => resolve(root, file))])]
  const programOptions = { ...parsed.options, noEmit: true, skipLibCheck: true }
  const sourceOverrides = new Map(Object.entries(options.sourceOverrides ?? {}).map(([file, text]) => [resolve(root, file).toLowerCase(), text]))
  const program = ts.createProgram({ rootNames, options: programOptions, host: overrideCompilerHost(programOptions, sourceOverrides) })
  const checker = program.getTypeChecker()
  const records = new Map()
  for (const file of [...SOURCE_FILES, ...TEST_FILES]) {
    const sourceFile = program.getSourceFile(resolve(root, file))
    if (sourceFile === undefined) fail('KG_SEMANTIC_SOURCE_FILE', `compiler did not load ${file}`)
    records.set(file, sourceFile)
  }
  const callableNodes = functionSpecs.map(([file, className, name]) => findCallable(records.get(file), className, name))
  const callables = functionSpecs.map(([file, className, name], index) => {
    const ast = semanticAst(callableNodes[index], checker)
    return {
      id: `${file}#${className === undefined ? '' : `${className}.`}${name}`,
      file, className: className ?? null, name,
      anchor: position(records.get(file), callableNodes[index]),
      calls: callsOf(callableNodes[index], checker, records.get(file)),
      comparisons: comparisonsOf(callableNodes[index]),
      literalObjects: literalProperties(callableNodes[index]),
      semanticDigest: taggedSha256('dsh-agent-swarm/kg1-d1/source-callable/v1', ast),
    }
  })

  const registryText = await readFile(resolve(root, 'docs/governance/document-registry.yaml'), 'utf8')
  const registry = parseRegistry(registryText)
  const contracts = registry.filter(item => ['core-protocol', 'testing-verification', 'i1b-v2-effect-ledger-decision'].includes(item.documentId))
  const coreText = await readFile(resolve(root, 'docs/04-core-protocol.md'), 'utf8')
  const testingText = await readFile(resolve(root, 'docs/08-testing-verification.md'), 'utf8')
  const contractSlices = {
    scheduling: taggedSha256('dsh-agent-swarm/kg1-d1/contract/v1', markdownSection(coreText, '## 7. Scheduling')),
    recovery: taggedSha256('dsh-agent-swarm/kg1-d1/contract/v1', markdownSection(coreText, '## 8. Recovery')),
    verification: taggedSha256('dsh-agent-swarm/kg1-d1/contract/v1', testingText.split(/\r?\n/u).filter(line => line.includes('tests/assignment-visibility.spec.ts') || line.includes('tests/team-assignment-checkpoint.spec.ts') || line.includes('tests/scheduling-discipline.spec.ts'))),
  }

  const baseline = JSON.parse(await readFile(resolve(root, 'docs/OFFICIAL_BASELINE.json'), 'utf8'))
  const officialRoot = resolve(root, '../../..')
  const officialCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: officialRoot, encoding: 'utf8' }).trim()
  const officialTree = execFileSync('git', ['show', '-s', '--format=%T', officialCommit], { cwd: officialRoot, encoding: 'utf8' }).trim()
  const registeredTree = execFileSync('git', ['show', '-s', '--format=%T', baseline.commit], { cwd: officialRoot, encoding: 'utf8' }).trim()
  const officialFiles = [...new Set(officialSpecs.map(([file]) => resolve(officialRoot, file)))]
  const officialOptions = { noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.Latest, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext }
  const officialOverrides = new Map(Object.entries(options.officialSourceOverrides ?? {}).map(([file, text]) => [resolve(officialRoot, file).toLowerCase(), text]))
  const officialProgram = ts.createProgram({ rootNames: officialFiles, options: officialOptions, host: overrideCompilerHost(officialOptions, officialOverrides) })
  const officialChecker = officialProgram.getTypeChecker()
  const officialNodes = officialSpecs.map(([file, className, name]) => {
    const sourceFile = officialProgram.getSourceFile(resolve(officialRoot, file))
    if (sourceFile === undefined) fail('KG_SEMANTIC_OFFICIAL_SOURCE', `compiler did not load official source ${file}`)
    return findCallable(sourceFile, className, name)
  })
  const officialCallables = officialSpecs.map(([file, className, name], index) => {
    const sourceFile = officialNodes[index].getSourceFile()
    return callableFact(file, className, name, sourceFile, officialChecker)
  })

  const facts = {
    schemaVersion: 1,
    sliceId: SLICE_ID,
    callables: [...callables].sort((left, right) => compareText(left.id, right.id)),
    official: {
      repository: baseline.repository, release: baseline.release, registeredCommit: baseline.commit,
      registeredTree, commit: officialCommit, tree: officialTree,
      callables: [...officialCallables].sort((left, right) => compareText(left.id, right.id)),
    },
    contracts,
    contractSlices,
    tests: TEST_FILES.map(file => testFact(file, records.get(file), checker)).sort((left, right) => compareText(left.file, right.file)),
  }
  facts.proofs = buildProofs(callableNodes, callables, checker, officialNodes, officialCallables, officialChecker)
  facts.bounds = facts.proofs.bounds
  facts.digest = taggedSha256('dsh-agent-swarm/kg1-d1/raw-semantic-facts/v1', facts)
  return options.validate === false ? facts : validateAssignmentDeliveryFacts(facts)
}
