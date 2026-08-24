import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx'])
const CODE_IMPORT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'])
const PROVIDER_METHOD = /^register[A-Za-z0-9_]*Provider$/u
const TOOL_NAME = /^agent_swarm_[a-z0-9_]+$/u

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function slash(value) {
  return value.replaceAll('\\', '/')
}

function sourcePosition(sourceFile, node) {
  const point = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  return { line: point.line + 1, column: point.character + 1 }
}

function diagnostic(code, severity, file, symbol, detail) {
  return {
    code,
    severity,
    ...(file === undefined ? {} : { file }),
    ...(symbol === undefined ? {} : { symbol }),
    detail,
  }
}

function sortDiagnostics(items) {
  return items.sort((left, right) =>
    compareText(left.code, right.code)
    || compareText(left.file ?? '', right.file ?? '')
    || compareText(left.symbol ?? '', right.symbol ?? '')
    || compareText(left.detail, right.detail))
}

export function diagnoseSourcePathIdentities(paths) {
  const diagnostics = []
  const exact = new Set()
  const folded = new Map()
  for (const rawPath of paths) {
    const path = slash(rawPath)
    const normalized = path.normalize('NFC')
    if (path !== normalized) {
      diagnostics.push(diagnostic(
        'KG_EXTRACT_PATH_NON_NFC',
        'error',
        path,
        undefined,
        `source path must be NFC; canonical form is ${JSON.stringify(normalized)}`,
      ))
    }
    if (exact.has(normalized)) {
      diagnostics.push(diagnostic('KG_EXTRACT_PATH_DUPLICATE', 'error', normalized, undefined, 'source path occurs more than once'))
    }
    exact.add(normalized)
    const key = normalized.toLowerCase()
    const previous = folded.get(key)
    if (previous !== undefined && previous !== normalized) {
      diagnostics.push(diagnostic(
        'KG_EXTRACT_PATH_CASE_COLLISION',
        'error',
        normalized,
        undefined,
        `case-folded source path collides with ${JSON.stringify(previous)}`,
      ))
    } else {
      folded.set(key, normalized)
    }
  }
  return sortDiagnostics(diagnostics)
}

function inside(parent, child) {
  const path = relative(parent, child)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

function samePath(left, right) {
  const leftPath = slash(resolve(left))
  const rightPath = slash(resolve(right))
  return process.platform === 'win32' ? leftPath.toLowerCase() === rightPath.toLowerCase() : leftPath === rightPath
}

async function inspectSourceInventory(rootInput) {
  const diagnostics = []
  const requestedRoot = resolve(rootInput)
  let requestedRootStat
  let root
  try {
    requestedRootStat = await lstat(requestedRoot)
    root = await realpath(requestedRoot)
  } catch (error) {
    diagnostics.push(diagnostic('KG_EXTRACT_REPOSITORY_REALPATH', 'error', undefined, undefined, error instanceof Error ? error.message : String(error)))
    return { root: requestedRoot, sourceRoot: join(requestedRoot, 'src'), files: [], diagnostics }
  }
  if (requestedRootStat.isSymbolicLink() || !samePath(requestedRoot, root)) {
    diagnostics.push(diagnostic('KG_EXTRACT_REPOSITORY_REPARSE_POINT', 'error', undefined, undefined, 'repository root must not be a symlink, junction, or reparse redirect'))
    return { root, sourceRoot: join(root, 'src'), files: [], diagnostics }
  }
  const sourcePath = join(root, 'src')
  let sourceStat
  let sourceRoot
  try {
    sourceStat = await lstat(sourcePath)
    sourceRoot = await realpath(sourcePath)
  } catch (error) {
    diagnostics.push(diagnostic('KG_EXTRACT_SOURCE_ROOT', 'error', 'src', undefined, error instanceof Error ? error.message : String(error)))
    return { root, sourceRoot: sourcePath, files: [], diagnostics }
  }
  if (sourceStat.isSymbolicLink() || !samePath(sourcePath, sourceRoot)) {
    diagnostics.push(diagnostic('KG_EXTRACT_SOURCE_REPARSE_POINT', 'error', 'src', undefined, 'source root must not be a symlink, junction, or reparse redirect'))
    return { root, sourceRoot, files: [], diagnostics }
  }
  if (!sourceStat.isDirectory()) {
    diagnostics.push(diagnostic('KG_EXTRACT_SOURCE_ROOT', 'error', 'src', undefined, 'source root is not a directory'))
    return { root, sourceRoot, files: [], diagnostics }
  }
  const files = []
  async function walk(directory) {
    let directoryStat
    let directoryReal
    try {
      directoryStat = await lstat(directory)
      directoryReal = await realpath(directory)
    } catch (error) {
      diagnostics.push(diagnostic('KG_EXTRACT_SOURCE_ENTRY', 'error', slash(relative(root, directory)), undefined, error instanceof Error ? error.message : String(error)))
      return
    }
    const directoryPath = slash(relative(root, directory))
    if (directoryStat.isSymbolicLink() || !samePath(directory, directoryReal)) {
      diagnostics.push(diagnostic('KG_EXTRACT_SOURCE_REPARSE_POINT', 'error', directoryPath, undefined, 'source ancestor must not be a symlink, junction, or reparse redirect'))
      return
    }
    if (!inside(sourceRoot, directoryReal)) {
      diagnostics.push(diagnostic('KG_EXTRACT_SOURCE_ESCAPE', 'error', directoryPath, undefined, 'source ancestor realpath escapes canonical src'))
      return
    }
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      diagnostics.push(diagnostic('KG_EXTRACT_SOURCE_ENTRY', 'error', directoryPath, undefined, error instanceof Error ? error.message : String(error)))
      return
    }
    entries.sort((left, right) => compareText(left.name, right.name))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      const entryPath = slash(relative(root, path))
      let entryStat
      try {
        entryStat = await lstat(path)
      } catch (error) {
        diagnostics.push(diagnostic('KG_EXTRACT_SOURCE_ENTRY', 'error', entryPath, undefined, error instanceof Error ? error.message : String(error)))
        continue
      }
      if (entry.isSymbolicLink() || entryStat.isSymbolicLink()) {
        diagnostics.push(diagnostic('KG_EXTRACT_SOURCE_REPARSE_POINT', 'error', entryPath, undefined, 'source entry must not be a symlink, junction, or reparse redirect'))
        continue
      }
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      if (!entry.isFile()) continue
      let entryReal
      try {
        entryReal = await realpath(path)
      } catch (error) {
        diagnostics.push(diagnostic('KG_EXTRACT_SOURCE_ENTRY', 'error', entryPath, undefined, error instanceof Error ? error.message : String(error)))
        continue
      }
      if (!samePath(path, entryReal)) {
        diagnostics.push(diagnostic('KG_EXTRACT_SOURCE_REPARSE_POINT', 'error', entryPath, undefined, 'source file must not be a reparse redirect'))
        continue
      }
      if (!inside(sourceRoot, entryReal)) {
        diagnostics.push(diagnostic('KG_EXTRACT_SOURCE_ESCAPE', 'error', entryPath, undefined, 'source file realpath escapes canonical src'))
        continue
      }
      if (SOURCE_EXTENSIONS.has(extname(entry.name))) files.push(entryReal)
    }
  }
  await walk(sourceRoot)
  return { root, sourceRoot, files, diagnostics }
}

function unwrapExpression(node) {
  let current = node
  while (
    ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isParenthesizedExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isNonNullExpression(current)
  ) current = current.expression
  return current
}

function literalText(node) {
  const value = unwrapExpression(node)
  return ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value) ? value.text : undefined
}

function propertyNameText(name) {
  if (name === undefined) return undefined
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  return undefined
}

function containingSymbol(node) {
  let current = node.parent
  while (current !== undefined) {
    if (ts.isFunctionDeclaration(current) && current.name !== undefined) return current.name.text
    if (ts.isMethodDeclaration(current) && current.name !== undefined) return propertyNameText(current.name)
    if (ts.isClassDeclaration(current) && current.name !== undefined) return current.name.text
    current = current.parent
  }
  return '<module>'
}

function containingFunctionDeclaration(node) {
  let current = node.parent
  while (current !== undefined) {
    if (ts.isFunctionDeclaration(current)) return current
    current = current.parent
  }
  return undefined
}

function importOrigin(identifier, checker) {
  const localSymbol = checker.getSymbolAtLocation(identifier)
  if (localSymbol === undefined || (localSymbol.flags & ts.SymbolFlags.Alias) === 0) return undefined
  const declaration = localSymbol.declarations?.find(item => ts.isImportSpecifier(item))
  if (declaration === undefined || !ts.isImportSpecifier(declaration)) return undefined
  let importDeclaration = declaration.parent
  while (importDeclaration !== undefined && !ts.isImportDeclaration(importDeclaration)) importDeclaration = importDeclaration.parent
  if (importDeclaration === undefined || !ts.isStringLiteral(importDeclaration.moduleSpecifier)) return undefined
  let targetSymbol
  try {
    targetSymbol = checker.getAliasedSymbol(localSymbol)
  } catch {
    targetSymbol = undefined
  }
  return {
    importedName: declaration.propertyName?.text ?? declaration.name.text,
    moduleSpecifier: importDeclaration.moduleSpecifier.text,
    targetSymbol,
  }
}

function resolvedSymbol(identifier, checker) {
  const symbol = checker.getSymbolAtLocation(identifier)
  if (symbol === undefined) return undefined
  if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol
  try {
    return checker.getAliasedSymbol(symbol)
  } catch {
    return undefined
  }
}

function visit(sourceFile, callback) {
  function walk(node) {
    callback(node)
    ts.forEachChild(node, walk)
  }
  walk(sourceFile)
}

function relativeSourceCandidates(fromFile, specifier) {
  if (!specifier.startsWith('.')) return []
  const base = resolve(dirname(fromFile), specifier)
  const candidates = [base]
  const extension = extname(base)
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(extension)) {
    const stem = base.slice(0, -extension.length)
    candidates.push(`${stem}.ts`, `${stem}.tsx`)
  } else if (extension === '') {
    candidates.push(`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx'))
  }
  return candidates
}

function resolveRelativeSource(fromFile, specifier, sourceFilesByAbsolutePath) {
  if (!specifier.startsWith('.')) return undefined
  for (const candidate of relativeSourceCandidates(fromFile, specifier)) {
    const key = slash(resolve(candidate))
    if (sourceFilesByAbsolutePath.has(key)) return sourceFilesByAbsolutePath.get(key)
  }
  return undefined
}

function collectStaticContext(sourceRecords) {
  const declarations = new Map()
  const imports = new Map()
  for (const record of sourceRecords) {
    const localImports = new Map()
    for (const statement of record.sourceFile.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declarationNode of statement.declarationList.declarations) {
          if (ts.isIdentifier(declarationNode.name) && declarationNode.initializer !== undefined) {
            declarations.set(`${record.path}#${declarationNode.name.text}`, declarationNode.initializer)
          }
        }
      }
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
      const clause = statement.importClause
      if (clause?.name !== undefined) {
        localImports.set(clause.name.text, { imported: 'default', specifier: statement.moduleSpecifier.text })
      }
      if (clause?.namedBindings !== undefined) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          localImports.set(clause.namedBindings.name.text, { imported: '*', specifier: statement.moduleSpecifier.text })
        } else {
          for (const element of clause.namedBindings.elements) {
            localImports.set(element.name.text, {
              imported: element.propertyName?.text ?? element.name.text,
              specifier: statement.moduleSpecifier.text,
            })
          }
        }
      }
    }
    imports.set(record.path, localImports)
  }
  return { declarations, imports }
}

function evaluateStringArray(expression, record, context, diagnostics, purpose, stack = new Set()) {
  const node = unwrapExpression(expression)
  if (ts.isArrayLiteralExpression(node)) {
    const values = []
    for (const element of node.elements) {
      if (ts.isSpreadElement(element)) {
        const spread = evaluateStringArray(element.expression, record, context, diagnostics, purpose, stack)
        if (spread === undefined) return undefined
        values.push(...spread)
        continue
      }
      const value = literalText(element)
      if (value === undefined) {
        diagnostics.push(diagnostic(
          `KG_EXTRACT_DYNAMIC_${purpose}`,
          'error',
          record.path,
          containingSymbol(node),
          `array element at ${JSON.stringify(sourcePosition(record.sourceFile, element))} is not a string literal`,
        ))
        return undefined
      }
      values.push(value)
    }
    return values
  }
  if (ts.isIdentifier(node)) {
    let declarationFile = record.path
    let declarationName = node.text
    const imported = context.imports.get(record.path)?.get(node.text)
    if (imported !== undefined) {
      const target = resolveRelativeSource(record.absolutePath, imported.specifier, context.sourcesByAbsolutePath)
      if (target === undefined || imported.imported === '*' || imported.imported === 'default') {
        diagnostics.push(diagnostic(
          `KG_EXTRACT_DYNAMIC_${purpose}`,
          'error',
          record.path,
          node.text,
          `cannot statically resolve imported array ${JSON.stringify(imported.specifier)}`,
        ))
        return undefined
      }
      declarationFile = target.path
      declarationName = imported.imported
      record = target
    }
    const key = `${declarationFile}#${declarationName}`
    if (stack.has(key)) {
      diagnostics.push(diagnostic(`KG_EXTRACT_DYNAMIC_${purpose}`, 'error', declarationFile, declarationName, 'cyclic static array reference'))
      return undefined
    }
    const initializer = context.declarations.get(key)
    if (initializer === undefined) {
      diagnostics.push(diagnostic(
        `KG_EXTRACT_DYNAMIC_${purpose}`,
        'error',
        declarationFile,
        declarationName,
        'array identifier has no statically visible initializer',
      ))
      return undefined
    }
    const nextStack = new Set(stack)
    nextStack.add(key)
    return evaluateStringArray(initializer, record, context, diagnostics, purpose, nextStack)
  }
  diagnostics.push(diagnostic(
    `KG_EXTRACT_DYNAMIC_${purpose}`,
    'error',
    record.path,
    containingSymbol(node),
    `expected a string array, got ${ts.SyntaxKind[node.kind]}`,
  ))
  return undefined
}

function importKind(specifier) {
  if (!specifier.startsWith('.')) return 'external'
  const extension = extname(specifier).toLowerCase()
  return extension !== '' && !CODE_IMPORT_EXTENSIONS.has(extension) ? 'asset' : 'source'
}

function importNames(clause) {
  if (clause === undefined) return []
  const names = []
  if (clause.name !== undefined) names.push({ imported: 'default', local: clause.name.text, typeOnly: clause.isTypeOnly })
  if (clause.namedBindings !== undefined) {
    if (ts.isNamespaceImport(clause.namedBindings)) {
      names.push({ imported: '*', local: clause.namedBindings.name.text, typeOnly: clause.isTypeOnly })
    } else {
      for (const element of clause.namedBindings.elements) {
        names.push({
          imported: element.propertyName?.text ?? element.name.text,
          local: element.name.text,
          typeOnly: clause.isTypeOnly || element.isTypeOnly,
        })
      }
    }
  }
  return names.sort((left, right) => compareText(left.local, right.local))
}

function diagnoseRelativeImportIdentity(record, specifier, context, diagnostics) {
  if (!specifier.startsWith('.') || importKind(specifier) !== 'source') return
  if (resolveRelativeSource(record.absolutePath, specifier, context.sourcesByAbsolutePath) !== undefined) return
  for (const candidate of relativeSourceCandidates(record.absolutePath, specifier)) {
    const requested = slash(resolve(candidate))
    const actual = context.sourcesByFoldedAbsolutePath.get(requested.toLowerCase())
    if (actual !== undefined) {
      diagnostics.push(diagnostic(
        'KG_EXTRACT_IMPORT_CASE_MISMATCH',
        'error',
        record.path,
        specifier,
        `relative import casing does not match ${JSON.stringify(actual.path)}`,
      ))
      return
    }
  }
}

function extractModuleFacts(record, context, diagnostics) {
  const imports = []
  let importOrder = 0
  visit(record.sourceFile, (node) => {
    if (ts.isImportDeclaration(node)) {
      importOrder += 1
      if (!ts.isStringLiteral(node.moduleSpecifier)) {
        diagnostics.push(diagnostic('KG_EXTRACT_DYNAMIC_IMPORT', 'notice', record.path, containingSymbol(node), 'import specifier is not a string literal'))
        return
      }
      diagnoseRelativeImportIdentity(record, node.moduleSpecifier.text, context, diagnostics)
      imports.push({
        kind: importKind(node.moduleSpecifier.text),
        specifier: node.moduleSpecifier.text,
        order: importOrder,
        typeOnly: node.importClause?.isTypeOnly ?? false,
        bindings: importNames(node.importClause),
      })
      return
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = node.arguments[0] === undefined ? undefined : literalText(node.arguments[0])
      if (specifier === undefined) {
        diagnostics.push(diagnostic('KG_EXTRACT_DYNAMIC_IMPORT', 'notice', record.path, containingSymbol(node), 'dynamic import specifier is not a string literal'))
      } else {
        importOrder += 1
        imports.push({ kind: importKind(specifier), specifier, order: importOrder, typeOnly: false, bindings: [], dynamic: true })
      }
    }
  })
  return { id: `module:${record.path}`, path: record.path, imports }
}

function extractToolDefinitions(sourceRecords, checker, diagnostics) {
  const definitions = []
  const byFunctionSymbol = new Map()
  for (const record of sourceRecords) {
    let definitionOrder = 0
    visit(record.sourceFile, (node) => {
      if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return
      const origin = importOrigin(node.expression, checker)
      const candidate = node.expression.text === 'defineTool' || origin?.importedName === 'defineTool'
      if (!candidate) return
      const official = origin?.importedName === 'defineTool'
        && origin.moduleSpecifier === '@deepseek-ai/dsh-tools'
        && origin.targetSymbol !== undefined
        && (origin.targetSymbol.declarations?.length ?? 0) > 0
      if (!official) {
        diagnostics.push(diagnostic(
          'KG_EXTRACT_DEFINE_TOOL_SOURCE',
          'error',
          record.path,
          containingSymbol(node),
          'defineTool-like call is not a resolved alias of @deepseek-ai/dsh-tools#defineTool',
        ))
        return
      }
      definitionOrder += 1
      const configuration = node.arguments[0] === undefined ? undefined : unwrapExpression(node.arguments[0])
      if (configuration === undefined || !ts.isObjectLiteralExpression(configuration)) {
        diagnostics.push(diagnostic('KG_EXTRACT_DYNAMIC_TOOL_DEFINITION', 'error', record.path, containingSymbol(node), 'defineTool argument is not an object literal'))
        return
      }
      const nameProperty = configuration.properties.find(property =>
        ts.isPropertyAssignment(property) && propertyNameText(property.name) === 'name')
      const name = nameProperty === undefined ? undefined : literalText(nameProperty.initializer)
      if (name === undefined) {
        diagnostics.push(diagnostic('KG_EXTRACT_DYNAMIC_TOOL_NAME', 'error', record.path, containingSymbol(node), 'defineTool.name is not a string literal'))
        return
      }
      if (!TOOL_NAME.test(name)) {
        diagnostics.push(diagnostic('KG_EXTRACT_TOOL_NAME_INVALID', 'error', record.path, containingSymbol(node), `invalid tool name ${JSON.stringify(name)}`))
      }
      const fact = {
        name,
        file: record.path,
        containingFunction: containingSymbol(node),
        definitionOrder,
        anchor: sourcePosition(record.sourceFile, node),
      }
      definitions.push(fact)
      const functionDeclaration = containingFunctionDeclaration(node)
      const functionSymbol = functionDeclaration?.name === undefined ? undefined : checker.getSymbolAtLocation(functionDeclaration.name)
      if (functionSymbol === undefined) {
        diagnostics.push(diagnostic('KG_EXTRACT_TOOL_CONTAINER_SYMBOL', 'error', record.path, fact.containingFunction, 'tool container has no TypeChecker symbol'))
      } else {
        const previous = byFunctionSymbol.get(functionSymbol)
        if (previous !== undefined) {
          diagnostics.push(diagnostic(
            'KG_EXTRACT_TOOL_REGISTRATION_FUNCTION_AMBIGUOUS',
            'error',
            record.path,
            fact.containingFunction,
            `registration function contains both ${previous.name} and ${fact.name}`,
          ))
          byFunctionSymbol.set(functionSymbol, null)
        } else {
          byFunctionSymbol.set(functionSymbol, fact)
        }
      }
    })
  }
  const byName = new Map()
  for (const definition of definitions) {
    const previous = byName.get(definition.name)
    if (previous !== undefined) {
      diagnostics.push(diagnostic(
        'KG_EXTRACT_TOOL_DUPLICATE',
        'error',
        definition.file,
        definition.name,
        `tool is also defined by ${previous.file}#${previous.containingFunction}`,
      ))
    } else {
      byName.set(definition.name, definition)
    }
  }
  return { definitions, byName, byFunctionSymbol }
}

function extractRegistrationOrder(sourceRecords, checker, definitionByName, definitionsByFunctionSymbol, diagnostics) {
  const toolsModule = sourceRecords.find(record => record.path === 'src/tools.ts')
  if (toolsModule === undefined) {
    diagnostics.push(diagnostic('KG_EXTRACT_TOOL_REGISTRY_MISSING', 'error', 'src/tools.ts', 'registerAgentSwarmTools', 'registry module is missing'))
    return []
  }
  let rootFunction
  visit(toolsModule.sourceFile, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'registerAgentSwarmTools') rootFunction = node
  })
  if (rootFunction?.body === undefined) {
    diagnostics.push(diagnostic('KG_EXTRACT_TOOL_REGISTRY_MISSING', 'error', toolsModule.path, 'registerAgentSwarmTools', 'registry function is missing or has no body'))
    return []
  }
  const registrations = []
  for (const statement of rootFunction.body.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression) || !ts.isIdentifier(statement.expression.expression)) continue
    const localCall = statement.expression.expression.text
    const callSymbol = resolvedSymbol(statement.expression.expression, checker)
    const definition = callSymbol === undefined ? undefined : definitionsByFunctionSymbol.get(callSymbol)
    if (definition === undefined || definition === null) {
      diagnostics.push(diagnostic(
        'KG_EXTRACT_TOOL_REGISTRATION_UNKNOWN',
        'error',
        toolsModule.path,
        localCall,
        'registration call symbol does not bind to exactly one extracted defineTool container declaration',
      ))
      continue
    }
    registrations.push({
      toolName: definition.name,
      registrationFunction: definition.containingFunction,
      localCall,
      registrationOrder: registrations.length + 1,
      anchor: sourcePosition(toolsModule.sourceFile, statement),
    })
  }
  const seen = new Set()
  for (const registration of registrations) {
    if (seen.has(registration.toolName)) {
      diagnostics.push(diagnostic('KG_EXTRACT_TOOL_REGISTERED_TWICE', 'error', toolsModule.path, registration.toolName, 'tool appears more than once in registerAgentSwarmTools'))
    }
    seen.add(registration.toolName)
  }
  for (const definition of definitionByName.values()) {
    if (!seen.has(definition.name)) {
      diagnostics.push(diagnostic('KG_EXTRACT_TOOL_UNREGISTERED', 'error', definition.file, definition.name, 'defineTool is absent from registerAgentSwarmTools'))
    }
  }
  return registrations
}

function findConstInitializer(record, name) {
  for (const statement of record.sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration.initializer
    }
  }
  return undefined
}

function extractPermissionPolicy(sourceRecords, context, diagnostics) {
  const record = sourceRecords.find(item => item.path === 'src/runtime/permission-policy.ts')
  if (record === undefined) {
    diagnostics.push(diagnostic('KG_EXTRACT_PERMISSION_POLICY_MISSING', 'error', 'src/runtime/permission-policy.ts', 'PLUGIN_TOOL_NAMES', 'permission policy module is missing'))
    return { file: 'src/runtime/permission-policy.ts', names: [] }
  }
  const initializer = findConstInitializer(record, 'PLUGIN_TOOL_NAMES')
  if (initializer === undefined) {
    diagnostics.push(diagnostic('KG_EXTRACT_PERMISSION_POLICY_MISSING', 'error', record.path, 'PLUGIN_TOOL_NAMES', 'permission tool array is missing'))
    return { file: record.path, names: [] }
  }
  const names = evaluateStringArray(initializer, record, context, diagnostics, 'PERMISSION_POLICY') ?? []
  const seen = new Set()
  for (const name of names) {
    if (seen.has(name)) diagnostics.push(diagnostic('KG_EXTRACT_PERMISSION_DUPLICATE', 'error', record.path, name, 'permission policy repeats a tool'))
    seen.add(name)
  }
  return { file: record.path, names }
}

function propertyCall(node) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return undefined
  return { receiver: node.expression.expression, method: node.expression.name.text, arguments: node.arguments }
}

function isContextReceiver(node) {
  if (ts.isIdentifier(node)) return /ctx$/iu.test(node.text)
  return ts.isPropertyAccessExpression(node) && node.name.text === 'ctx'
}

function extractDependencyAndProviderFacts(sourceRecords, context, diagnostics) {
  const injections = []
  const providerRegistrations = []
  const providerRegistryMethods = []
  for (const record of sourceRecords) {
    for (const statement of record.sourceFile.statements) {
      if (ts.isVariableStatement(statement)) {
        const exported = statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false
        if (!exported) continue
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'inject' || declaration.initializer === undefined) continue
          const services = evaluateStringArray(declaration.initializer, record, context, diagnostics, 'STATIC_INJECT')
          for (const service of services ?? []) {
            injections.push({ kind: 'static-inject', mode: 'required', service, file: record.path, containingSymbol: '<module>', anchor: sourcePosition(record.sourceFile, declaration) })
          }
        }
      }
      if (ts.isClassDeclaration(statement)) {
        for (const member of statement.members) {
          if (!ts.isPropertyDeclaration(member) || propertyNameText(member.name) !== 'inject' || member.initializer === undefined) continue
          const isStatic = member.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword) ?? false
          if (!isStatic) continue
          const services = evaluateStringArray(member.initializer, record, context, diagnostics, 'STATIC_INJECT')
          for (const service of services ?? []) {
            injections.push({ kind: 'static-inject', mode: 'required', service, file: record.path, containingSymbol: statement.name?.text ?? '<anonymous-class>', anchor: sourcePosition(record.sourceFile, member) })
          }
        }
      }
    }
    visit(record.sourceFile, (node) => {
      if (ts.isMethodDeclaration(node)) {
        const method = propertyNameText(node.name)
        if (method !== undefined && (method === 'registerProvider' || PROVIDER_METHOD.test(method))) {
          providerRegistryMethods.push({ methodSymbol: method, file: record.path, containingSymbol: containingSymbol(node), anchor: sourcePosition(record.sourceFile, node) })
        }
      }
      const call = propertyCall(node)
      if (call === undefined) return
      const contextCall = isContextReceiver(call.receiver)
      if (contextCall && ['provide', 'get'].includes(call.method)) {
        const service = call.arguments[0] === undefined ? undefined : literalText(call.arguments[0])
        if (service === undefined) {
          diagnostics.push(diagnostic('KG_EXTRACT_DYNAMIC_SERVICE_NAME', 'notice', record.path, containingSymbol(node), `${call.method} service name is not a string literal`))
        } else {
          injections.push({
            kind: call.method === 'provide' ? 'ctx-provide' : 'ctx-get',
            mode: call.method === 'get' ? 'optional' : 'provided',
            service,
            file: record.path,
            containingSymbol: containingSymbol(node),
            anchor: sourcePosition(record.sourceFile, node),
          })
        }
      }
      if (contextCall && call.method === 'inject') {
        const services = call.arguments[0] === undefined
          ? undefined
          : evaluateStringArray(call.arguments[0], record, context, diagnostics, 'CTX_INJECT')
        for (const service of services ?? []) {
          injections.push({ kind: 'ctx-inject', mode: 'optional', service, file: record.path, containingSymbol: containingSymbol(node), anchor: sourcePosition(record.sourceFile, node) })
        }
      }
      if (call.method === 'registerProvider' || PROVIDER_METHOD.test(call.method)) {
        const providerName = call.arguments[0] === undefined ? undefined : literalText(call.arguments[0])
        if (providerName === undefined) {
          diagnostics.push(diagnostic(
            'KG_EXTRACT_DYNAMIC_PROVIDER_NAME',
            'notice',
            record.path,
            containingSymbol(node),
            `${call.method} Provider identity is runtime-derived`,
          ))
        }
        providerRegistrations.push({
          methodSymbol: call.method,
          file: record.path,
          containingSymbol: containingSymbol(node),
          providerName: providerName ?? null,
          staticName: providerName !== undefined,
          receiverSymbol: call.receiver.getText(record.sourceFile),
          anchor: sourcePosition(record.sourceFile, node),
        })
      }
    })
  }
  const sorter = (left, right) => compareText(left.file, right.file) || left.anchor.line - right.anchor.line || left.anchor.column - right.anchor.column
  injections.sort(sorter)
  providerRegistrations.sort(sorter)
  providerRegistryMethods.sort(sorter)
  return { injections, providerRegistrations, providerRegistryMethods }
}

function flattenPackageExports(exportsValue, key = '.') {
  if (typeof exportsValue === 'string') return [{ subpath: key, condition: 'default', target: exportsValue }]
  if (exportsValue === null || typeof exportsValue !== 'object' || Array.isArray(exportsValue)) return []
  const entries = []
  for (const [name, value] of Object.entries(exportsValue)) {
    if (name.startsWith('.')) entries.push(...flattenPackageExports(value, name))
    else if (typeof value === 'string') entries.push({ subpath: key, condition: name, target: value })
    else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const nested of flattenPackageExports(value, key)) entries.push({ ...nested, condition: `${name}/${nested.condition}` })
    }
  }
  return entries.sort((left, right) => compareText(left.subpath, right.subpath) || compareText(left.condition, right.condition))
}

async function extractExports(root, sourceRecords, diagnostics) {
  let packageExports = []
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    packageExports = flattenPackageExports(pkg.exports)
  } catch (error) {
    diagnostics.push(diagnostic('KG_EXTRACT_PACKAGE_JSON', 'error', 'package.json', 'exports', error instanceof Error ? error.message : String(error)))
  }
  const publicApi = sourceRecords.find(record => record.path === 'src/public-api.ts')
  const publicApiExports = []
  if (publicApi === undefined) {
    diagnostics.push(diagnostic('KG_EXTRACT_PUBLIC_API_MISSING', 'error', 'src/public-api.ts', undefined, 'public API module is missing'))
  } else {
    let order = 0
    for (const statement of publicApi.sourceFile.statements) {
      if (!ts.isExportDeclaration(statement)) continue
      order += 1
      const moduleSpecifier = statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : null
      if (statement.moduleSpecifier !== undefined && moduleSpecifier === null) {
        diagnostics.push(diagnostic('KG_EXTRACT_DYNAMIC_PUBLIC_EXPORT', 'error', publicApi.path, undefined, 'public export module specifier is dynamic'))
      }
      const names = []
      if (statement.exportClause === undefined) names.push({ exported: '*', local: '*', typeOnly: statement.isTypeOnly })
      else if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          names.push({ exported: element.name.text, local: element.propertyName?.text ?? element.name.text, typeOnly: statement.isTypeOnly || element.isTypeOnly })
        }
      } else {
        names.push({ exported: statement.exportClause.name.text, local: '*', typeOnly: statement.isTypeOnly })
      }
      names.sort((left, right) => compareText(left.exported, right.exported))
      publicApiExports.push({ order, moduleSpecifier, names, anchor: sourcePosition(publicApi.sourceFile, statement) })
    }
  }
  return { packageExports, publicApiExports }
}

function compareSets(left, right) {
  const leftOnly = [...left].filter(item => !right.has(item)).sort(compareText)
  const rightOnly = [...right].filter(item => !left.has(item)).sort(compareText)
  return { leftOnly, rightOnly }
}

export async function extractSourceFacts(rootInput, options = {}) {
  const inventory = await inspectSourceInventory(rootInput)
  const root = inventory.root
  const discoveredAbsolutePaths = inventory.files
  const discoveredPaths = discoveredAbsolutePaths.map(path => slash(relative(root, path)))
  const diagnostics = [...inventory.diagnostics, ...diagnoseSourcePathIdentities(discoveredPaths)]
  const discoveredByPath = new Map(discoveredAbsolutePaths.map(path => [slash(relative(root, path)), path]))
  const requestedPaths = options.sourceFiles === undefined
    ? discoveredPaths
    : options.sourceFiles.map(path => slash(relative(root, isAbsolute(path) ? resolve(path) : resolve(root, path))))
  const selectedAbsolutePaths = []
  const selectedPaths = []
  for (const requestedPath of requestedPaths) {
    const path = discoveredByPath.get(requestedPath)
    if (path === undefined) continue
    selectedPaths.push(requestedPath)
    selectedAbsolutePaths.push(path)
  }
  const coverage = compareSets(new Set(discoveredPaths), new Set(selectedPaths))
  for (const path of coverage.leftOnly) diagnostics.push(diagnostic('KG_EXTRACT_MODULE_UNCOVERED', 'error', path, undefined, 'discovered source file was not parsed'))
  for (const path of coverage.rightOnly) diagnostics.push(diagnostic('KG_EXTRACT_MODULE_OUTSIDE_INVENTORY', 'error', path, undefined, 'selected source file is outside discovered src inventory'))
  for (const path of requestedPaths) {
    if (!discoveredByPath.has(path)) diagnostics.push(diagnostic('KG_EXTRACT_MODULE_OUTSIDE_INVENTORY', 'error', path, undefined, 'selected source file is outside exact canonical src inventory'))
  }

  let compilerOptions = {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    jsx: ts.JsxEmit.ReactJSX,
    noEmit: true,
  }
  const configPath = join(root, 'tsconfig.json')
  if (ts.sys.fileExists(configPath)) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile)
    if (config.error !== undefined) {
      diagnostics.push(diagnostic('KG_EXTRACT_TYPESCRIPT_CONFIG', 'error', 'tsconfig.json', undefined, ts.flattenDiagnosticMessageText(config.error.messageText, '\n')))
    } else {
      const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
      for (const configDiagnostic of parsed.errors) {
        diagnostics.push(diagnostic('KG_EXTRACT_TYPESCRIPT_CONFIG', 'error', 'tsconfig.json', undefined, ts.flattenDiagnosticMessageText(configDiagnostic.messageText, '\n')))
      }
      compilerOptions = { ...parsed.options, noEmit: true }
    }
  }
  const compilerHost = ts.createCompilerHost(compilerOptions, true)
  const getSourceFile = compilerHost.getSourceFile.bind(compilerHost)
  compilerHost.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const path = resolve(fileName)
    const sourceCode = SOURCE_EXTENSIONS.has(extname(path)) && !path.endsWith('.d.ts')
    if (sourceCode && !inside(inventory.sourceRoot, path)) return undefined
    return getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
  }
  const program = ts.createProgram({ rootNames: selectedAbsolutePaths, options: compilerOptions, host: compilerHost })
  const checker = program.getTypeChecker()
  const sourceRecords = []
  for (const absolutePath of selectedAbsolutePaths.sort((left, right) => compareText(slash(relative(root, left)), slash(relative(root, right))))) {
    const path = slash(relative(root, absolutePath)).normalize('NFC')
    const sourceFile = program.getSourceFile(absolutePath)
    if (sourceFile === undefined) {
      diagnostics.push(diagnostic('KG_EXTRACT_SOURCE_READ', 'error', path, undefined, 'TypeScript Program did not materialize canonical source entry'))
      continue
    }
    for (const parseDiagnostic of program.getSyntacticDiagnostics(sourceFile)) {
      diagnostics.push(diagnostic('KG_EXTRACT_TYPESCRIPT_PARSE', 'error', path, undefined, ts.flattenDiagnosticMessageText(parseDiagnostic.messageText, '\n')))
    }
    sourceRecords.push({ absolutePath, path, sourceFile })
  }
  const sourcesByAbsolutePath = new Map(sourceRecords.map(record => [slash(resolve(record.absolutePath)), record]))
  const sourcesByFoldedAbsolutePath = new Map(sourceRecords.map(record => [slash(resolve(record.absolutePath)).toLowerCase(), record]))
  const staticContext = collectStaticContext(sourceRecords)
  const context = { ...staticContext, sourcesByAbsolutePath, sourcesByFoldedAbsolutePath }
  const modules = sourceRecords.map(record => extractModuleFacts(record, context, diagnostics)).sort((left, right) => compareText(left.path, right.path))
  const { definitions, byName, byFunctionSymbol } = extractToolDefinitions(sourceRecords, checker, diagnostics)
  const registrations = extractRegistrationOrder(sourceRecords, checker, byName, byFunctionSymbol, diagnostics)
  const permissionPolicy = extractPermissionPolicy(sourceRecords, context, diagnostics)
  const registeredNames = new Set(registrations.map(item => item.toolName))
  const permissionNames = new Set(permissionPolicy.names)
  const policyDiff = compareSets(registeredNames, permissionNames)
  for (const name of policyDiff.leftOnly) diagnostics.push(diagnostic('KG_EXTRACT_PERMISSION_TOOL_MISSING', 'error', permissionPolicy.file, name, 'registered tool is absent from permission policy'))
  for (const name of policyDiff.rightOnly) diagnostics.push(diagnostic('KG_EXTRACT_PERMISSION_TOOL_EXTRA', 'error', permissionPolicy.file, name, 'permission policy names a tool that is not registered'))
  const expectedToolCount = options.expectedToolCount ?? 19
  if (registrations.length !== expectedToolCount) {
    diagnostics.push(diagnostic('KG_EXTRACT_TOOL_COUNT', 'error', 'src/tools.ts', 'registerAgentSwarmTools', `expected ${expectedToolCount} registered tools, found ${registrations.length}`))
  }
  const toolDefinitionsByName = new Map(definitions.map(item => [item.name, item]))
  const tools = registrations.map(registration => ({ ...toolDefinitionsByName.get(registration.toolName), ...registration }))
  const dependenciesAndProviders = extractDependencyAndProviderFacts(sourceRecords, context, diagnostics)
  const exportsFacts = await extractExports(root, sourceRecords, diagnostics)
  sortDiagnostics(diagnostics)
  return {
    schemaVersion: 1,
    extractor: { compiler: 'typescript', compilerVersion: ts.version },
    sourceRoot: 'src',
    counts: {
      discoveredModules: discoveredPaths.length,
      parsedModules: modules.length,
      toolDefinitions: definitions.length,
      tools: tools.length,
      imports: modules.reduce((sum, item) => sum + item.imports.length, 0),
      injections: dependenciesAndProviders.injections.length,
      providerRegistrations: dependenciesAndProviders.providerRegistrations.length,
      providerRegistryMethods: dependenciesAndProviders.providerRegistryMethods.length,
      packageExports: exportsFacts.packageExports.length,
      publicApiExportDeclarations: exportsFacts.publicApiExports.length,
    },
    modules,
    toolDefinitions: definitions,
    tools,
    toolRegistrationOrder: registrations,
    permissionPolicy,
    ...dependenciesAndProviders,
    ...exportsFacts,
    diagnostics,
  }
}

function parseArguments(argv) {
  let root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
  let pretty = false
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--pretty') pretty = true
    else if (argv[index] === '--root' && argv[index + 1] !== undefined) root = resolve(argv[++index])
    else throw new Error(`usage: extract-source.mjs [--root PATH] [--pretty]; unknown argument ${JSON.stringify(argv[index])}`)
  }
  return { root, pretty }
}

async function main() {
  const { root, pretty } = parseArguments(process.argv.slice(2))
  const facts = await extractSourceFacts(root)
  process.stdout.write(`${JSON.stringify(facts, null, pretty ? 2 : 0)}\n`)
  if (facts.diagnostics.some(item => item.severity === 'error')) process.exitCode = 1
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main()
}
