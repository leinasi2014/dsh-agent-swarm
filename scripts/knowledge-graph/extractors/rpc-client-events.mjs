import ts from 'typescript'
import {
  anchor, callBinding, callShape, compareText, containingSymbol, declarationKey, literal, literalUnion,
  makeDiagnostic, propertyName, stableSort, staticValue, symbolComesFrom, symbolOf, unwrap, visit,
} from './ast.mjs'

function exported(node) {
  return node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false
}

function constDeclarations(sourceRecords) {
  const result = []
  for (const record of sourceRecords) for (const statement of record.sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) result.push({ record, statement, declaration })
    }
  }
  return result
}

function rpcConstants(sourceRecords, context) {
  return constDeclarations(sourceRecords).flatMap(({ record, statement, declaration }) => {
    const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
    if (!record.path.startsWith('src/rpc/') || !exported(statement) || !isConst) return []
    const value = staticValue(declaration.initializer, context)
    if (value === undefined) return []
    return [{ symbol: declaration.name.text, value, static: true, exported: true, file: record.path, anchor: anchor(record.sourceFile, declaration) }]
  }).sort((left, right) => compareText(left.symbol, right.symbol))
}

function exportedLiteralUnions(sourceRecords) {
  return sourceRecords.flatMap(record => record.path.startsWith('src/rpc/') ? record.sourceFile.statements.flatMap(statement => {
    if (!ts.isTypeAliasDeclaration(statement) || !exported(statement)) return []
    const values = literalUnion(statement.type)
    return values.length === 0 ? [] : [{ symbol: statement.name.text, values, file: record.path, anchor: anchor(record.sourceFile, statement), node: statement }]
  }) : []).sort((left, right) => compareText(left.symbol, right.symbol))
}

function contractLiteralValues(sourceRecords, field) {
  const values = []
  for (const record of sourceRecords) {
    if (!record.path.startsWith('src/rpc/')) continue
    for (const statement of record.sourceFile.statements) {
      if (!ts.isInterfaceDeclaration(statement) || !exported(statement)) continue
      for (const member of statement.members) {
        if (!ts.isPropertySignature(member) || propertyName(member.name) !== field || member.type === undefined) continue
        for (const value of literalUnion(member.type)) if (!values.includes(value)) values.push(value)
      }
    }
  }
  return values.sort(compareText)
}

function structurallyLinkedUnions(sourceRecords, context) {
  const unions = exportedLiteralUnions(sourceRecords)
  const methodValues = contractLiteralValues(sourceRecords, 'method')
  const methods = unions.find(item => JSON.stringify([...item.values].sort(compareText)) === JSON.stringify(methodValues))
  let pageKinds
  for (const record of sourceRecords) visit(record.sourceFile, node => {
    if (pageKinds !== undefined || !ts.isPropertySignature(node) || propertyName(node.name) !== 'kind' || node.type === undefined) return
    const symbol = ts.isTypeReferenceNode(node.type)
      ? symbolOf(node.type.typeName, context.checker)
      : symbolOf(node.type, context.checker) ?? context.checker.getTypeAtLocation(node.type).aliasSymbol
    pageKinds = unions.find(item => sameSymbol(symbolOf(item.node.name, context.checker), symbol))
  })
  const empty = { symbol: null, values: [], file: null, anchor: null }
  return { literalUnions: unions.map(({ node: _node, ...item }) => item), methods: methods === undefined ? empty : (({ node: _node, ...item }) => item)(methods), pageKinds: pageKinds === undefined ? empty : (({ node: _node, ...item }) => item)(pageKinds) }
}

function rpcSchemas(sourceRecords, context) {
  const result = []
  for (const record of sourceRecords) {
    if (!record.path.startsWith('src/rpc/')) continue
    for (const statement of record.sourceFile.statements) {
      if (ts.isInterfaceDeclaration(statement) && exported(statement)) {
        const fields = statement.members.flatMap(member => {
          if (!ts.isPropertySignature(member)) return []
          const name = propertyName(member.name)
          return name === undefined ? [] : [{ name, optional: member.questionToken !== undefined, type: member.type?.getText(record.sourceFile) ?? '<inferred>' }]
        })
        result.push({ kind: 'typescript-interface', symbol: statement.name.text, fields, file: record.path, anchor: anchor(record.sourceFile, statement) })
      }
      if (ts.isTypeAliasDeclaration(statement) && exported(statement)) {
        result.push({ kind: 'typescript-type-alias', symbol: statement.name.text, fields: [], file: record.path, anchor: anchor(record.sourceFile, statement) })
      }
      if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
        if (!exported(statement) || !ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue
        const value = staticValue(declaration.initializer, context)
        if (value !== undefined && (value === null || typeof value !== 'object')) continue
        result.push({ kind: 'exported-static-artifact', symbol: declaration.name.text, expressionKind: ts.SyntaxKind[unwrap(declaration.initializer).kind], file: record.path, anchor: anchor(record.sourceFile, declaration) })
      }
    }
  }
  return stableSort(result, (left, right) => compareText(left.symbol, right.symbol))
}

function sameSymbol(left, right) {
  const leftKey = declarationKey(left)
  return leftKey !== undefined && leftKey === declarationKey(right)
}

function routeRegisterSymbol(symbol, checker) {
  return symbol?.declarations?.some(declaration => {
    if ((!ts.isMethodSignature(declaration) && !ts.isMethodDeclaration(declaration)) || declaration.parameters[0] === undefined) return false
    const routeType = checker.getTypeAtLocation(declaration.parameters[0])
    const signature = checker.getSignatureFromDeclaration(declaration)
    const disposer = signature === undefined ? undefined : checker.getReturnTypeOfSignature(signature)
    return ['kind', 'path', 'handler'].every(name => routeType.getProperty(name) !== undefined)
      && (disposer?.getCallSignatures().length ?? 0) > 0
  }) ?? false
}

function officialRequestParameter(parameter, checker) {
  const type = checker.getTypeAtLocation(parameter.name)
  return symbolComesFrom(type.getProperty('method'), '@types/node')
}

function sameParameterReference(node, parameterSymbol, checker) {
  const value = unwrap(node)
  return ts.isIdentifier(value) && sameSymbol(symbolOf(value, checker), parameterSymbol)
}

function sameRequestReference(node, requestSymbols, checker) {
  const value = unwrap(node)
  return ts.isIdentifier(value) && [...requestSymbols].some(symbol => sameSymbol(symbolOf(value, checker), symbol))
}

function addTopLevelRequestAliases(statement, requestSymbols, checker) {
  if (!ts.isVariableStatement(statement)
    || (statement.declarationList.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)) === 0) return false
  for (const declaration of statement.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined
      || !sameRequestReference(declaration.initializer, requestSymbols, checker)) return false
    const symbol = symbolOf(declaration.name, checker)
    if (symbol === undefined) return false
    requestSymbols.add(symbol)
  }
  return true
}

function explicitRejection(statement) {
  if (statement === undefined) return false
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return true
  return ts.isBlock(statement) && statement.statements.length > 0 && explicitRejection(statement.statements.at(-1))
}

function requestCall(node, requestSymbols, context) {
  const call = callBinding(node, context.checker)
  return call !== undefined && call.arguments.some(argument => sameRequestReference(argument, requestSymbols, context.checker)) ? call : undefined
}

function uniqueRootRequestCall(expression, requestSymbols, context) {
  let root = unwrap(expression)
  if (ts.isAwaitExpression(root)) root = unwrap(root.expression)
  if (!ts.isCallExpression(root)) return undefined
  const consuming = []
  visit(root, node => {
    if (!ts.isCallExpression(node)) return
    const call = requestCall(node, requestSymbols, context)
    if (call !== undefined) consuming.push(call)
  })
  return consuming.length === 1 && consuming[0].node === root ? consuming[0] : undefined
}

function returnedCallExpression(statement) {
  let expression = ts.isReturnStatement(statement) ? unwrap(statement.expression) : undefined
  if (expression !== undefined && ts.isAwaitExpression(expression)) expression = unwrap(expression.expression)
  return expression !== undefined && ts.isCallExpression(expression) ? expression : undefined
}

function admissionGuard(statement, requestSymbols, context) {
  if (!ts.isIfStatement(statement)) return undefined
  const comparison = unwrap(statement.expression)
  if (!ts.isBinaryExpression(comparison)
    || ![ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(comparison.operatorToken.kind)) return undefined
  const candidates = [[unwrap(comparison.left), unwrap(comparison.right)], [unwrap(comparison.right), unwrap(comparison.left)]]
  for (const [property, expected] of candidates) {
    if (!ts.isPropertyAccessExpression(property) || property.name.text !== 'method'
      || !sameRequestReference(property.expression, requestSymbols, context.checker)
      || !symbolComesFrom(symbolOf(property.name, context.checker), '@types/node')) continue
    const method = literal(expected)
    if (typeof method !== 'string') continue
    const rejection = comparison.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
      ? statement.thenStatement : statement.elseStatement
    if (!explicitRejection(rejection)) continue
    return { method, comparison: ts.tokenToString(comparison.operatorToken.kind), anchor: anchor(statement.getSourceFile(), comparison) }
  }
  return undefined
}

function requestAdmission(functionNode, requestParameter, context) {
  if (functionNode.body === undefined || !ts.isIdentifier(requestParameter.name) || !ts.isBlock(functionNode.body)) return undefined
  const requestSymbol = symbolOf(requestParameter.name, context.checker)
  if (requestSymbol === undefined) return undefined
  const requestSymbols = new Set([requestSymbol])
  for (const statement of functionNode.body.statements) {
    addTopLevelRequestAliases(statement, requestSymbols, context.checker)
    const guard = admissionGuard(statement, requestSymbols, context)
    if (guard !== undefined) return guard
    let dispatchBeforeGuard = false
    visit(statement, node => { if (requestCall(node, requestSymbols, context) !== undefined) dispatchBeforeGuard = true })
    if (dispatchBeforeGuard) return undefined
  }
  return undefined
}

function delegatedWrapperCall(callback, requestSymbol, context) {
  const requestSymbols = new Set([requestSymbol])
  if (!ts.isBlock(callback.body)) {
    const call = uniqueRootRequestCall(callback.body, requestSymbols, context)
    return call === undefined ? undefined : { call, requestSymbols }
  }
  let guardSeen = false
  for (let index = 0; index < callback.body.statements.length; index += 1) {
    const statement = callback.body.statements[index]
    const final = index === callback.body.statements.length - 1
    if (!guardSeen && addTopLevelRequestAliases(statement, requestSymbols, context.checker)) continue
    if (!guardSeen && admissionGuard(statement, requestSymbols, context) !== undefined) {
      guardSeen = true
      continue
    }
    if (final) {
      const returned = returnedCallExpression(statement)
      const call = returned === undefined ? undefined : uniqueRootRequestCall(returned, requestSymbols, context)
      return call === undefined ? undefined : { call, requestSymbols }
    }
    return undefined
  }
  return undefined
}

function declarationIdentity(declaration, context) {
  const record = context.recordBySourceFile.get(declaration.getSourceFile())
  if (record === undefined) return undefined
  return `${record.path}#${containingSymbol(declaration)}.${propertyName(declaration.name) ?? '<callable>'}@${anchor(record.sourceFile, declaration).line}`
}

function handlerTarget(object, context) {
  const handler = object.properties.find(property => (ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)) && propertyName(property.name) === 'handler')
  if (handler === undefined) return undefined
  const callback = ts.isMethodDeclaration(handler) ? handler : unwrap(handler.initializer)
  if ((!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback) && !ts.isMethodDeclaration(callback)) || callback.body === undefined) return undefined
  const requestParameter = callback.parameters.find(parameter => officialRequestParameter(parameter, context.checker))
  if (requestParameter === undefined || !ts.isIdentifier(requestParameter.name)) return undefined
  const requestSymbol = symbolOf(requestParameter.name, context.checker)
  if (requestSymbol === undefined) return undefined
  const inlineAdmission = requestAdmission(callback, requestParameter, context)
  const wrapper = delegatedWrapperCall(callback, requestSymbol, context)
  let target
  if (wrapper !== undefined) {
    const call = wrapper.call
    if (call.arguments[0] !== undefined && sameRequestReference(call.arguments[0], wrapper.requestSymbols, context.checker)) {
      const declaration = call.symbol?.declarations?.find(item => ts.isMethodDeclaration(item) && item.parameters[0] !== undefined
        && officialRequestParameter(item.parameters[0], context.checker) && item.body !== undefined)
      const admission = declaration === undefined ? undefined : requestAdmission(declaration, declaration.parameters[0], context)
      const identity = declaration === undefined ? undefined : declarationIdentity(declaration, context)
      const signature = context.checker.getResolvedSignature(call.node)
      if (declaration !== undefined && admission !== undefined && identity !== undefined && signature !== undefined) {
        target = { kind: 'delegated', identity, signature: context.checker.signatureToString(signature), admission }
      }
    }
  }
  if (target !== undefined) return target
  if (inlineAdmission === undefined) return undefined
  const signature = context.checker.getSignatureFromDeclaration(callback)
  return {
    kind: 'inline',
    identity: `${context.recordBySourceFile.get(callback.getSourceFile())?.path ?? '<outside-source>'}#${containingSymbol(callback)}.<route-handler>@${anchor(callback.getSourceFile(), callback).line}`,
    signature: signature === undefined ? '<unresolved>' : context.checker.signatureToString(signature),
    admission: inlineAdmission,
  }
}

function rpcRoutes(sourceRecords, context, diagnostics, required) {
  const routes = []
  const httpMethods = []
  const fetchTypeSymbols = new Set(sourceRecords.flatMap(record => record.path.startsWith('src/client/') ? record.sourceFile.statements.flatMap(statement => ts.isTypeAliasDeclaration(statement)
    && exported(statement) && ts.isFunctionTypeNode(statement.type) ? [symbolOf(statement.name, context.checker)] : []) : []).filter(Boolean))
  for (const record of sourceRecords) {
    if (!record.path.startsWith('src/rpc/') && record.path !== 'src/client/read-client.ts') continue
    visit(record.sourceFile, node => {
      const call = callBinding(node, context.checker)
      if (call !== undefined && call.arguments[0] !== undefined) {
        const object = unwrap(call.arguments[0])
        if (ts.isObjectLiteralExpression(object)) {
          const fields = Object.fromEntries(object.properties.flatMap(property => {
            if (!ts.isPropertyAssignment(property)) return []
            const name = propertyName(property.name)
            if (name === undefined || !['kind', 'path'].includes(name)) return []
            return [[name, staticValue(property.initializer, context) ?? null]]
          }))
          if (fields.kind !== undefined || fields.path !== undefined) {
            const bound = routeRegisterSymbol(call.symbol, context.checker)
            const handler = handlerTarget(object, context)
            const handlerBound = handler !== undefined
            if (!bound) diagnostics.push(makeDiagnostic('KG_EXTRACT_RPC_ROUTE_WRONG_ORIGIN', 'error', record.path, containingSymbol(node), 'route-shaped call is not bound to a typed exact-route registration with a disposer'))
            if (bound && !handlerBound) diagnostics.push(makeDiagnostic('KG_EXTRACT_RPC_HANDLER_UNBOUND', 'error', record.path, containingSymbol(node), 'RPC route handler has neither a proven official-request target nor an effective inline admission'))
            if (bound) {
              const route = {
                kind: fields.kind ?? null, path: fields.path ?? null, handlerBound,
                handlerTarget: handler === undefined ? null : { kind: handler.kind, identity: handler.identity, signature: handler.signature },
                admission: handler?.admission ?? null,
                file: record.path, containingSymbol: containingSymbol(node), anchor: anchor(record.sourceFile, node),
              }
              routes.push(route)
              if (handler !== undefined) httpMethods.push({
                receiver: 'route-handler', method: handler.admission.method, comparison: handler.admission.comparison,
                routePath: route.path, handlerTargetIdentity: handler.identity,
                file: record.path, containingSymbol: containingSymbol(node), anchor: handler.admission.anchor,
              })
            }
          }
        }
      }
      if (ts.isCallExpression(node) && call !== undefined && call.arguments.length >= 2) {
        const options = unwrap(call.arguments[1])
        if (!ts.isObjectLiteralExpression(options)) return
        const methodProperty = options.properties.find(property => ts.isPropertyAssignment(property) && propertyName(property.name) === 'method')
        if (methodProperty !== undefined && ts.isPropertyAssignment(methodProperty)) {
          const method = staticValue(methodProperty.initializer, context)
          const fetchBoundary = call.symbol?.declarations?.some(declaration => {
            if ((!ts.isParameter(declaration) && !ts.isPropertyDeclaration(declaration)) || declaration.type === undefined) return false
            const type = context.checker.getTypeAtLocation(declaration.type)
            return [...fetchTypeSymbols].some(candidate => sameSymbol(type.aliasSymbol ?? type.symbol, candidate))
          }) ?? false
          const platformFetch = call.method === 'fetch' && call.declarationFiles.some(file => file === 'typescript-lib:lib.dom.d.ts')
          if (typeof method === 'string' && (fetchBoundary || platformFetch)) {
            httpMethods.push({ receiver: 'client-fetch', method, comparison: 'request', routePath: null, handlerTargetIdentity: null, file: record.path, containingSymbol: containingSymbol(node), anchor: anchor(record.sourceFile, node) })
          } else if (typeof method === 'string') {
            diagnostics.push(makeDiagnostic('KG_EXTRACT_RPC_CLIENT_WRONG_ORIGIN', 'error', record.path, containingSymbol(node), 'HTTP-shaped request is not bound to SwarmFetch or platform fetch'))
          }
        }
      }
    })
  }
  if (required && routes.length === 0) diagnostics.push(makeDiagnostic('KG_EXTRACT_RPC_ROUTE_MISSING', 'error', undefined, 'SWARM_READ_RPC_ENDPOINT', 'no static RPC route registration was found'))
  if (required && !routes.some(route => route.kind === 'exact' && typeof route.path === 'string')) diagnostics.push(makeDiagnostic('KG_EXTRACT_RPC_ROUTE_DRIFT', 'error', routes[0]?.file, 'SWARM_READ_RPC_ENDPOINT', 'RPC route is not a static exact path'))
  if (required && !routes.some(route => route.admission?.method === 'POST')) diagnostics.push(makeDiagnostic('KG_EXTRACT_RPC_HTTP_METHOD_DRIFT', 'error', undefined, 'POST', 'route-local RPC POST admission fact is missing'))
  return { routes: stableSort(routes), httpMethods: stableSort(httpMethods, (left, right) => compareText(left.method, right.method)) }
}

function capabilityLists(sourceRecords, context, diagnostics, required) {
  const result = []
  for (const { record, declaration } of constDeclarations(sourceRecords)) {
    const value = staticValue(declaration.initializer, context)
    if (!Array.isArray(value) || !value.every(item => item !== null && typeof item === 'object' && typeof item.capability === 'string')) continue
    result.push({ symbol: declaration.name.text, entries: value, file: record.path, anchor: anchor(record.sourceFile, declaration) })
  }
  if (required && result.length === 0) diagnostics.push(makeDiagnostic('KG_EXTRACT_RPC_CAPABILITY_MISSING', 'error', undefined, undefined, 'no static RPC capability list was found'))
  return stableSort(result, (left, right) => compareText(left.symbol, right.symbol))
}

function pageBounds(sourceRecords, context) {
  return constDeclarations(sourceRecords).flatMap(({ record, declaration }) => {
    if (!record.path.startsWith('src/rpc/') && !record.path.startsWith('src/client/')) return []
    const value = staticValue(declaration.initializer, context)
    return typeof value !== 'number' ? [] : [{ symbol: declaration.name.text, value, file: record.path, anchor: anchor(record.sourceFile, declaration) }]
  }).sort((left, right) => compareText(left.symbol, right.symbol))
}

function runtimeCapabilities(sourceRecords, context, diagnostics) {
  const result = []
  for (const record of sourceRecords) {
    if (!record.path.startsWith('src/rpc/')) continue
    for (const statement of record.sourceFile.statements) {
      if (!ts.isClassDeclaration(statement)) continue
      const ownsOfficialHttpBoundary = statement.members.some(member => ts.isMethodDeclaration(member) && member.parameters.length >= 2
        && member.parameters.slice(0, 2).every(parameter => parameter.type !== undefined
          && symbolComesFrom(symbolOf(parameter.type, context.checker) ?? context.checker.getTypeAtLocation(parameter.type).symbol, '@types/node')))
      if (!ownsOfficialHttpBoundary) continue
      for (const member of statement.members) {
        if (!ts.isMethodDeclaration(member) || member.body === undefined) continue
        const returned = member.body.statements.flatMap(item => ts.isReturnStatement(item) && item.expression !== undefined ? [unwrap(item.expression)] : []).find(ts.isObjectLiteralExpression)
        const capabilityProperty = returned?.properties.find(property => ts.isPropertyAssignment(property) && propertyName(property.name) === 'capabilities')
        if (capabilityProperty === undefined || !ts.isPropertyAssignment(capabilityProperty)) continue
        const values = []
        const collect = node => {
          if (ts.isPropertyAssignment(node) && propertyName(node.name) === 'capability') {
            const value = staticValue(node.initializer, context)
            if (typeof value === 'string' && !values.includes(value)) values.push(value)
          }
          if (ts.isSpreadElement(node) && ts.isIdentifier(node.expression)) {
            const symbol = symbolOf(node.expression, context.checker)
            const declaration = symbol?.valueDeclaration
            const initializer = declaration !== undefined && ts.isVariableDeclaration(declaration) ? unwrap(declaration.initializer) : undefined
            if (ts.isCallExpression(initializer) && ts.isPropertyAccessExpression(initializer.expression)) {
              const source = unwrap(initializer.expression.expression)
              if (ts.isArrayLiteralExpression(source)) for (const element of source.elements) {
                const value = staticValue(element, context)
                if (typeof value === 'string' && !values.includes(value)) values.push(value)
              }
            }
          }
          ts.forEachChild(node, collect)
        }
        collect(capabilityProperty.initializer)
        for (const value of values) if (!/^(?:[a-z]+\.)+(?:read|write|cancel)$/u.test(value)) diagnostics.push(makeDiagnostic('KG_EXTRACT_RPC_CAPABILITY_VALUE_INVALID', 'error', record.path, propertyName(member.name), `invalid capability literal ${JSON.stringify(value)}`))
        result.push({ containingSymbol: statement.name?.text ?? '<anonymous-class>', methodSymbol: propertyName(member.name), values, file: record.path, anchor: anchor(record.sourceFile, member) })
      }
    }
  }
  return stableSort(result)
}

function clientFacts(sourceRecords, context, diagnostics) {
  const entrypoints = []
  const injections = []
  const slots = []
  const settingsNamespaces = []
  const settingsFields = []
  const settingsDocuments = []
  const settingsBindings = []
  const settingsNamespaceSourceFiles = new Set()
  const namespaceSymbols = new Set()
  const settingsDocumentSymbols = new Set()
  const controllerDocumentSymbols = callNode => {
    let current = callNode
    while (current.parent !== undefined && (ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent))) current = current.parent
    const creation = current.parent
    if (!ts.isNewExpression(creation)) return []
    const argumentIndex = creation.arguments?.indexOf(current) ?? -1
    const bindSignature = context.checker.getResolvedSignature(callNode)
    const bindResult = bindSignature === undefined ? undefined : context.checker.getReturnTypeOfSignature(bindSignature)
    const bindOuter = bindResult?.aliasSymbol ?? bindResult?.symbol
    const declaredReturnNode = bindSignature?.declaration?.type
    const declaredReturn = declaredReturnNode === undefined ? undefined : context.checker.getTypeAtLocation(declaredReturnNode)
    const declaredOuter = declaredReturn?.aliasSymbol ?? declaredReturn?.symbol
    const bindArguments = bindResult !== undefined && (bindResult.objectFlags & ts.ObjectFlags.Reference) !== 0
      ? context.checker.getTypeArguments(bindResult) : []
    if (bindOuter === undefined || !sameSymbol(bindOuter, declaredOuter) || bindArguments.length !== 1
      || !ts.isTypeReferenceNode(declaredReturnNode) || declaredReturnNode.typeArguments?.length !== 1) return []
    const signature = context.checker.getResolvedSignature(creation)
    const constructor = signature?.declaration
    const parameter = argumentIndex < 0 ? undefined : constructor?.parameters[argumentIndex]
    if (parameter?.type === undefined) return []
    const parameterType = context.checker.getTypeAtLocation(parameter.type)
    const parameterOuter = parameterType.aliasSymbol ?? parameterType.symbol
    const parameterArguments = (parameterType.objectFlags & ts.ObjectFlags.Reference) !== 0
      ? context.checker.getTypeArguments(parameterType) : []
    if (!sameSymbol(bindOuter, parameterOuter) || parameterArguments.length !== 1) return []
    const bindDocument = bindArguments[0].aliasSymbol ?? bindArguments[0].symbol
    const parameterDocument = parameterArguments[0].aliasSymbol ?? parameterArguments[0].symbol
    if (!sameSymbol(bindDocument, parameterDocument)) return []
    return parameterDocument?.declarations?.some(declaration => context.recordBySourceFile.has(declaration.getSourceFile()))
      ? [parameterDocument] : []
  }
  for (const record of sourceRecords) {
    if (!record.path.startsWith('src/client/')) continue
    visit(record.sourceFile, node => {
      const call = callBinding(node, context.checker)
      if (call?.method !== 'bind' || !symbolComesFrom(call.symbol, '@deepseek-ai/dsh-client-ui-settings')) return
      const object = unwrap(call.arguments[0])
      if (!ts.isObjectLiteralExpression(object)) return
      const namespace = object.properties.find(property => ts.isPropertyAssignment(property) && propertyName(property.name) === 'namespace')
      if (namespace === undefined || !ts.isPropertyAssignment(namespace)) return
      settingsBindings.push({ namespace: staticValue(namespace.initializer, context) ?? null, file: record.path, containingSymbol: containingSymbol(node), anchor: anchor(record.sourceFile, node) })
      const symbol = symbolOf(unwrap(namespace.initializer), context.checker)
      const key = declarationKey(symbol)
      if (key !== undefined) namespaceSymbols.add(key)
      for (const declaration of symbol?.declarations ?? []) {
        const source = context.recordBySourceFile.get(declaration.getSourceFile())
        if (source?.path.startsWith('src/client/')) settingsNamespaceSourceFiles.add(source.path)
      }
      const documents = controllerDocumentSymbols(call.node)
      if (documents.length === 0) diagnostics.push(makeDiagnostic(
        'KG_EXTRACT_CLIENT_SETTINGS_BINDING_UNCLOSED', 'error', record.path, containingSymbol(node),
        'official settings.bind result is not the direct argument of a constructor with the same resolved SettingsScope<Document> identity at generic position 0',
      ))
      for (const document of documents) {
        const key = declarationKey(document)
        if (key !== undefined) settingsDocumentSymbols.add(key)
      }
    })
  }
  for (const record of sourceRecords) {
    if (!record.path.startsWith('src/client/')) continue
    if (record.path.endsWith('/plugin-entry.ts') || record.path.endsWith('/index.ts')) {
      const exports = record.sourceFile.statements.filter(ts.isExportDeclaration).map(statement => ({
        moduleSpecifier: ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : null,
        star: statement.exportClause === undefined,
        anchor: anchor(record.sourceFile, statement),
      }))
      entrypoints.push({ file: record.path, exports })
    }
    for (const statement of record.sourceFile.statements) {
      if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue
        if (declaration.name.text === 'inject' && exported(statement)) {
          const value = staticValue(declaration.initializer, context)
          if (Array.isArray(value) && value.every(item => typeof item === 'string')) injections.push({ services: value, file: record.path, anchor: anchor(record.sourceFile, declaration) })
          else diagnostics.push(makeDiagnostic('KG_EXTRACT_CLIENT_INJECT_DYNAMIC', 'error', record.path, 'inject', 'Client inject declaration is not a static string array'))
        }
        const declarationSymbol = symbolOf(declaration.name, context.checker)
        if (settingsNamespaceSourceFiles.has(record.path) && namespaceSymbols.has(declarationKey(declarationSymbol))) {
          const value = staticValue(declaration.initializer, context)
          settingsNamespaces.push({ symbol: declaration.name.text, value: typeof value === 'string' ? value : null, file: record.path, anchor: anchor(record.sourceFile, declaration) })
        }
      }
      if (ts.isInterfaceDeclaration(statement) && exported(statement)
        && settingsDocumentSymbols.has(declarationKey(symbolOf(statement.name, context.checker)))) {
        settingsDocuments.push({
          symbol: statement.name.text,
          fields: statement.members.flatMap(member => ts.isPropertySignature(member) && propertyName(member.name) !== undefined ? [propertyName(member.name)] : []).sort(compareText),
          file: record.path, anchor: anchor(record.sourceFile, statement),
        })
      }
    }
    visit(record.sourceFile, node => {
      const call = callBinding(node, context.checker)
      if (call === undefined) return
      if (!['inject', 'register'].includes(call.method)) return
      const officialSlot = symbolComesFrom(call.symbol, '@deepseek-ai/dsh-client-runtime')
      const first = unwrap(call.arguments[0])
      const slotShaped = typeof staticValue(first, context) === 'string' || (first !== undefined && ts.isObjectLiteralExpression(first))
      if (!officialSlot) {
        const locallyDeclared = call.symbol?.declarations?.some(declaration => context.recordBySourceFile.has(declaration.getSourceFile())) ?? false
        if (slotShaped && locallyDeclared) diagnostics.push(makeDiagnostic('KG_EXTRACT_CLIENT_SLOT_WRONG_ORIGIN', 'error', record.path, containingSymbol(node), 'locally declared slot-shaped call is not bound to the official Client slots service'))
        return
      }
      const receiver = call.receiver?.getText(record.sourceFile) ?? `<bound:${call.method}>`
      let name = staticValue(call.arguments[0], context)
      let details = null
      if (call.method === 'register') {
        const object = unwrap(call.arguments[0])
        if (ts.isObjectLiteralExpression(object)) {
          details = Object.fromEntries(object.properties.flatMap(property => {
            if (!ts.isPropertyAssignment(property)) return []
            const key = propertyName(property.name)
            if (key === undefined || !['name', 'id', 'key', 'order', 'locale'].includes(key)) return []
            return [[key, staticValue(property.initializer, context) ?? property.initializer.getText(record.sourceFile)]]
          }))
          name = details.name
        }
      }
      if (typeof name !== 'string') diagnostics.push(makeDiagnostic('KG_EXTRACT_CLIENT_SLOT_DYNAMIC', 'error', record.path, containingSymbol(node), `Client slot ${call.method} name is dynamic`))
      slots.push({ operation: call.method, name: typeof name === 'string' ? name : null, details, file: record.path, containingSymbol: containingSymbol(node), anchor: anchor(record.sourceFile, node) })
    })
  }
  for (const record of sourceRecords) {
    if (!record.path.startsWith('src/client/')) continue
    for (const statement of record.sourceFile.statements) {
      if (!ts.isTypeAliasDeclaration(statement) || !exported(statement)) continue
      const values = literalUnion(statement.type)
      if (values.length === 0) continue
      const declared = [...values].sort(compareText)
      const document = settingsDocuments.find(item => item.file === record.path && JSON.stringify(item.fields) === JSON.stringify(declared))
      if (document !== undefined) settingsFields.push({
        symbol: statement.name.text, values, documentSymbol: document.symbol,
        file: record.path, anchor: anchor(record.sourceFile, statement),
      })
    }
  }
  for (const document of settingsDocuments) if (!settingsFields.some(field => field.documentSymbol === document.symbol && field.file === document.file)) {
    diagnostics.push(makeDiagnostic('KG_EXTRACT_CLIENT_SETTINGS_DRIFT', 'error', document.file, document.symbol, 'bound persisted settings document has no exact exported field union'))
  }
  return {
    client: {
      entrypoints: entrypoints.sort((left, right) => compareText(left.file, right.file)),
      injections: stableSort(injections), slots: stableSort(slots),
      settingsNamespaces: stableSort(settingsNamespaces, (left, right) => compareText(left.symbol, right.symbol)),
      settingsFields: stableSort(settingsFields, (left, right) => compareText(left.symbol, right.symbol)),
      settingsDocuments: stableSort(settingsDocuments, (left, right) => compareText(left.symbol, right.symbol)),
      settingsBindings: stableSort(settingsBindings),
    },
  }
}

function ancestorCall(node, method, checker, packageName) {
  let current = node.parent
  while (current !== undefined) {
    if (ts.isCallExpression(current)) {
      const shape = callBinding(current, checker)
      if (shape?.method === method && (packageName === undefined || symbolComesFrom(shape.symbol, packageName))) return current
    }
    if (ts.isFunctionLike(current) && current !== node) {
      const parent = current.parent
      const shape = ts.isCallExpression(parent) ? callBinding(parent, checker) : undefined
      if (shape?.method === method && parent.arguments.includes(current)
        && (packageName === undefined || symbolComesFrom(shape.symbol, packageName))) return parent
      return undefined
    }
    current = current.parent
  }
  return undefined
}

function expressionIdentity(node, checker) {
  const value = unwrap(node)
  if (value === undefined) return undefined
  const symbol = symbolOf(ts.isPropertyAccessExpression(value) ? value.name : value, checker)
  return declarationKey(symbol)
}

function listenerAuthority(call) {
  if (symbolComesFrom(call.symbol, '@deepseek-ai/cordis')) return 'cordis'
  if (symbolComesFrom(call.symbol, '@deepseek-ai/dsh-system-prompt')) return 'system-prompt'
  if (call.declarationFiles.some(file => /^typescript-lib:lib\.(?:dom|webworker)\.d\.ts$/u.test(file) || file.startsWith('package:@types/node/'))) return 'platform'
  if (call.symbol !== undefined && call.declarationFiles.length > 0) return 'local-symbol'
  return undefined
}

function assignedOwner(node) {
  const parent = node.parent
  if (ts.isReturnStatement(parent)) return 'return'
  if (ts.isBinaryExpression(parent) && parent.right === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) return parent.left.getText(node.getSourceFile())
  if (ts.isVariableDeclaration(parent) && parent.initializer === node) return parent.name.getText(node.getSourceFile())
  return null
}

function eventFacts(sourceRecords, context, diagnostics) {
  const listeners = []
  const systemPrompts = []
  const effects = []
  const removals = new Set()
  for (const record of sourceRecords) visit(record.sourceFile, node => {
    const call = callBinding(node, context.checker)
    if (call === undefined) return
    const receiver = call.receiver?.getText(record.sourceFile) ?? `<bound:${call.method}>`
    const authority = listenerAuthority(call)
    if (call.method === 'effect') {
      if (!symbolComesFrom(call.symbol, '@deepseek-ai/cordis')) {
        if (call.arguments.length > 0) diagnostics.push(makeDiagnostic('KG_EXTRACT_EFFECT_WRONG_ORIGIN', 'error', record.path, containingSymbol(node), 'effect-shaped call is not bound to Cordis Context.effect'))
        return
      }
      const callback = unwrap(call.arguments[0])
      let cleanup = 'none-visible'
      if (callback !== undefined && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
        if (!ts.isBlock(callback.body)) cleanup = ts.isCallExpression(unwrap(callback.body)) ? 'returned-call-or-disposer' : 'expression'
        else if (callback.body.statements.some(ts.isReturnStatement)) cleanup = 'returned-cleanup'
      }
      effects.push({
        label: staticValue(call.arguments[1], context) ?? null,
        async: callback?.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false,
        cleanup, file: record.path, containingSymbol: containingSymbol(node), anchor: anchor(record.sourceFile, node),
      })
    }
    if (call.method === 'removeEventListener') {
      if (authority === undefined) {
        diagnostics.push(makeDiagnostic('KG_EXTRACT_EVENT_WRONG_ORIGIN', 'error', record.path, containingSymbol(node), 'removeEventListener has no resolved event authority'))
        return
      }
      const event = staticValue(call.arguments[0], context)
      const receiverId = call.receiver === undefined ? declarationKey(call.symbol) : expressionIdentity(call.receiver, context.checker)
      const handlerId = expressionIdentity(call.arguments[1], context.checker)
      if (typeof event === 'string' && receiverId !== undefined && handlerId !== undefined) removals.add(`${record.path}|${receiverId}|${event}|${handlerId}`)
      return
    }
    if (call.method === 'on' || call.method === 'addEventListener') {
      if (authority === undefined) {
        diagnostics.push(makeDiagnostic('KG_EXTRACT_EVENT_WRONG_ORIGIN', 'error', record.path, containingSymbol(node), `${call.method} has no resolved event authority`))
        return
      }
      const event = staticValue(call.arguments[0], context)
      if (typeof event !== 'string') diagnostics.push(makeDiagnostic('KG_EXTRACT_EVENT_NAME_DYNAMIC', 'error', record.path, containingSymbol(node), `${call.method} event name is dynamic`))
      const effect = ancestorCall(node, 'effect', context.checker, '@deepseek-ai/cordis')
      const binding = assignedOwner(node)
      const options = unwrap(call.arguments[2])
      const once = options !== undefined && ts.isObjectLiteralExpression(options) && options.properties.some(property => ts.isPropertyAssignment(property)
        && propertyName(property.name) === 'once' && staticValue(property.initializer, context) === true)
      listeners.push({
        api: call.method, authority, receiver, receiverIdentity: (call.receiver === undefined ? declarationKey(call.symbol) : expressionIdentity(call.receiver, context.checker)) ?? null,
        event: typeof event === 'string' ? event : null,
        handler: call.arguments[1]?.getText(record.sourceFile) ?? null,
        handlerIdentity: expressionIdentity(call.arguments[1], context.checker) ?? null,
        disposerOwner: effect === undefined ? (binding ?? (authority === 'cordis' ? 'context' : null)) : 'ctx.effect',
        disposerBinding: binding,
        pairedRemoval: once ? true : null,
        file: record.path, containingSymbol: containingSymbol(node), anchor: anchor(record.sourceFile, node),
      })
    }
    if (call.method === 'section') {
      if (!symbolComesFrom(call.symbol, '@deepseek-ai/dsh-system-prompt')) {
        diagnostics.push(makeDiagnostic('KG_EXTRACT_SYSTEM_PROMPT_WRONG_ORIGIN', 'error', record.path, containingSymbol(node), 'section-shaped call is not bound to the official system-prompt service'))
        return
      }
      const object = unwrap(call.arguments[0])
      const fields = ts.isObjectLiteralExpression(object) ? Object.fromEntries(object.properties.flatMap(property => {
        if (!ts.isPropertyAssignment(property) && !ts.isMethodDeclaration(property)) return []
        const name = propertyName(property.name)
        if (name === undefined || !['name', 'order'].includes(name)) return []
        return [[name, ts.isPropertyAssignment(property) ? staticValue(property.initializer, context) ?? property.initializer.getText(record.sourceFile) : '<method>']]
      })) : null
      systemPrompts.push({ fields, file: record.path, containingSymbol: containingSymbol(node), disposerOwner: ancestorCall(node, 'effect', context.checker, '@deepseek-ai/cordis') === undefined ? 'context' : 'ctx.effect', anchor: anchor(record.sourceFile, node) })
    }
  })
  for (const item of listeners) {
    if (item.api !== 'addEventListener') continue
    const key = `${item.file}|${item.receiverIdentity}|${item.event}|${item.handlerIdentity}`
    item.pairedRemoval ??= removals.has(key)
    if (!item.pairedRemoval) diagnostics.push(makeDiagnostic('KG_EXTRACT_EVENT_DISPOSER_MISSING', 'error', item.file, item.containingSymbol, `${item.receiver}.addEventListener(${JSON.stringify(item.event)}) has no matching removal`))
  }
  return {
    listeners: stableSort(listeners, (left, right) => compareText(left.event ?? '', right.event ?? '')),
    systemPrompts: stableSort(systemPrompts),
    effects: stableSort(effects, (left, right) => compareText(left.label ?? '', right.label ?? '')),
  }
}

export function extractRpcClientEventFacts(sourceRecords, context, diagnostics) {
  const linkedUnions = structurallyLinkedUnions(sourceRecords, context)
  const { methods, pageKinds } = linkedUnions
  const required = sourceRecords.some(record => record.path.startsWith('src/rpc/'))
  if (required && methods.values.length === 0) diagnostics.push(makeDiagnostic('KG_EXTRACT_RPC_METHOD_DYNAMIC', 'error', methods.file ?? undefined, methods.symbol, 'RPC method union is absent or non-literal'))
  if (required && pageKinds.values.length === 0) diagnostics.push(makeDiagnostic('KG_EXTRACT_RPC_PAGE_KIND_DYNAMIC', 'error', pageKinds.file ?? undefined, pageKinds.symbol, 'RPC page-kind union is absent or non-literal'))
  return {
    rpc: {
      constants: rpcConstants(sourceRecords, context), methods, pageKinds,
      ...rpcRoutes(sourceRecords, context, diagnostics, required),
      schemas: rpcSchemas(sourceRecords, context),
      capabilities: capabilityLists(sourceRecords, context, diagnostics, required),
      runtimeCapabilities: runtimeCapabilities(sourceRecords, context, diagnostics),
      bounds: pageBounds(sourceRecords, context),
      literalUnions: linkedUnions.literalUnions,
    },
    ...clientFacts(sourceRecords, context, diagnostics),
    lifecycle: eventFacts(sourceRecords, context, diagnostics),
  }
}
