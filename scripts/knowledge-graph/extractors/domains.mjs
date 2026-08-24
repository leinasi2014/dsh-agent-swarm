import ts from 'typescript'
import {
  anchor, callBinding, compareText, literalUnion, makeDiagnostic, propertyName, stableSort, staticValue,
  symbolComesFrom, symbolOf, unwrap,
} from './ast.mjs'

function exported(node) {
  return node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false
}

function objectProperty(object, name) {
  return object.properties.find(item => (ts.isPropertyAssignment(item) || ts.isShorthandPropertyAssignment(item)) && propertyName(item.name) === name)
}

function initializerOf(property) {
  return ts.isPropertyAssignment(property) ? property.initializer : property.name
}

function resolveExpression(expression, context, stack = new Set()) {
  let node = unwrap(expression)
  if (ts.isIdentifier(node)) {
    const symbol = symbolOf(node, context.checker)
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0]
    const key = declaration === undefined ? undefined : `${declaration.getSourceFile().fileName}:${declaration.pos}`
    if (declaration !== undefined && key !== undefined && !stack.has(key)
      && (ts.isVariableDeclaration(declaration) || ts.isPropertyDeclaration(declaration)) && declaration.initializer !== undefined) {
      const next = new Set(stack); next.add(key)
      return resolveExpression(declaration.initializer, context, next)
    }
  }
  return node
}

function zodSchemaShape(expression, context, stack = new Set()) {
  const node = resolveExpression(expression, context, stack)
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return { kind: 'dynamic', fields: [] }
  let current = node
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
    const method = current.expression.name.text
    const binding = callBinding(current, context.checker)
    if (!symbolComesFrom(binding?.symbol, 'zod')) return { kind: 'wrong-origin', fields: [] }
    const receiver = unwrap(current.expression.expression)
    const origin = callBinding(current, context.checker)?.origin
    if (origin?.moduleSpecifier === 'zod' && origin.members.at(-1) === method) {
      if (method === 'object') {
        const object = unwrap(current.arguments[0])
        if (!ts.isObjectLiteralExpression(object)) return { kind: 'object-dynamic', fields: [] }
        const fields = object.properties.flatMap(property => {
          if (!ts.isPropertyAssignment(property)) return []
          const name = propertyName(property.name)
          if (name === undefined) return []
          const shape = zodSchemaShape(property.initializer, context, stack)
          return [{ name, kind: shape.kind, anchor: anchor(property.getSourceFile(), property) }]
        }).sort((left, right) => compareText(left.name, right.name))
        return { kind: 'object', fields }
      }
      if (method === 'discriminatedUnion') {
        return { kind: 'discriminated-union', discriminator: staticValue(current.arguments[0], context) ?? null, variants: staticValue(current.arguments[1], context) ?? null, fields: [] }
      }
      return { kind: method, fields: [] }
    }
    current = receiver
  }
  return { kind: 'dynamic', fields: [] }
}

function extractDomainSpecs(sourceRecords, context, diagnostics) {
  const domains = []
  for (const record of sourceRecords) {
    for (const statement of record.sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue
        const initializer = unwrap(declaration.initializer)
        if (!ts.isCallExpression(initializer)) continue
        const candidate = unwrap(initializer.arguments[0])
        const looksLikeDomain = candidate !== undefined && ts.isObjectLiteralExpression(candidate)
          && ['name', 'version', 'tables'].every(key => objectProperty(candidate, key) !== undefined)
        if (!looksLikeDomain) continue
        const call = callBinding(initializer, context.checker)
        if (call?.origin?.moduleSpecifier !== '@deepseek-ai/dsh-storage-domain'
          || (call.origin.members.at(-1) ?? call.origin.imported) !== 'defineDomain') {
          diagnostics.push(makeDiagnostic('KG_EXTRACT_DOMAIN_CALL_WRONG_ORIGIN', 'error', record.path, declaration.name.text, 'domain-shaped call is not the official Storage Domain defineDomain export'))
          continue
        }
        const object = unwrap(call.arguments[0])
        if (!ts.isObjectLiteralExpression(object)) {
          diagnostics.push(makeDiagnostic('KG_EXTRACT_DOMAIN_SPEC_DYNAMIC', 'error', record.path, declaration.name.text, 'defineDomain argument is not an object literal'))
          continue
        }
        const nameProperty = objectProperty(object, 'name')
        const versionProperty = objectProperty(object, 'version')
        const tablesProperty = objectProperty(object, 'tables')
        const name = nameProperty === undefined ? undefined : staticValue(initializerOf(nameProperty), context)
        const version = versionProperty === undefined ? undefined : staticValue(initializerOf(versionProperty), context)
        if (typeof name !== 'string' || !Number.isSafeInteger(version)) diagnostics.push(makeDiagnostic('KG_EXTRACT_DOMAIN_ID_DYNAMIC', 'error', record.path, declaration.name.text, 'domain name/version are not static string/safe-integer identities'))
        const tablesObject = tablesProperty === undefined ? undefined : unwrap(initializerOf(tablesProperty))
        const tables = []
        if (!ts.isObjectLiteralExpression(tablesObject)) diagnostics.push(makeDiagnostic('KG_EXTRACT_DOMAIN_TABLE_DYNAMIC', 'error', record.path, declaration.name.text, 'domain tables are not an object literal'))
        else for (const property of tablesObject.properties) {
          if (!ts.isPropertyAssignment(property)) {
            diagnostics.push(makeDiagnostic('KG_EXTRACT_DOMAIN_TABLE_DYNAMIC', 'error', record.path, declaration.name.text, 'domain table uses a dynamic member'))
            continue
          }
          const table = propertyName(property.name)
          const tableCall = callBinding(unwrap(property.initializer), context.checker)
          if (table === undefined || tableCall?.origin?.moduleSpecifier !== '@deepseek-ai/dsh-storage-domain'
            || (tableCall.origin.members.at(-1) ?? tableCall.origin.imported) !== 'domainTable') {
            diagnostics.push(makeDiagnostic('KG_EXTRACT_DOMAIN_TABLE_DYNAMIC', 'error', record.path, declaration.name.text, 'domain table is not a static domainTable call'))
            continue
          }
          const types = tableCall.node.typeArguments?.map(type => type.getText(record.sourceFile)) ?? []
          const schemaExpression = tableCall.arguments[0]
          const shape = schemaExpression === undefined ? { kind: 'missing', fields: [] } : zodSchemaShape(schemaExpression, context)
          if (shape.kind === 'dynamic' || shape.kind === 'missing' || shape.kind === 'wrong-origin') diagnostics.push(makeDiagnostic('KG_EXTRACT_DOMAIN_SCHEMA_DYNAMIC', 'error', record.path, table, 'domain record schema is not statically traceable to official Zod'))
          tables.push({ table, keyType: types[0] ?? null, recordType: types[1] ?? null, schemaExpression: schemaExpression?.getText(record.sourceFile) ?? null, schema: shape, anchor: anchor(record.sourceFile, property) })
        }
        tables.sort((left, right) => compareText(left.table, right.table))
        domains.push({ symbol: declaration.name.text, name: typeof name === 'string' ? name : null, version: Number.isSafeInteger(version) ? version : null, tables, file: record.path, exported: exported(statement), anchor: anchor(record.sourceFile, declaration) })
      }
    }
  }
  return stableSort(domains, (left, right) => compareText(left.symbol, right.symbol))
}

function methodFacts(interfaceNode, record, checker) {
  return interfaceNode.members.flatMap(member => {
    if (!ts.isMethodSignature(member)) return []
    const name = propertyName(member.name)
    if (name === undefined) return []
    const signature = checker.getSignatureFromDeclaration(member)
    return [{
      name,
      parameters: member.parameters.map(parameter => ({ name: propertyName(parameter.name) ?? parameter.name.getText(record.sourceFile), type: parameter.type?.getText(record.sourceFile) ?? checker.typeToString(checker.getTypeAtLocation(parameter)) })),
      returnType: member.type?.getText(record.sourceFile) ?? (signature === undefined ? '<unknown>' : checker.typeToString(signature.getReturnType())),
      anchor: anchor(record.sourceFile, member),
    }]
  })
}

function extractDomainPort(sourceRecords, checker, diagnostics) {
  for (const record of sourceRecords) {
    const declaration = record.sourceFile.statements.find(statement => ts.isInterfaceDeclaration(statement) && statement.name.text === 'TeamDomainPort')
    if (declaration !== undefined && ts.isInterfaceDeclaration(declaration)) {
      return { file: record.path, symbol: 'TeamDomainPort', methods: methodFacts(declaration, record, checker), anchor: anchor(record.sourceFile, declaration) }
    }
  }
  return { file: null, symbol: 'TeamDomainPort', methods: [], anchor: null }
}

function typeLiteralValues(type, checker, seen = new Set()) {
  if (seen.has(type)) return []
  seen.add(type)
  if (type.isUnion()) return type.types.flatMap(item => typeLiteralValues(item, checker, seen))
  if ((type.flags & ts.TypeFlags.StringLiteral) !== 0 || (type.flags & ts.TypeFlags.NumberLiteral) !== 0) return [type.value]
  if ((type.flags & ts.TypeFlags.BooleanLiteral) !== 0) return [checker.typeToString(type) === 'true']
  return []
}

function extractStateTypes(sourceRecords, context) {
  const unionsByKey = new Map()
  const discriminantsByKey = new Map()
  const pendingTypes = []
  const seenTypes = new Set()
  const localDeclaration = symbol => symbol?.declarations?.find(declaration => context.recordBySourceFile.has(declaration.getSourceFile()))
  const addTypeNode = node => { if (node !== undefined) pendingTypes.push(context.checker.getTypeAtLocation(node)) }

  for (const record of sourceRecords) {
    for (const statement of record.sourceFile.statements) {
      if (ts.isInterfaceDeclaration(statement) && statement.name.text === 'TeamDomainPort') addTypeNode(statement.name)
    }
    const walk = node => {
      const call = callBinding(node, context.checker)
      if (call?.origin?.moduleSpecifier === '@deepseek-ai/dsh-storage-domain'
        && (call.origin.members.at(-1) ?? call.origin.imported) === 'domainTable') addTypeNode(call.node.typeArguments?.[1])
      ts.forEachChild(node, walk)
    }
    walk(record.sourceFile)
  }

  const enqueueType = type => { if (type !== undefined && !seenTypes.has(type)) pendingTypes.push(type) }
  while (pendingTypes.length > 0) {
    const type = pendingTypes.pop()
    if (type === undefined || seenTypes.has(type)) continue
    seenTypes.add(type)
    for (const part of type.isUnionOrIntersection() ? type.types : []) enqueueType(part)
    if ((type.objectFlags & ts.ObjectFlags.Reference) !== 0) {
      for (const argument of context.checker.getTypeArguments(type)) enqueueType(argument)
    }
    const symbol = type.aliasSymbol ?? type.getSymbol()
    const declaration = localDeclaration(symbol)
    if (declaration !== undefined && symbol !== undefined) {
      const record = context.recordBySourceFile.get(declaration.getSourceFile())
      if (ts.isTypeAliasDeclaration(declaration)) {
        const values = literalUnion(declaration.type)
        if (values.length > 0) unionsByKey.set(`${record.path}|${symbol.name}`, {
          symbol: symbol.name, values: [...new Set(values)], exported: exported(declaration),
          file: record.path, anchor: anchor(record.sourceFile, declaration),
        })
      }
      const namedEntity = ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration) || ts.isClassDeclaration(declaration)
      const entityType = namedEntity
        ? context.checker.getDeclaredTypeOfSymbol(symbol) : type
      for (const property of entityType.getProperties()) {
        const propertyDeclaration = localDeclaration(property)
        if (propertyDeclaration === undefined) continue
        const field = propertyName(propertyDeclaration.name)
        if (field === undefined) continue
        const propertyType = context.checker.getTypeOfSymbolAtLocation(property, propertyDeclaration)
        const values = typeLiteralValues(propertyType, context.checker)
        if (namedEntity && values.length > 0) discriminantsByKey.set(`${record.path}|${symbol.name}|${field}`, {
          entity: symbol.name, field, values: [...new Set(values)].sort(compareText),
          file: record.path, anchor: anchor(record.sourceFile, propertyDeclaration),
        })
        enqueueType(propertyType)
      }
      for (const signature of [...entityType.getCallSignatures(), ...entityType.getConstructSignatures()]) {
        for (const parameter of signature.parameters) {
          const parameterDeclaration = localDeclaration(parameter)
          if (parameterDeclaration !== undefined) enqueueType(context.checker.getTypeOfSymbolAtLocation(parameter, parameterDeclaration))
        }
        enqueueType(signature.getReturnType())
      }
    }
  }
  const unions = [...unionsByKey.values()]
  const discriminants = [...discriminantsByKey.values()]
  return {
    stateUnions: stableSort(unions, (left, right) => compareText(left.symbol, right.symbol)),
    entityDiscriminants: stableSort(discriminants, (left, right) => compareText(left.entity, right.entity) || compareText(left.field, right.field)),
  }
}

export function extractDomainFacts(sourceRecords, context, diagnostics) {
  const domains = extractDomainSpecs(sourceRecords, context, diagnostics)
  const teamDomainPort = extractDomainPort(sourceRecords, context.checker, diagnostics)
  const state = extractStateTypes(sourceRecords, context)
  return { domains, teamDomainPort, ...state }
}
