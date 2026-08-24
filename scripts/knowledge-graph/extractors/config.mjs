import ts from 'typescript'
import {
  anchor, callBinding, compareText, declarationKey, makeDiagnostic, propertyName, stableSort, staticValue,
  symbolComesFrom, symbolOf, unwrap, visit,
} from './ast.mjs'

function exported(node) {
  return node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false
}

function findConfigInterface(sourceRecords) {
  for (const record of sourceRecords) {
    for (const statement of record.sourceFile.statements) {
      if (ts.isInterfaceDeclaration(statement) && statement.name.text === 'Config' && exported(statement)) return { record, node: statement }
    }
  }
  return undefined
}

function findConfigSchema(sourceRecords) {
  for (const record of sourceRecords) {
    for (const statement of record.sourceFile.statements) {
      if (!ts.isVariableStatement(statement) || !exported(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === 'Config' && declaration.initializer !== undefined) return { record, node: declaration }
      }
    }
  }
  return undefined
}

function unwindZod(expression, context) {
  let current = unwrap(expression)
  const operations = []
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
    const method = current.expression.name.text
    const binding = callBinding(current, context.checker)
    if (!symbolComesFrom(binding?.symbol, '@deepseek-ai/schemastery')) return undefined
    const receiver = unwrap(current.expression.expression)
    const receiverBinding = callBinding(current, context.checker)?.origin
    if (receiverBinding?.moduleSpecifier === '@deepseek-ai/schemastery'
      && (receiverBinding.members.at(-1) === method || receiverBinding.imported === method)) {
      return { root: method, rootArguments: [...current.arguments], operations: operations.reverse(), origin: receiverBinding }
    }
    operations.push({ method, arguments: [...current.arguments] })
    current = receiver
  }
  if (ts.isCallExpression(current)) {
    const binding = callBinding(current, context.checker)
    if (binding?.origin?.moduleSpecifier === '@deepseek-ai/schemastery') {
      const root = binding.origin.members.at(-1) ?? binding.origin.imported
      return { root, rootArguments: [...current.arguments], operations: operations.reverse(), origin: binding.origin }
    }
  }
  return undefined
}

function zodNode(expression, context, diagnostics, file, path) {
  const chain = unwindZod(expression, context)
  if (chain === undefined) {
    diagnostics.push(makeDiagnostic('KG_EXTRACT_CONFIG_SCHEMA_DYNAMIC', 'error', file, path, 'Config schema expression is not a static Zod chain'))
    return { kind: 'dynamic', constraints: {}, default: null, hasDefault: false }
  }
  const constraints = {}
  let defaultValue = null
  let hasDefault = false
  let optional = false
  for (const operation of chain.operations) {
    if (['min', 'max', 'step', 'length'].includes(operation.method)) {
      const value = staticValue(operation.arguments[0], context)
      if (typeof value !== 'number') diagnostics.push(makeDiagnostic('KG_EXTRACT_CONFIG_CONSTRAINT_DYNAMIC', 'error', file, path, `${operation.method} bound is not static`))
      else constraints[operation.method] = value
    } else if (operation.method === 'default') {
      hasDefault = true
      const value = staticValue(operation.arguments[0], context)
      if (value === undefined) diagnostics.push(makeDiagnostic('KG_EXTRACT_CONFIG_DEFAULT_DYNAMIC', 'error', file, path, 'Config default is not statically resolvable'))
      else defaultValue = value
    } else if (operation.method === 'optional') optional = true
  }
  let enumValues = []
  let children
  if (chain.root === 'union' || chain.root === 'enum') {
    const value = staticValue(chain.rootArguments[0], context)
    if (Array.isArray(value) && value.every(item => typeof item === 'string')) enumValues = value
    else diagnostics.push(makeDiagnostic('KG_EXTRACT_CONFIG_ENUM_DYNAMIC', 'error', file, path, 'Config enum/union is not a static string array'))
  }
  if (chain.root === 'object') {
    const object = unwrap(chain.rootArguments[0])
    if (!ts.isObjectLiteralExpression(object)) diagnostics.push(makeDiagnostic('KG_EXTRACT_CONFIG_SCHEMA_DYNAMIC', 'error', file, path, 'nested Zod object is not an object literal'))
    else {
      children = []
      for (const property of object.properties) {
        if (!ts.isPropertyAssignment(property)) {
          diagnostics.push(makeDiagnostic('KG_EXTRACT_CONFIG_SCHEMA_DYNAMIC', 'error', file, path, 'nested Zod object uses a non-property assignment'))
          continue
        }
        const name = propertyName(property.name)
        if (name === undefined) continue
        children.push({ key: name, ...zodNode(property.initializer, context, diagnostics, file, `${path}.${name}`), anchor: anchor(property.getSourceFile(), property) })
      }
      children.sort((left, right) => compareText(left.key, right.key))
    }
  }
  return { kind: chain.root, constraints, enumValues, default: defaultValue, hasDefault, optional, ...(children === undefined ? {} : { children }) }
}

function interfaceProperties(found, checker) {
  if (found === undefined) return []
  const result = []
  for (const member of found.node.members) {
    if (!ts.isPropertySignature(member)) continue
    const key = propertyName(member.name)
    if (key === undefined) continue
    const typeText = member.type?.getText(found.record.sourceFile) ?? checker.typeToString(checker.getTypeAtLocation(member))
    const kind = member.type !== undefined && ts.isTypeLiteralNode(member.type) ? 'object'
      : member.type !== undefined && ts.isArrayTypeNode(member.type) ? 'array'
        : member.type !== undefined && ts.isUnionTypeNode(member.type) ? 'union'
          : /^(string|number|boolean)$/u.test(typeText) ? typeText : 'reference'
    result.push({
      key,
      optional: member.questionToken !== undefined,
      readonly: member.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ReadonlyKeyword) ?? false,
      type: typeText,
      kind,
      anchor: anchor(found.record.sourceFile, member),
    })
  }
  return result.sort((left, right) => compareText(left.key, right.key))
}

function schemaProperties(found, context, diagnostics) {
  if (found === undefined) return []
  const chain = unwindZod(found.node.initializer, context)
  const object = chain?.root === 'object' ? unwrap(chain.rootArguments[0]) : undefined
  if (object === undefined || !ts.isObjectLiteralExpression(object)) {
    diagnostics.push(makeDiagnostic('KG_EXTRACT_CONFIG_SCHEMA_DYNAMIC', 'error', found.record.path, 'Config', 'exported Config value is not z.object({...})'))
    return []
  }
  const result = []
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) {
      diagnostics.push(makeDiagnostic('KG_EXTRACT_CONFIG_SCHEMA_DYNAMIC', 'error', found.record.path, 'Config', 'Config Zod object contains a dynamic member'))
      continue
    }
    const key = propertyName(property.name)
    if (key === undefined) continue
    result.push({ key, ...zodNode(property.initializer, context, diagnostics, found.record.path, key), anchor: anchor(found.record.sourceFile, property) })
  }
  return result.sort((left, right) => compareText(left.key, right.key))
}

function containingFunction(node) {
  let current = node.parent
  while (current !== undefined) {
    if (ts.isFunctionLike(current)) return current
    current = current.parent
  }
  return undefined
}

function configParameterSymbols(sourceRecords, checker, configDeclaration) {
  const symbols = new Set()
  const configSymbol = configDeclaration === undefined ? undefined : symbolOf(configDeclaration.name, checker)
  const configIdentity = declarationKey(configSymbol)
  for (const record of sourceRecords) visit(record.sourceFile, node => {
    if (!ts.isParameter(node) || !ts.isIdentifier(node.name) || node.type === undefined) return
    const typeSymbol = symbolOf(node.type, checker) ?? checker.getTypeAtLocation(node.type).aliasSymbol ?? checker.getTypeAtLocation(node.type).symbol
    if (configIdentity !== undefined && declarationKey(typeSymbol) === configIdentity) {
      const symbol = checker.getSymbolAtLocation(node.name)
      if (symbol !== undefined) symbols.add(symbol)
    }
  })
  return symbols
}

function effectiveConsumptions(sourceRecords, context, diagnostics, configDeclaration) {
  const parameterSymbols = configParameterSymbols(sourceRecords, context.checker, configDeclaration)
  const facts = []
  const seen = new Set()
  for (const record of sourceRecords) visit(record.sourceFile, node => {
    if (!ts.isPropertyAccessExpression(node) || !ts.isIdentifier(node.expression)) return
    const symbol = context.checker.getSymbolAtLocation(node.expression)
    if (symbol === undefined || !parameterSymbols.has(symbol)) return
    const key = node.name.text
    const parent = unwrap(node.parent)
    let fallback = null
    let hasFallback = false
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && parent.left === node) {
      hasFallback = true
      const value = staticValue(parent.right, context)
      if (value === undefined) diagnostics.push(makeDiagnostic('KG_EXTRACT_CONFIG_DEFAULT_DYNAMIC', 'error', record.path, key, 'effective Config fallback is dynamic'))
      else fallback = value
    }
    const owner = containingFunction(node)
    const id = `${record.path}:${node.pos}:${node.end}`
    if (seen.has(id)) return
    seen.add(id)
    facts.push({ key, hasFallback, fallback, file: record.path, containingSymbol: owner?.name?.getText(record.sourceFile) ?? '<anonymous>', anchor: anchor(record.sourceFile, node) })
  })
  return stableSort(facts, (left, right) => compareText(left.key, right.key))
}

function diagnoseKeySet(interfaceFacts, schemaFacts, consumptions, diagnostics, file) {
  const interfaceKeys = new Set(interfaceFacts.map(item => item.key))
  const schemaKeys = new Set(schemaFacts.map(item => item.key))
  for (const key of [...interfaceKeys].sort(compareText)) {
    if (!schemaKeys.has(key)) diagnostics.push(makeDiagnostic('KG_EXTRACT_CONFIG_KEY_DRIFT', 'error', file, key, 'Config interface key is absent from Zod schema'))
  }
  for (const key of [...schemaKeys].sort(compareText)) {
    if (!interfaceKeys.has(key)) diagnostics.push(makeDiagnostic('KG_EXTRACT_CONFIG_KEY_DRIFT', 'error', file, key, 'Config Zod key is absent from interface'))
  }
  for (const fact of consumptions) {
    if (!interfaceKeys.has(fact.key)) diagnostics.push(makeDiagnostic('KG_EXTRACT_CONFIG_CONSUMPTION_DRIFT', 'error', fact.file, fact.key, 'runtime consumes an undeclared Config key'))
  }
  const schemaByKey = new Map(schemaFacts.map(item => [item.key, item]))
  const interfaceByKey = new Map(interfaceFacts.map(item => [item.key, item]))
  for (const [key, schema] of schemaByKey) {
    const declared = interfaceByKey.get(key)
    if (declared === undefined) continue
    const compatible = declared.kind === schema.kind
      || (declared.kind === 'number' && schema.kind === 'natural')
    if (!compatible) diagnostics.push(makeDiagnostic('KG_EXTRACT_CONFIG_TYPE_DRIFT', 'error', file, key, `Config interface kind ${declared.kind} differs from Zod kind ${schema.kind}`))
  }
  for (const [key, uses] of Map.groupBy(consumptions.filter(item => item.hasFallback), item => item.key)) {
    const schema = schemaByKey.get(key)
    if (schema === undefined || !schema.hasDefault) continue
    const expected = JSON.stringify(schema.default)
    for (const use of uses) {
      if (JSON.stringify(use.fallback) !== expected) diagnostics.push(makeDiagnostic('KG_EXTRACT_CONFIG_DEFAULT_DRIFT', 'error', use.file, key, `effective fallback ${JSON.stringify(use.fallback)} differs from Zod default ${expected}`))
    }
  }
}

export function extractConfigFacts(sourceRecords, context, diagnostics) {
  const interfaceFound = findConfigInterface(sourceRecords)
  const schemaFound = findConfigSchema(sourceRecords)
  if (interfaceFound !== undefined && schemaFound === undefined) diagnostics.push(makeDiagnostic('KG_EXTRACT_CONFIG_SCHEMA_MISSING', 'error', interfaceFound.record.path, 'Config', 'Config interface exists without its exported Zod value'))
  if (schemaFound !== undefined && interfaceFound === undefined) diagnostics.push(makeDiagnostic('KG_EXTRACT_CONFIG_INTERFACE_MISSING', 'error', schemaFound.record.path, 'Config', 'Config Zod value exists without its exported interface'))
  const interfaceFacts = interfaceProperties(interfaceFound, context.checker)
  const schemaFacts = schemaProperties(schemaFound, context, diagnostics)
  const effective = effectiveConsumptions(sourceRecords, context, diagnostics, interfaceFound?.node)
  diagnoseKeySet(interfaceFacts, schemaFacts, effective, diagnostics, interfaceFound?.record.path ?? schemaFound?.record.path)
  return {
    config: {
      interface: { file: interfaceFound?.record.path ?? null, properties: interfaceFacts },
      schema: { file: schemaFound?.record.path ?? null, properties: schemaFacts },
      effectiveConsumptions: effective,
    },
  }
}
