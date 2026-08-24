import ts from 'typescript'
import {
  anchor, callBinding, callShape, compareText, containingSymbol, literal, makeDiagnostic,
  propertyName, slash, stableSort, staticValue, unwrap, visit,
  symbolComesFrom, symbolOf,
} from './ast.mjs'

const DIAGNOSTIC_REGISTER_NAME = /^register[A-Z]/u

function className(node) {
  return node.name?.text ?? '<anonymous-class>'
}

function isUndefined(node) {
  const value = unwrap(node)
  return ts.isIdentifier(value) && value.text === 'undefined'
}

function stableSymbol(symbol) {
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0]
  return declaration === undefined ? undefined : `${slash(declaration.getSourceFile().fileName)}:${declaration.pos}:${declaration.end}`
}

function nodeSymbol(node, checker) {
  const value = unwrap(node)
  if (ts.isPropertyAccessExpression(value)) return symbolOf(value.name, checker)
  if (ts.isElementAccessExpression(value) && value.argumentExpression !== undefined) return symbolOf(value.argumentExpression, checker)
  return symbolOf(value, checker)
}

function thisPropertySymbol(node, checker) {
  const value = unwrap(node)
  if (!ts.isPropertyAccessExpression(value) || value.expression.kind !== ts.SyntaxKind.ThisKeyword) return undefined
  return symbolOf(value.name, checker)
}

function sameSymbol(left, right) {
  const leftId = stableSymbol(left)
  return leftId !== undefined && leftId === stableSymbol(right)
}

function canonicalExpression(node, checker, stack = new Set()) {
  const value = unwrap(node)
  if (value === undefined) return 'missing'
  const primitive = literal(value)
  if (primitive !== undefined) return `literal:${JSON.stringify(primitive)}`
  if (isUndefined(value)) return 'undefined'
  if (ts.isIdentifier(value)) {
    const symbol = symbolOf(value, checker)
    const identity = stableSymbol(symbol)
    const declaration = symbol?.valueDeclaration
    if (identity !== undefined && !stack.has(identity) && ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
      const next = new Set(stack); next.add(identity)
      const initializer = unwrap(declaration.initializer)
      if (ts.isIdentifier(initializer)) return canonicalExpression(initializer, checker, next)
    }
    return identity === undefined ? `unresolved:${value.text}` : `symbol:${identity}`
  }
  if (ts.isPropertyAccessExpression(value)) {
    const identity = stableSymbol(symbolOf(value.name, checker))
    return identity === undefined ? `property-unresolved:${value.name.text}` : `property:${identity}`
  }
  if (ts.isCallExpression(value)) {
    const shape = callShape(value)
    const callable = shape === undefined ? undefined : nodeSymbol(value.expression, checker)
    const receiver = shape?.receiver === undefined ? '' : canonicalExpression(shape.receiver, checker, stack)
    const args = value.arguments.map(argument => canonicalExpression(argument, checker, stack)).join(',')
    return `call:${stableSymbol(callable) ?? shape?.method ?? 'unresolved'}(${receiver};${args})`
  }
  return `node:${value.kind}:${value.pos}:${value.end}`
}

function sameExpression(left, right, checker) {
  return canonicalExpression(left, checker) === canonicalExpression(right, checker)
}

function factExpression(node, context) {
  return canonicalExpression(node, context.checker).replaceAll(`${slash(context.root)}/`, '')
}

function directWalk(root, callback) {
  const walk = (node) => {
    callback(node)
    ts.forEachChild(node, child => { if (!ts.isFunctionLike(child)) walk(child) })
  }
  walk(root)
}

function storageCall(node, storageSymbol, checker, methods) {
  const call = callShape(node)
  if (call?.receiver === undefined || !methods.includes(call.method)) return undefined
  return sameSymbol(thisPropertySymbol(call.receiver, checker), storageSymbol) ? call : undefined
}

function initialMutation(method, declaredBySymbol, checker) {
  if (method.body === undefined) return undefined
  const mutations = []
  for (const statement of method.body.statements) {
    // Registration is proved only from the reachable, top-level control
    // spine. A mutation hidden in a branch (including `if (false)`) is not
    // evidence, and no statement after an unconditional terminal is live.
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
      if (mutations.length === 0) return undefined
      break
    }
    if (!ts.isExpressionStatement(statement)) continue
    const node = unwrap(statement.expression)
    const call = callShape(node)
    if (call?.receiver !== undefined && call.method === 'set') {
      const storageSymbol = thisPropertySymbol(call.receiver, checker)
      const declaration = stableSymbol(storageSymbol)
      if (declaration !== undefined && declaredBySymbol.has(declaration) && call.arguments.length >= 2) {
        mutations.push({ kind: 'map', storageSymbol, key: call.arguments[0], value: call.arguments[1], node })
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const storageSymbol = thisPropertySymbol(node.left, checker)
      const declaration = stableSymbol(storageSymbol)
      if (declaration !== undefined && declaredBySymbol.has(declaration) && !isUndefined(node.right)) {
        mutations.push({ kind: 'single-slot', storageSymbol, key: undefined, value: node.right, node })
      }
    }
  }
  return mutations.length === 1 ? mutations[0] : undefined
}

function directStatement(node, block) {
  let current = node
  while (current.parent !== block && current.parent !== undefined) current = current.parent
  return current.parent === block ? current : undefined
}

function directThrowBranch(statement) {
  if (statement === undefined) return false
  if (ts.isThrowStatement(statement)) return true
  return ts.isBlock(statement) && statement.statements.length === 1 && ts.isThrowStatement(statement.statements[0])
}

function predicateProof(condition, mutation, checker) {
  const raw = unwrap(condition)
  const negated = ts.isPrefixUnaryExpression(raw) && raw.operator === ts.SyntaxKind.ExclamationToken
  const node = negated ? unwrap(raw.operand) : raw
  if (mutation.kind === 'map') {
    const has = storageCall(node, mutation.storageSymbol, checker, ['has'])
    if (has !== undefined && has.arguments.length === 1 && sameExpression(has.arguments[0], mutation.key, checker)) {
      return { duplicateOnTrue: !negated, predicate: negated ? 'not-has' : 'has' }
    }
    if (!negated && ts.isBinaryExpression(node)
      && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.operatorToken.kind)) {
      const candidates = [[node.left, node.right], [node.right, node.left]]
      for (const [stored, other] of candidates) {
        const get = storageCall(stored, mutation.storageSymbol, checker, ['get'])
        if (get !== undefined && get.arguments.length === 1 && sameExpression(get.arguments[0], mutation.key, checker) && isUndefined(other)) {
          return { duplicateOnTrue: node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken, predicate: 'get' }
        }
      }
    }
    return undefined
  }
  if (negated || !ts.isBinaryExpression(node)
    || ![ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.operatorToken.kind)) return undefined
  const candidates = [[node.left, node.right], [node.right, node.left]]
  for (const [stored, other] of candidates) {
    if (sameSymbol(thisPropertySymbol(stored, checker), mutation.storageSymbol) && isUndefined(other)) {
      return { duplicateOnTrue: node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken, predicate: 'slot-defined' }
    }
  }
  return undefined
}

function proveDuplicateGuard(method, mutation, checker) {
  if (method.body === undefined) return undefined
  const mutationStatement = directStatement(mutation.node, method.body)
  if (mutationStatement === undefined) return undefined
  const mutationIndex = method.body.statements.indexOf(mutationStatement)
  for (const statement of method.body.statements.slice(0, mutationIndex)) {
    if (!ts.isIfStatement(statement)) continue
    const proof = predicateProof(statement.expression, mutation, checker)
    if (proof === undefined) continue
    const rejection = proof.duplicateOnTrue ? statement.thenStatement : statement.elseStatement
    if (directThrowBranch(rejection)) return proof
  }
  return undefined
}

function cleanupMutations(functionNode, checker) {
  const result = []
  directWalk(functionNode.body, node => {
    const call = callShape(node)
    if (call?.receiver !== undefined && call.method === 'delete') {
      const storageSymbol = thisPropertySymbol(call.receiver, checker)
      if (storageSymbol !== undefined) result.push({ kind: 'delete', storageSymbol, key: call.arguments[0], node })
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && isUndefined(node.right)) {
      const storageSymbol = thisPropertySymbol(node.left, checker)
      if (storageSymbol !== undefined) result.push({ kind: 'clear', storageSymbol, key: undefined, node })
    }
  })
  return result
}

function identityPredicate(condition, mutation, checker) {
  const node = unwrap(condition)
  if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return undefined
  const candidates = [[node.left, node.right], [node.right, node.left]]
  for (const [stored, expected] of candidates) {
    let storageMatches = false
    let keyMatches = mutation.kind === 'single-slot'
    if (mutation.kind === 'map') {
      const get = storageCall(stored, mutation.storageSymbol, checker, ['get'])
      storageMatches = get !== undefined
      keyMatches = get?.arguments.length === 1 && sameExpression(get.arguments[0], mutation.key, checker)
    } else storageMatches = sameSymbol(thisPropertySymbol(stored, checker), mutation.storageSymbol)
    if (storageMatches && keyMatches && sameExpression(expected, mutation.value, checker)) return { node }
  }
  return undefined
}

function descendantOf(node, ancestor) {
  let current = node
  while (current !== undefined) {
    if (current === ancestor) return true
    current = current.parent
  }
  return false
}

function proveIdentityDisposer(method, mutation, checker) {
  if (method.body === undefined) return undefined
  const returnedFunctions = []
  directWalk(method.body, node => {
    if (!ts.isReturnStatement(node) || node.expression === undefined) return
    const returned = unwrap(node.expression)
    if (ts.isArrowFunction(returned) || ts.isFunctionExpression(returned)) returnedFunctions.push(returned)
  })
  for (const disposer of returnedFunctions) {
    const cleanup = cleanupMutations(disposer, checker)
    if (cleanup.length === 0) continue
    const ifStatements = []
    directWalk(disposer.body, node => { if (ts.isIfStatement(node)) ifStatements.push(node) })
    for (const statement of ifStatements) {
      const identity = identityPredicate(statement.expression, mutation, checker)
      if (identity === undefined) continue
      const branch = statement.thenStatement
      const allDominated = cleanup.every(item => descendantOf(item.node, branch))
      const allExact = cleanup.every(item => sameSymbol(item.storageSymbol, mutation.storageSymbol)
        && (mutation.kind === 'single-slot'
          ? item.kind === 'clear'
          : item.kind === 'delete' && item.key !== undefined && sameExpression(item.key, mutation.key, checker)))
      if (allDominated && allExact) return { comparison: 'strict-equal', cleanupCount: cleanup.length }
    }
  }
  return undefined
}

function returnedCall(method) {
  if (method.body === undefined) return undefined
  for (const statement of method.body.statements) {
    if (!ts.isReturnStatement(statement) || statement.expression === undefined) continue
    const value = unwrap(statement.expression)
    if (ts.isCallExpression(value)) return value
  }
  return undefined
}

function returnedFunction(method) {
  if (method.body === undefined) return false
  return method.body.statements.some(statement => {
    if (!ts.isReturnStatement(statement) || statement.expression === undefined) return false
    const value = unwrap(statement.expression)
    return ts.isArrowFunction(value) || ts.isFunctionExpression(value)
  })
}


function capabilitiesOf(expression, context) {
  const object = unwrap(expression)
  if (!ts.isObjectLiteralExpression(object)) return null
  const property = object.properties.find(item => ts.isPropertyAssignment(item) && propertyName(item.name) === 'capabilities')
  if (property === undefined || !ts.isPropertyAssignment(property)) return null
  const value = unwrap(property.initializer)
  if (ts.isCallExpression(value)) {
    const argument = unwrap(value.arguments[0])
    const evaluated = staticValue(argument, context)
    if (evaluated !== undefined) return evaluated
    if (ts.isObjectLiteralExpression(argument)) return Object.fromEntries(argument.properties.flatMap(item => {
      if (!ts.isPropertyAssignment(item)) return []
      const name = propertyName(item.name)
      if (name === undefined) return []
      return [[name, staticValue(item.initializer, context) ?? { expression: item.initializer.getText(item.getSourceFile()) }]]
    }))
    return argument?.getText(value.getSourceFile()) ?? null
  }
  return staticValue(value, context) ?? value.getText(value.getSourceFile())
}

function returnedArray(call, context) {
  const callee = unwrap(call.expression)
  if (!ts.isIdentifier(callee)) return undefined
  const symbol = symbolOf(callee, context.checker)
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.find(ts.isFunctionDeclaration)
  if (declaration === undefined || !ts.isFunctionDeclaration(declaration) || declaration.body === undefined || declaration.parameters.length !== 0) return undefined
  const returned = declaration.body.statements.find(ts.isReturnStatement)
  const expression = returned?.expression === undefined ? undefined : unwrap(returned.expression)
  return ts.isArrayLiteralExpression(expression) ? expression : undefined
}

function builtinSets(constructor, storageSymbol, context) {
  if (constructor?.body === undefined) return []
  const entries = []
  const walk = (node) => {
    const call = callShape(node)
    if (call?.receiver !== undefined && sameSymbol(thisPropertySymbol(call.receiver, context.checker), storageSymbol) && call.method === 'set') {
      const identity = staticValue(call.arguments[0], context)
      if (typeof identity === 'string') {
        entries.push({
          name: identity,
          valueExpression: call.arguments[1]?.getText(node.getSourceFile()) ?? null,
          capabilities: call.arguments[1] === undefined ? null : staticValue(call.arguments[1], context) ?? capabilitiesOf(call.arguments[1], context),
          anchor: anchor(node.getSourceFile(), node),
        })
      }
    }
    if (ts.isForOfStatement(node) && ts.isCallExpression(unwrap(node.expression))) {
      const array = returnedArray(unwrap(node.expression), context)
      const loopName = ts.isVariableDeclarationList(node.initializer)
        && node.initializer.declarations.length === 1 && ts.isIdentifier(node.initializer.declarations[0].name)
        ? node.initializer.declarations[0].name.text : undefined
      if (array !== undefined && loopName !== undefined) {
        const bodyCalls = []
        const inspect = child => { if (ts.isCallExpression(child)) bodyCalls.push(child); ts.forEachChild(child, inspect) }
        inspect(node.statement)
        if (bodyCalls.some(item => {
          const shape = callShape(item)
          if (shape?.receiver === undefined || !sameSymbol(thisPropertySymbol(shape.receiver, context.checker), storageSymbol)
            || shape.method !== 'set' || shape.arguments[0] === undefined || !ts.isPropertyAccessExpression(unwrap(shape.arguments[0]))) return false
          const key = unwrap(shape.arguments[0])
          return ts.isIdentifier(key.expression) && key.expression.text === loopName && key.name.text === 'name'
        })) {
          for (const element of array.elements) {
            const object = unwrap(element)
            if (!ts.isObjectLiteralExpression(object)) continue
            const property = object.properties.find(item => ts.isPropertyAssignment(item) && propertyName(item.name) === 'name')
            if (property === undefined || !ts.isPropertyAssignment(property)) continue
            const name = staticValue(property.initializer, context)
            if (typeof name !== 'string') continue
            entries.push({ name, valueExpression: `${loopName} (from ${unwrap(node.expression).expression.getText()})`, capabilities: null, anchor: anchor(element.getSourceFile(), element) })
          }
        }
      }
    }
    ts.forEachChild(node, walk)
  }
  walk(constructor.body)
  return entries
}

function referencesSymbols(node, symbols, checker) {
  let found = false
  const walk = child => {
    if (found) return
    const symbol = nodeSymbol(child, checker)
    if (symbol !== undefined && [...symbols].some(candidate => sameSymbol(candidate, symbol))) { found = true; return }
    ts.forEachChild(child, walk)
  }
  walk(node)
  return found
}

function identityExpression(node, aliases, checker) {
  const value = unwrap(node)
  if (ts.isIdentifier(value)) return [...aliases].some(alias => sameSymbol(symbolOf(value, checker), alias))
  if (ts.isPropertyAccessExpression(value)) return identityExpression(value.expression, aliases, checker)
  if (ts.isCallExpression(value)) {
    const call = callBinding(value, checker)
    return call?.method === 'trim' && call.receiver !== undefined && identityExpression(call.receiver, aliases, checker)
      && call.symbol?.declarations?.some(declaration => /\/typescript\/lib\/lib\.[^/]+\.d\.ts$/u.test(slash(declaration.getSourceFile().fileName)))
  }
  return false
}

function invalidIdentityPredicate(condition, aliases, checker) {
  const node = unwrap(condition)
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    const left = invalidIdentityPredicate(node.left, aliases, checker)
    const right = invalidIdentityPredicate(node.right, aliases, checker)
    return left !== undefined && right !== undefined ? [...left, ...right] : undefined
  }
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    const call = callBinding(unwrap(node.operand), checker)
    if (call?.method === 'test' && call.arguments.length === 1 && identityExpression(call.arguments[0], aliases, checker)
      && call.symbol?.declarations?.some(declaration => /\/typescript\/lib\/lib\.[^/]+\.d\.ts$/u.test(slash(declaration.getSourceFile().fileName)))) return ['validator-failure']
    return undefined
  }
  if (!ts.isBinaryExpression(node)
    || ![ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.operatorToken.kind)) return undefined
  const candidates = [[unwrap(node.left), unwrap(node.right)], [unwrap(node.right), unwrap(node.left)]]
  for (const [candidate, expected] of candidates) {
    const value = literal(expected)
    if (value === '' && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
      && identityExpression(candidate, aliases, checker)) return ['reject-empty']
    if (typeof value === 'string' && node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
      && ts.isPropertyAccessExpression(candidate) && candidate.name.text === 'kind'
      && identityExpression(candidate.expression, aliases, checker)) return [`kind:${value}`]
  }
  return undefined
}

function directCall(statement) {
  if (ts.isExpressionStatement(statement)) return ts.isCallExpression(unwrap(statement.expression)) ? unwrap(statement.expression) : undefined
  if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
    const initializer = unwrap(statement.declarationList.declarations[0].initializer)
    return initializer !== undefined && ts.isCallExpression(initializer) ? initializer : undefined
  }
  return undefined
}

function proveValidatorCall(callNode, outerAliases, checker, seen = new Set()) {
  const call = callBinding(callNode, checker)
  const symbolKey = stableSymbol(call?.symbol)
  if (call === undefined || symbolKey === undefined || seen.has(symbolKey)) return false
  const declaration = call.symbol?.declarations?.find(item => (ts.isFunctionDeclaration(item) || ts.isMethodDeclaration(item))
    && item.body !== undefined && !item.getSourceFile().isDeclarationFile)
  if (declaration === undefined || declaration.body === undefined) return false
  const aliases = new Set()
  for (let index = 0; index < Math.min(call.arguments.length, declaration.parameters.length); index += 1) {
    const parameter = declaration.parameters[index]
    if (ts.isIdentifier(parameter.name) && identityExpression(call.arguments[index], outerAliases, checker)) {
      const symbol = symbolOf(parameter.name, checker)
      if (symbol !== undefined) aliases.add(symbol)
    }
  }
  if (aliases.size === 0) return false
  const nextSeen = new Set(seen); nextSeen.add(symbolKey)
  for (const statement of declaration.body.statements) {
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return false
    if (ts.isVariableStatement(statement)) for (const item of statement.declarationList.declarations) {
      if (ts.isIdentifier(item.name) && item.initializer !== undefined && identityExpression(item.initializer, aliases, checker)) {
        const symbol = symbolOf(item.name, checker)
        if (symbol !== undefined) aliases.add(symbol)
      }
    }
    if (ts.isIfStatement(statement)) {
      const rules = invalidIdentityPredicate(statement.expression, aliases, checker)
      if (rules !== undefined && directThrowBranch(statement.thenStatement)) return true
    }
    const nested = directCall(statement)
    if (nested !== undefined && proveValidatorCall(nested, aliases, checker, nextSeen)) return true
  }
  return false
}

function extensionGrammar(method, identityParameter, mutation, checker) {
  if (method.body === undefined || identityParameter === undefined || !ts.isIdentifier(identityParameter.name)) return []
  const mutationStatement = directStatement(mutation.node, method.body)
  if (mutationStatement === undefined) return []
  const rules = []
  const aliases = new Set([symbolOf(identityParameter.name, checker)].filter(Boolean))
  const mutationIndex = method.body.statements.indexOf(mutationStatement)
  for (const statement of method.body.statements.slice(0, mutationIndex)) {
    if (ts.isVariableStatement(statement)) for (const item of statement.declarationList.declarations) {
      if (ts.isIdentifier(item.name) && item.initializer !== undefined && identityExpression(item.initializer, aliases, checker)) {
        const symbol = symbolOf(item.name, checker)
        if (symbol !== undefined) aliases.add(symbol)
      }
    }
    if (ts.isIfStatement(statement)) {
      const proof = invalidIdentityPredicate(statement.expression, aliases, checker)
      if (proof !== undefined && directThrowBranch(statement.thenStatement)) rules.push(...proof)
    }
    const validator = directCall(statement)
    if (validator !== undefined && proveValidatorCall(validator, aliases, checker)) {
      const symbol = callBinding(validator, checker)?.symbol
      if (symbol !== undefined) rules.push(`validator:${stableSymbol(symbol)}`)
    }
  }
  return [...new Set(rules)].sort(compareText)
}

function referencesKnownLocal(node, locals, checker) {
  let found = false
  directWalk(node, child => {
    if (ts.isIdentifier(child) && [...locals].some(symbol => sameSymbol(symbolOf(child, checker), symbol))) found = true
  })
  return found
}

function typescriptLibSymbol(symbol) {
  return symbol?.declarations?.length > 0 && symbol.declarations.every(declaration => (
    /\/typescript\/lib\/lib\.[^/]+\.d\.ts$/u.test(slash(declaration.getSourceFile().fileName))
  ))
}

function sameStorageReference(node, storageAliases, mutation, checker) {
  const value = unwrap(node)
  if (sameSymbol(thisPropertySymbol(value, checker), mutation.storageSymbol)) return true
  const symbol = nodeSymbol(value, checker)
  return symbol !== undefined && [...storageAliases].some(alias => sameSymbol(symbol, alias))
}

function sameLocalContainerReference(node, containers, checker) {
  const symbol = nodeSymbol(unwrap(node), checker)
  return symbol !== undefined && [...containers].some(container => sameSymbol(symbol, container))
}

function optionalInputGuard(condition, optionalInputs, checker) {
  const value = unwrap(condition)
  if (!ts.isBinaryExpression(value)
    || ![ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(value.operatorToken.kind)) return false
  for (const [candidate, expected] of [[unwrap(value.left), unwrap(value.right)], [unwrap(value.right), unwrap(value.left)]]) {
    if (!isUndefined(expected) || !ts.isIdentifier(candidate)) continue
    const symbol = symbolOf(candidate, checker)
    if (symbol !== undefined && [...optionalInputs].some(input => sameSymbol(symbol, input))) {
      return value.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
    }
  }
  return false
}

const LOCAL_STANDARD_CALLS = new Set(['freeze'])
const LOCAL_STANDARD_CONSTRUCTORS = new Set(['Array', 'Map', 'Set', 'WeakMap', 'WeakSet'])
const STORAGE_MUTATORS = new Set(['add', 'clear', 'copyWithin', 'delete', 'fill', 'pop', 'push', 'reverse', 'set', 'shift', 'sort', 'splice', 'unshift'])

function isAssignmentOperator(kind) {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment
}

function isUpdateOperator(kind) {
  return kind === ts.SyntaxKind.PlusPlusToken || kind === ts.SyntaxKind.MinusMinusToken
}

function locallySafeExpression(node, locals, storageAliases, localContainers, mutation, checker) {
  const value = unwrap(node)
  if (value === undefined) return true
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value) || ts.isClassExpression(value)) return false
  if (ts.isCallExpression(value)) {
    const shape = callShape(value)
    const binding = callBinding(value, checker)
    if (shape?.receiver !== undefined && STORAGE_MUTATORS.has(shape.method)) {
      if (sameStorageReference(shape.receiver, storageAliases, mutation, checker)) return false
      if (sameLocalContainerReference(shape.receiver, localContainers, checker) && typescriptLibSymbol(binding?.symbol)) {
        return value.arguments.every(argument => locallySafeExpression(argument, locals, storageAliases, localContainers, mutation, checker))
      }
    }
    const knownStandard = LOCAL_STANDARD_CALLS.has(binding?.method) && typescriptLibSymbol(binding?.symbol)
    if (!knownStandard && !proveValidatorCall(value, locals, checker)) return false
    return value.arguments.every(argument => locallySafeExpression(argument, locals, storageAliases, localContainers, mutation, checker))
      && locallySafeExpression(value.expression, locals, storageAliases, localContainers, mutation, checker)
  }
  if (ts.isNewExpression(value)) {
    const constructor = symbolOf(value.expression, checker)
    if (!LOCAL_STANDARD_CONSTRUCTORS.has(constructor?.name) || !typescriptLibSymbol(constructor)) return false
    return (value.arguments ?? []).every(argument => locallySafeExpression(argument, locals, storageAliases, localContainers, mutation, checker))
  }
  if (ts.isBinaryExpression(value) && isAssignmentOperator(value.operatorToken.kind)) {
    const target = nodeSymbol(value.left, checker)
    if (sameStorageReference(value.left, storageAliases, mutation, checker)
      || sameLocalContainerReference(value.left, localContainers, checker)
      || target === undefined || ![...locals].some(symbol => sameSymbol(target, symbol))) return false
    return locallySafeExpression(value.right, locals, storageAliases, localContainers, mutation, checker)
  }
  if ((ts.isPrefixUnaryExpression(value) || ts.isPostfixUnaryExpression(value)) && isUpdateOperator(value.operator)) {
    const target = nodeSymbol(value.operand, checker)
    if (sameStorageReference(value.operand, storageAliases, mutation, checker)
      || sameLocalContainerReference(value.operand, localContainers, checker)) return false
    return target !== undefined && [...locals].some(symbol => sameSymbol(target, symbol))
  }
  let safe = true
  ts.forEachChild(value, child => { if (safe && !locallySafeExpression(child, locals, storageAliases, localContainers, mutation, checker)) safe = false })
  return safe
}

function localPreparationStatement(statement, locals, storageAliases, localContainers, optionalInputs, mutation, checker, validationContext = false) {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)
    || ts.isBreakStatement(statement) || ts.isContinueStatement(statement)) return false
  if (ts.isBlock(statement)) return statement.statements.every(item => localPreparationStatement(
    item, locals, storageAliases, localContainers, optionalInputs, mutation, checker, validationContext,
  ))
  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)
        || !locallySafeExpression(declaration.initializer, locals, storageAliases, localContainers, mutation, checker)) return false
      const symbol = symbolOf(declaration.name, checker)
      if (symbol === undefined) return false
      if (declaration.initializer !== undefined
        && sameStorageReference(declaration.initializer, storageAliases, mutation, checker)) storageAliases.add(symbol)
      const initializer = unwrap(declaration.initializer)
      if (initializer !== undefined && ts.isNewExpression(initializer)) {
        const constructor = symbolOf(initializer.expression, checker)
        if (LOCAL_STANDARD_CONSTRUCTORS.has(constructor?.name) && typescriptLibSymbol(constructor)) localContainers.add(symbol)
      } else if (initializer !== undefined && sameLocalContainerReference(initializer, localContainers, checker)) localContainers.add(symbol)
      locals.add(symbol)
    }
    return true
  }
  if (ts.isExpressionStatement(statement)) return locallySafeExpression(statement.expression, locals, storageAliases, localContainers, mutation, checker)
  if (ts.isIfStatement(statement)) {
    if (!locallySafeExpression(statement.expression, locals, storageAliases, localContainers, mutation, checker)) return false
    if (validationContext && statement.elseStatement === undefined && directThrowBranch(statement.thenStatement)
      && referencesKnownLocal(statement.expression, locals, checker)) return true
    const nestedValidation = validationContext || (statement.elseStatement === undefined
      && optionalInputGuard(statement.expression, optionalInputs, checker))
    const branchLocals = new Set(locals)
    const branchStorageAliases = new Set(storageAliases)
    const branchContainers = new Set(localContainers)
    if (!localPreparationStatement(statement.thenStatement, branchLocals, branchStorageAliases, branchContainers, optionalInputs, mutation, checker, nestedValidation)) return false
    if (statement.elseStatement !== undefined
      && !localPreparationStatement(statement.elseStatement, new Set(locals), new Set(storageAliases), new Set(localContainers), optionalInputs, mutation, checker, validationContext)) return false
    return true
  }
  if (ts.isForOfStatement(statement)) {
    if (!validationContext || !locallySafeExpression(statement.expression, locals, storageAliases, localContainers, mutation, checker)) return false
    const loopLocals = new Set(locals)
    const loopStorageAliases = new Set(storageAliases)
    const loopContainers = new Set(localContainers)
    if (ts.isVariableDeclarationList(statement.initializer)) {
      for (const declaration of statement.initializer.declarations) {
        if (!ts.isIdentifier(declaration.name)) return false
        const symbol = symbolOf(declaration.name, checker)
        if (symbol === undefined) return false
        loopLocals.add(symbol)
      }
    } else if (!locallySafeExpression(statement.initializer, loopLocals, loopStorageAliases, loopContainers, mutation, checker)) return false
    return localPreparationStatement(statement.statement, loopLocals, loopStorageAliases, loopContainers, optionalInputs, mutation, checker, true)
  }
  return ts.isEmptyStatement(statement)
}

function strictMutationSpine(method, identityParameter, mutation, checker) {
  if (method.body === undefined || identityParameter === undefined || !ts.isIdentifier(identityParameter.name)) return false
  const mutationStatement = directStatement(mutation.node, method.body)
  if (mutationStatement === undefined) return false
  const mutationIndex = method.body.statements.indexOf(mutationStatement)
  const initial = symbolOf(identityParameter.name, checker)
  if (initial === undefined) return false
  const aliases = new Set([initial])
  const locals = new Set(aliases)
  const storageAliases = new Set()
  const localContainers = new Set()
  const optionalInputs = new Set(method.parameters.slice(1).flatMap(parameter => (
    ts.isIdentifier(parameter.name) ? [symbolOf(parameter.name, checker)] : []
  )).filter(Boolean))
  for (const statement of method.body.statements.slice(0, mutationIndex)) {
    if (ts.isVariableStatement(statement)) {
      let aliasesOnly = statement.declarationList.declarations.length > 0
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined
          || !identityExpression(declaration.initializer, aliases, checker)) {
          aliasesOnly = false
          break
        }
        const symbol = symbolOf(declaration.name, checker)
        if (symbol === undefined) return false
        aliases.add(symbol)
        locals.add(symbol)
      }
      if (aliasesOnly) continue
      const validator = directCall(statement)
      if (validator !== undefined && proveValidatorCall(validator, aliases, checker)) continue
      if (localPreparationStatement(statement, locals, storageAliases, localContainers, optionalInputs, mutation, checker)) continue
      return false
    }
    if (ts.isIfStatement(statement)) {
      // A canonical guard has exactly one rejecting throw branch. An else
      // branch can hide a second terminal/control path, so it is never part
      // of the registration spine.
      if (statement.elseStatement === undefined && directThrowBranch(statement.thenStatement)) {
        const duplicate = predicateProof(statement.expression, mutation, checker)
        if (duplicate?.duplicateOnTrue === true) continue
        if (invalidIdentityPredicate(statement.expression, aliases, checker) !== undefined) continue
      }
      if (localPreparationStatement(statement, locals, storageAliases, localContainers, optionalInputs, mutation, checker)) continue
      return false
    }
    const validator = directCall(statement)
    if (validator !== undefined && proveValidatorCall(validator, aliases, checker)) continue
    if (localPreparationStatement(statement, locals, storageAliases, localContainers, optionalInputs, mutation, checker)) continue
    return false
  }
  return true
}

function extractClassRegistries(record, classNode, context, diagnostics) {
  const declared = new Map()
  const declaredBySymbol = new Map()
  for (const member of classNode.members) {
    if (!ts.isPropertyDeclaration(member)) continue
    const name = propertyName(member.name)
    if (name === undefined) continue
    const symbol = symbolOf(member.name, context.checker)
    const symbolId = stableSymbol(symbol)
    if (symbol === undefined || symbolId === undefined) continue
    const initializer = unwrap(member.initializer)
    let kind = 'single-slot'
    if (initializer !== undefined && ts.isNewExpression(initializer)) {
      const constructorSymbol = symbolOf(initializer.expression, context.checker)
      if (constructorSymbol?.declarations?.some(declaration => /lib\.es.*collection\.d\.ts$/u.test(slash(declaration.getSourceFile().fileName)))) kind = 'map'
    }
    const entry = { member, kind, name, symbol, symbolId }
    declared.set(name, entry)
    declaredBySymbol.set(symbolId, entry)
  }
  const constructor = classNode.members.find(ts.isConstructorDeclaration)
  const registrations = []
  const facades = []
  for (const member of classNode.members) {
    if (!ts.isMethodDeclaration(member)) continue
    const method = propertyName(member.name)
    if (method === undefined) continue
    const mutation = initialMutation(member, declaredBySymbol, context.checker)
    if (mutation === undefined) {
      const target = returnedCall(member)
      const targetShape = target === undefined ? undefined : callBinding(target, context.checker)
      if (targetShape !== undefined && targetShape.receiver !== undefined && targetShape.symbol !== undefined) {
        const targetSymbol = targetShape.symbol
        const targetDeclaration = targetSymbol?.valueDeclaration ?? targetSymbol?.declarations?.[0]
        facades.push({
          method, targetReceiver: targetShape.receiver.getText(record.sourceFile), targetMethod: targetShape.method,
          targetSymbol: targetSymbol?.name ?? null,
          targetFile: targetDeclaration === undefined ? null : context.recordBySourceFile.get(targetDeclaration.getSourceFile())?.path ?? slash(targetDeclaration.getSourceFile().fileName),
          _methodKey: stableSymbol(symbolOf(member.name, context.checker)),
          _targetKey: stableSymbol(targetSymbol),
          file: record.path, containingSymbol: className(classNode), anchor: anchor(record.sourceFile, member),
        })
      } else if (DIAGNOSTIC_REGISTER_NAME.test(method) && returnedFunction(member)) {
        diagnostics.push(makeDiagnostic(
          'KG_EXTRACT_REGISTRY_MUTATION_UNPROVEN', 'error', record.path, method,
          'registration mutation is not one reachable top-level direct storage mutation before its disposer return',
        ))
      }
      continue
    }
    if (!returnedFunction(member)) continue
    const declaration = declaredBySymbol.get(stableSymbol(mutation.storageSymbol))
    const storage = declaration.name
    const identityParameter = member.parameters[0]
    const duplicateProof = proveDuplicateGuard(member, mutation, context.checker)
    const disposerProof = proveIdentityDisposer(member, mutation, context.checker)
    const grammar = extensionGrammar(member, identityParameter, mutation, context.checker)
    const mutationSpine = strictMutationSpine(member, identityParameter, mutation, context.checker)
    if (!mutationSpine || duplicateProof === undefined || disposerProof === undefined || grammar.length === 0) {
      if (DIAGNOSTIC_REGISTER_NAME.test(method)) {
        if (!mutationSpine) diagnostics.push(makeDiagnostic('KG_EXTRACT_REGISTRY_MUTATION_UNPROVEN', 'error', record.path, method, `${storage} registration has a non-canonical statement before its direct mutation`))
        if (duplicateProof === undefined) diagnostics.push(makeDiagnostic('KG_EXTRACT_REGISTRY_DUPLICATE_RULE_MISSING', 'error', record.path, method, `${storage} registration lacks a dominating same-storage/same-key rejection before mutation`))
        if (disposerProof === undefined) diagnostics.push(makeDiagnostic('KG_EXTRACT_REGISTRY_DISPOSER_MISSING', 'error', record.path, method, `${storage} registration lacks a same-storage/key/value identity branch dominating cleanup`))
        if (grammar.length === 0) diagnostics.push(makeDiagnostic('KG_EXTRACT_REGISTRY_NAME_BOUND_MISSING', 'error', record.path, method, `${storage} dynamic extension has no symbol-bound name/identity validation rule`))
      }
      continue
    }
    registrations.push({
      method, storage,
      identityParameter: identityParameter?.name.getText(record.sourceFile) ?? null,
      valueExpression: mutation.value.getText(record.sourceFile),
      keyIdentity: mutation.key === undefined ? null : factExpression(mutation.key, context),
      valueIdentity: factExpression(mutation.value, context),
      boundedNameRules: grammar,
      duplicateRule: duplicateProof === undefined ? 'missing' : `dominating-${duplicateProof.predicate}-reject`,
      disposer: disposerProof === undefined ? 'missing' : `identity-guarded:${disposerProof.comparison}`,
      _methodKey: stableSymbol(symbolOf(member.name, context.checker)),
      file: record.path,
      containingSymbol: className(classNode), anchor: anchor(record.sourceFile, member),
    })
  }
  const byStorage = new Map(registrations.map(item => [item.storage, item]))
  const registries = []
  for (const [storage, registration] of byStorage) {
    const declaration = declared.get(storage)
    registries.push({
      id: `${record.path}#${className(classNode)}.${storage}`,
      kind: declaration.kind,
      file: record.path,
      containingSymbol: className(classNode),
      storage,
      registrationMethod: registration.method,
      builtins: declaration.kind === 'map' ? builtinSets(constructor, declaration.symbol, context) : [],
      anchor: anchor(record.sourceFile, declaration.member),
    })
  }
  return { registries, registrations, facades }
}

function extractExternalRegistryUses(sourceRecords, context) {
  const result = []
  const officialPackages = ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-subagent', '@deepseek-ai/dsh-skill', '@deepseek-ai/dsh-llm']
  for (const record of sourceRecords) visit(record.sourceFile, node => {
    const call = callBinding(node, context.checker)
    if (call?.receiver === undefined || !['get', 'register', 'list', 'spawn', 'startContinuable'].includes(call.method)) return
    if (!officialPackages.some(packageName => symbolComesFrom(call.symbol, packageName))) return
    result.push({ receiver: call.receiver.getText(record.sourceFile), method: call.method, declarationFiles: call.declarationFiles, file: record.path, containingSymbol: containingSymbol(node), anchor: anchor(record.sourceFile, node) })
  })
  return stableSort(result, (left, right) => compareText(left.receiver, right.receiver) || compareText(left.method, right.method))
}

function serviceDefinitions(sourceRecords, context, diagnostics) {
  const result = []
  for (const record of sourceRecords) for (const statement of record.sourceFile.statements) {
    if (!ts.isClassDeclaration(statement) || statement.heritageClauses === undefined) continue
    const base = statement.heritageClauses.flatMap(clause => clause.types).find(type => {
      const symbol = symbolOf(type.expression, context.checker)
      return symbolComesFrom(symbol, '@deepseek-ai/cordis')
    })
    if (base === undefined) continue
    const constructor = statement.members.find(ts.isConstructorDeclaration)
    let serviceName
    if (constructor?.body !== undefined) {
      const superCall = constructor.body.statements.flatMap(item => ts.isExpressionStatement(item) && ts.isCallExpression(item.expression)
        && item.expression.expression.kind === ts.SyntaxKind.SuperKeyword ? [item.expression] : [])[0]
      if (superCall !== undefined) serviceName = staticValue(superCall.arguments[1], context)
    }
    if (typeof serviceName !== 'string') diagnostics.push(makeDiagnostic('KG_EXTRACT_SERVICE_ID_DYNAMIC', 'error', record.path, className(statement), 'Cordis Service identity is not a static string'))
    result.push({
      classSymbol: className(statement), serviceName: typeof serviceName === 'string' ? serviceName : null,
      baseSymbol: base.expression.getText(record.sourceFile), file: record.path, anchor: anchor(record.sourceFile, statement),
    })
  }
  return stableSort(result, (left, right) => compareText(left.classSymbol, right.classSymbol))
}

export function extractRegistryFacts(sourceRecords, context, diagnostics) {
  const registries = []
  const registryExtensions = []
  const registryFacades = []
  for (const record of sourceRecords) {
    for (const statement of record.sourceFile.statements) {
      if (!ts.isClassDeclaration(statement)) continue
      const facts = extractClassRegistries(record, statement, context, diagnostics)
      registries.push(...facts.registries)
      registryExtensions.push(...facts.registrations)
      registryFacades.push(...facts.facades)
    }
  }
  const provenKeys = new Set(registryExtensions.map(item => item._methodKey).filter(Boolean))
  const closedFacades = []
  let changed = true
  while (changed) {
    changed = false
    for (const facade of registryFacades) {
      if (closedFacades.includes(facade) || !provenKeys.has(facade._targetKey)) continue
      closedFacades.push(facade)
      if (facade._methodKey !== undefined && !provenKeys.has(facade._methodKey)) { provenKeys.add(facade._methodKey); changed = true }
    }
  }
  const publicFact = ({ _methodKey: _method, _targetKey: _target, ...fact }) => fact
  const sort = items => stableSort(items, (left, right) => compareText(left.id ?? left.method, right.id ?? right.method))
  return {
    registries: sort(registries),
    registryExtensions: sort(registryExtensions.map(publicFact)),
    registryFacades: sort(closedFacades.map(publicFact)),
    externalRegistryUses: extractExternalRegistryUses(sourceRecords, context),
    serviceDefinitions: serviceDefinitions(sourceRecords, context, diagnostics),
  }
}
