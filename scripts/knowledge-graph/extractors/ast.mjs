import { relative, resolve } from 'node:path'
import ts from 'typescript'

export function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

export function slash(value) {
  return value.replaceAll('\\', '/')
}

export function anchor(sourceFile, node) {
  const point = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  return { line: point.line + 1, column: point.character + 1 }
}

export function unwrap(node) {
  let current = node
  while (current !== undefined && (
    ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)
    || ts.isParenthesizedExpression(current) || ts.isSatisfiesExpression(current)
    || ts.isNonNullExpression(current)
  )) current = current.expression
  return current
}

export function propertyName(node) {
  if (node === undefined) return undefined
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text
  return undefined
}

export function literal(node) {
  const value = unwrap(node)
  if (value === undefined) return undefined
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text
  if (ts.isNumericLiteral(value)) return Number(value.text.replaceAll('_', ''))
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false
  if (value.kind === ts.SyntaxKind.NullKeyword) return null
  if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.MinusToken) {
    const inner = literal(value.operand)
    return typeof inner === 'number' ? -inner : undefined
  }
  return undefined
}

export function symbolOf(node, checker) {
  let symbol = checker.getSymbolAtLocation(node)
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    try { symbol = checker.getAliasedSymbol(symbol) } catch { return undefined }
  }
  return symbol
}

function importDeclarationOf(node) {
  let current = node
  while (current !== undefined && !ts.isImportDeclaration(current)) current = current.parent
  return current
}

/** Resolve imports through aliases, const aliases, and object destructuring. */
export function bindingOrigin(node, checker, seen = new Set()) {
  const value = unwrap(node)
  if (value === undefined) return undefined
  if (ts.isPropertyAccessExpression(value)) {
    const base = bindingOrigin(value.expression, checker, seen)
    return base === undefined ? undefined : { ...base, members: [...base.members, value.name.text] }
  }
  const local = checker.getSymbolAtLocation(value)
  if (local === undefined) return undefined
  const key = declarationKey(local)
  if (key !== undefined && seen.has(key)) return undefined
  const next = new Set(seen)
  if (key !== undefined) next.add(key)
  const declaration = local.declarations?.[0] ?? local.valueDeclaration
  if (declaration !== undefined) {
    if (ts.isImportSpecifier(declaration)) {
      const imported = declaration.propertyName?.text ?? declaration.name.text
      const importDeclaration = importDeclarationOf(declaration)
      if (importDeclaration !== undefined && ts.isStringLiteral(importDeclaration.moduleSpecifier)) {
        return { moduleSpecifier: importDeclaration.moduleSpecifier.text, imported, members: [] }
      }
    }
    if (ts.isNamespaceImport(declaration)) {
      const importDeclaration = importDeclarationOf(declaration)
      if (importDeclaration !== undefined && ts.isStringLiteral(importDeclaration.moduleSpecifier)) {
        return { moduleSpecifier: importDeclaration.moduleSpecifier.text, imported: '*', members: [] }
      }
    }
    if (ts.isImportClause(declaration)) {
      const importDeclaration = importDeclarationOf(declaration)
      if (importDeclaration !== undefined && ts.isStringLiteral(importDeclaration.moduleSpecifier)) {
        return { moduleSpecifier: importDeclaration.moduleSpecifier.text, imported: 'default', members: [] }
      }
    }
    if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
      if (ts.isIdentifier(declaration.name)) return bindingOrigin(declaration.initializer, checker, next)
      if (ts.isObjectBindingPattern(declaration.name) && ts.isIdentifier(value)) {
        const element = declaration.name.elements.find(item => item.name === declaration || item.name.getText() === value.getText())
        if (element !== undefined) {
          const base = bindingOrigin(declaration.initializer, checker, next)
          const member = propertyName(element.propertyName ?? element.name)
          return base === undefined || member === undefined ? undefined : { ...base, members: [...base.members, member] }
        }
      }
    }
    if (ts.isBindingElement(declaration)) {
      const variable = declaration.parent.parent
      if (ts.isVariableDeclaration(variable) && variable.initializer !== undefined) {
        const base = bindingOrigin(variable.initializer, checker, next)
        const member = propertyName(declaration.propertyName ?? declaration.name)
        return base === undefined || member === undefined ? undefined : { ...base, members: [...base.members, member] }
      }
    }
  }
  return undefined
}

export function declarationModules(symbol) {
  return [...new Set((symbol?.declarations ?? []).map(declaration => {
    const file = slash(declaration.getSourceFile().fileName)
    const marker = '/node_modules/'
    const packageIndex = file.lastIndexOf(marker)
    if (packageIndex >= 0) return `package:${file.slice(packageIndex + marker.length)}`
    if (/\/typescript\/lib\/lib\.[^/]+\.d\.ts$/u.test(file)) return `typescript-lib:${file.slice(file.lastIndexOf('/') + 1)}`
    return file
  }))].sort(compareText)
}

export function callBinding(node, checker) {
  const call = callShape(node)
  if (call === undefined) return undefined
  const callee = unwrap(call.node.expression)
  const symbol = nodeSymbolForBinding(callee, checker)
  return {
    ...call,
    syntaxMethod: call.method,
    method: symbol?.getName() ?? call.method,
    symbol,
    declarationFiles: declarationModules(symbol),
    origin: bindingOrigin(callee, checker),
  }
}

function nodeSymbolForBinding(node, checker) {
  const value = unwrap(node)
  if (ts.isPropertyAccessExpression(value)) return symbolOf(value.name, checker)
  const symbol = symbolOf(value, checker)
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0]
  if (declaration !== undefined && ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
    return nodeSymbolForBinding(declaration.initializer, checker) ?? symbol
  }
  if (declaration !== undefined && ts.isBindingElement(declaration)) {
    const variable = declaration.parent.parent
    if (ts.isVariableDeclaration(variable) && variable.initializer !== undefined) {
      const member = propertyName(declaration.propertyName ?? declaration.name)
      return member === undefined ? symbol : checker.getTypeAtLocation(variable.initializer).getProperty(member) ?? symbol
    }
  }
  return symbol
}

export function symbolComesFrom(symbol, packageName) {
  const marker = `package:${packageName.replaceAll('\\', '/')}/`
  return declarationModules(symbol).some(file => file.startsWith(marker))
}

export function declarationKey(symbol) {
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0]
  if (declaration === undefined) return undefined
  return `${slash(resolve(declaration.getSourceFile().fileName))}:${declaration.pos}:${declaration.end}`
}

export function containingSymbol(node) {
  let current = node.parent
  while (current !== undefined) {
    if ((ts.isFunctionDeclaration(current) || ts.isClassDeclaration(current) || ts.isMethodDeclaration(current)) && current.name !== undefined) {
      return propertyName(current.name) ?? '<computed>'
    }
    current = current.parent
  }
  return '<module>'
}

export function visit(sourceFile, callback) {
  const walk = (node) => { callback(node); ts.forEachChild(node, walk) }
  walk(sourceFile)
}

export function callShape(node) {
  if (!ts.isCallExpression(node)) return undefined
  const expression = unwrap(node.expression)
  if (ts.isIdentifier(expression)) return { receiver: undefined, method: expression.text, arguments: node.arguments, node }
  if (ts.isPropertyAccessExpression(expression)) {
    return { receiver: expression.expression, method: expression.name.text, arguments: node.arguments, node }
  }
  return undefined
}

export function recordForNode(node, context) {
  return context.recordBySourceFile.get(node.getSourceFile())
}

export function fileOf(node, context) {
  return recordForNode(node, context)?.path ?? slash(relative(context.root, node.getSourceFile().fileName))
}

export function findDeclarations(records, predicate) {
  const found = []
  for (const record of records) visit(record.sourceFile, node => { if (predicate(node, record)) found.push({ node, record }) })
  return found
}

function identifierValue(node, context, stack) {
  const symbol = symbolOf(node, context.checker)
  const key = declarationKey(symbol)
  if (symbol === undefined || key === undefined || stack.has(key)) return undefined
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0]
  if (declaration === undefined) return undefined
  const next = new Set(stack)
  next.add(key)
  if (ts.isVariableDeclaration(declaration) || ts.isPropertyDeclaration(declaration) || ts.isEnumMember(declaration)) {
    return staticValue(declaration.initializer, context, next)
  }
  return undefined
}

/** Conservative compiler-symbol-backed evaluator. `undefined` means dynamic/unsupported. */
export function staticValue(input, context, stack = new Set()) {
  const node = unwrap(input)
  if (node === undefined) return undefined
  const primitive = literal(node)
  if (primitive !== undefined || node.kind === ts.SyntaxKind.NullKeyword) return primitive
  if (ts.isIdentifier(node)) return identifierValue(node, context, stack)
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const constant = context.checker.getConstantValue(node)
    if (constant !== undefined) return constant
    const symbol = symbolOf(ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression, context.checker)
    const bySymbol = identifierValue(ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression, context, stack)
    if (bySymbol !== undefined) return bySymbol
    const object = staticValue(node.expression, context, stack)
    const key = ts.isPropertyAccessExpression(node) ? node.name.text : staticValue(node.argumentExpression, context, stack)
    return object !== null && typeof object === 'object' && (typeof key === 'string' || typeof key === 'number')
      ? object[key] : undefined
  }
  if (ts.isArrayLiteralExpression(node)) {
    const result = []
    for (const element of node.elements) {
      if (ts.isSpreadElement(element)) {
        const value = staticValue(element.expression, context, stack)
        if (!Array.isArray(value)) return undefined
        result.push(...value)
      } else {
        const value = staticValue(element, context, stack)
        if (value === undefined) return undefined
        result.push(value)
      }
    }
    return result
  }
  if (ts.isObjectLiteralExpression(node)) {
    const result = {}
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) {
        const value = staticValue(property.expression, context, stack)
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
        Object.assign(result, value)
      } else if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
        const key = propertyName(property.name)
        if (key === undefined) return undefined
        const value = ts.isShorthandPropertyAssignment(property)
          ? identifierValue(property.name, context, stack) : staticValue(property.initializer, context, stack)
        if (value === undefined) return undefined
        result[key] = value
      } else return undefined
    }
    return result
  }
  if (ts.isCallExpression(node)) {
    const shape = callShape(node)
    if (shape?.method === 'freeze' || shape?.method === 'deepFreezeJson') return staticValue(shape.arguments[0], context, stack)
  }
  return undefined
}

export function literalUnion(typeNode) {
  if (typeNode === undefined) return []
  const node = ts.isParenthesizedTypeNode(typeNode) ? typeNode.type : typeNode
  const members = ts.isUnionTypeNode(node) ? node.types : [node]
  const values = []
  for (const member of members) {
    if (!ts.isLiteralTypeNode(member)) return []
    const value = literal(member.literal)
    if (value === undefined) return []
    values.push(value)
  }
  return values
}

export function makeDiagnostic(code, severity, file, symbol, detail) {
  return { code, severity, ...(file === undefined ? {} : { file }), ...(symbol === undefined ? {} : { symbol }), detail }
}

export function stableSort(items, extra = () => 0) {
  return items.sort((left, right) => compareText(left.file ?? '', right.file ?? '')
    || (left.anchor?.line ?? 0) - (right.anchor?.line ?? 0)
    || (left.anchor?.column ?? 0) - (right.anchor?.column ?? 0)
    || extra(left, right))
}
