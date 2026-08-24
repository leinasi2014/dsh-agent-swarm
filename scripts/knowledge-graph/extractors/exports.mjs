import { extname, join, relative, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { anchor, compareText, makeDiagnostic, slash } from './ast.mjs'

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

function resolvedModuleFact(statement, record, context, diagnostics) {
  if (statement.moduleSpecifier === undefined || !ts.isStringLiteral(statement.moduleSpecifier)) return null
  const symbol = context.checker.getSymbolAtLocation(statement.moduleSpecifier)
  const declarations = symbol?.declarations ?? []
  const source = declarations.map(declaration => declaration.getSourceFile()).find(Boolean)
  if (symbol === undefined || source === undefined) {
    diagnostics.push(makeDiagnostic('KG_EXTRACT_EXPORT_MODULE_UNRESOLVED', 'error', record.path, statement.moduleSpecifier.text, 'TypeChecker did not resolve export module'))
    return null
  }
  return slash(relative(context.root, source.fileName))
}

function exportDeclarations(record, context, diagnostics, effectiveModules) {
  const facts = []
  let order = 0
  for (const statement of record.sourceFile.statements) {
    if (!ts.isExportDeclaration(statement)) continue
    order += 1
    const moduleSpecifier = statement.moduleSpecifier === undefined ? null
      : ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined
    if (moduleSpecifier === undefined) diagnostics.push(makeDiagnostic('KG_EXTRACT_EXPORT_SPECIFIER_DYNAMIC', 'error', record.path, undefined, 'export module specifier is dynamic'))
    const names = []
    let kind = 'star'
    if (statement.exportClause === undefined) names.push({ exported: '*', local: '*', typeOnly: statement.isTypeOnly })
    else if (ts.isNamedExports(statement.exportClause)) for (const element of statement.exportClause.elements) {
      kind = 'named'
      names.push({ exported: element.name.text, local: element.propertyName?.text ?? element.name.text, typeOnly: statement.isTypeOnly || element.isTypeOnly })
    }
    else {
      kind = 'namespace'
      names.push({ exported: statement.exportClause.name.text, local: '*', typeOnly: statement.isTypeOnly })
    }
    names.sort((left, right) => compareText(left.exported, right.exported))
    const resolvedModule = resolvedModuleFact(statement, record, context, diagnostics)
    const targetRecord = resolvedModule === null ? undefined : context.recordByPath?.get(resolvedModule)
      ?? context.sourceRecords?.find(item => item.path === resolvedModule)
    const targetExports = targetRecord === undefined ? new Map() : effectiveModules(targetRecord)
    const effectiveExports = []
    if (kind === 'star') {
      for (const [name, spaces] of targetExports) effectiveExports.push({ name, spaces: effectiveSpaces(spaces, statement.isTypeOnly) })
    } else if (kind === 'namespace') {
      const spaces = statement.isTypeOnly ? ['type'] : ['value', 'namespace']
      names[0].effectiveSpaces = spaces
      effectiveExports.push({ name: names[0].exported, spaces })
    } else {
      for (const name of names) {
        let spaces = targetRecord === undefined ? symbolSpaces(resolveExportTarget(symbolAtExportName(statement, name.exported, context.checker), context.checker))
          : targetExports.get(name.local) ?? []
        spaces = effectiveSpaces(spaces, name.typeOnly)
        name.effectiveSpaces = spaces
        effectiveExports.push({ name: name.exported, spaces })
      }
    }
    effectiveExports.sort((left, right) => compareText(left.name, right.name))
    facts.push({
      order, kind, declarationTypeOnly: statement.isTypeOnly,
      moduleSpecifier: moduleSpecifier ?? null,
      resolvedModule,
      names, effectiveExports, anchor: anchor(record.sourceFile, statement),
    })
  }
  return facts
}

const EXPORT_DIAGNOSTIC_CODES = new Map([
  [2307, 'KG_EXTRACT_EXPORT_MODULE_UNRESOLVED'],
  [2792, 'KG_EXTRACT_EXPORT_MODULE_UNRESOLVED'],
  [7016, 'KG_EXTRACT_EXPORT_MODULE_UNRESOLVED'],
  [2305, 'KG_EXTRACT_EXPORT_SYMBOL_UNRESOLVED'],
  [2459, 'KG_EXTRACT_EXPORT_SYMBOL_UNRESOLVED'],
  [2308, 'KG_EXTRACT_EXPORT_AMBIGUOUS'],
  [1205, 'KG_EXTRACT_EXPORT_TYPE_ONLY_REQUIRED'],
  [1361, 'KG_EXTRACT_EXPORT_TYPE_ONLY_VIOLATION'],
  [1362, 'KG_EXTRACT_EXPORT_TYPE_ONLY_VIOLATION'],
])

function exportSemanticDiagnostics(sourceRecords, context, diagnostics) {
  for (const record of sourceRecords) {
    const exportRanges = record.sourceFile.statements.filter(ts.isExportDeclaration).map(node => [node.pos, node.end])
    for (const item of context.program.getSemanticDiagnostics(record.sourceFile)) {
      const position = item.start ?? -1
      const exportScoped = exportRanges.some(([start, end]) => position >= start && position <= end)
      const code = EXPORT_DIAGNOSTIC_CODES.get(item.code) ?? (exportScoped ? 'KG_EXTRACT_EXPORT_SEMANTIC' : undefined)
      if (code === undefined) continue
      if (![2307, 2792, 7016, 1361, 1362].includes(item.code) && !exportScoped) continue
      diagnostics.push(makeDiagnostic(code, 'error', record.path, `TS${item.code}`, ts.flattenDiagnosticMessageText(item.messageText, '\n')))
    }
  }
}

function symbolSpaces(symbol) {
  const spaces = []
  if ((symbol.flags & ts.SymbolFlags.Type) !== 0) spaces.push('type')
  if ((symbol.flags & ts.SymbolFlags.Value) !== 0) spaces.push('value')
  if ((symbol.flags & ts.SymbolFlags.Namespace) !== 0) spaces.push('namespace')
  return spaces
}

function effectiveSpaces(spaces, typeOnly) {
  return typeOnly ? (spaces.includes('type') ? ['type'] : []) : spaces
}

function resolveExportTarget(symbol, checker) {
  if (symbol === undefined) return undefined
  if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol
  try { return checker.getAliasedSymbol(symbol) } catch { return undefined }
}

function symbolAtExportName(statement, exportedName, checker) {
  if (!ts.isNamedExports(statement.exportClause)) return undefined
  const element = statement.exportClause.elements.find(item => item.name.text === exportedName)
  return element === undefined ? undefined : checker.getSymbolAtLocation(element.name)
}

function moduleRecordForExport(statement, context) {
  if (statement.moduleSpecifier === undefined || !ts.isStringLiteral(statement.moduleSpecifier)) return undefined
  const symbol = context.checker.getSymbolAtLocation(statement.moduleSpecifier)
  const sourceFile = symbol?.declarations?.[0]?.getSourceFile()
  return sourceFile === undefined ? undefined : context.recordBySourceFile.get(sourceFile)
}

function effectiveModuleExportsFactory(context) {
  const memo = new Map()
  const active = new Set()
  const calculate = record => {
    if (memo.has(record.path)) return memo.get(record.path)
    if (active.has(record.path)) return new Map()
    active.add(record.path)
    const result = new Map()
    const moduleSymbol = context.checker.getSymbolAtLocation(record.sourceFile)
    if (moduleSymbol !== undefined) for (const exported of context.checker.getExportsOfModule(moduleSymbol)) {
      const aliasDeclaration = exported.declarations?.some(declaration => ts.isExportSpecifier(declaration) || ts.isNamespaceExport(declaration)) ?? false
      const target = resolveExportTarget(exported, context.checker)
      const locallyDeclared = target?.declarations?.some(declaration => declaration.getSourceFile() === record.sourceFile) ?? false
      if (!aliasDeclaration && locallyDeclared) result.set(exported.name, symbolSpaces(target))
    }
    for (const statement of record.sourceFile.statements) {
      if (!ts.isExportDeclaration(statement)) continue
      const targetRecord = moduleRecordForExport(statement, context)
      const target = targetRecord === undefined ? new Map() : calculate(targetRecord)
      if (statement.exportClause === undefined) {
        for (const [name, spaces] of target) if (name !== 'default' && !result.has(name)) {
          const narrowed = effectiveSpaces(spaces, statement.isTypeOnly)
          if (narrowed.length > 0) result.set(name, narrowed)
        }
      } else if (ts.isNamespaceExport(statement.exportClause)) {
        result.set(statement.exportClause.name.text, statement.isTypeOnly ? ['type'] : ['value', 'namespace'])
      } else {
        for (const element of statement.exportClause.elements) {
          const exportedName = element.name.text
          const localName = element.propertyName?.text ?? exportedName
          let spaces = targetRecord === undefined
            ? symbolSpaces(resolveExportTarget(context.checker.getSymbolAtLocation(element.name), context.checker))
            : target.get(localName) ?? []
          spaces = effectiveSpaces(spaces, statement.isTypeOnly || element.isTypeOnly)
          if (spaces.length > 0) result.set(exportedName, spaces)
        }
      }
    }
    active.delete(record.path)
    const ordered = new Map([...result].sort(([left], [right]) => compareText(left, right)))
    memo.set(record.path, ordered)
    return ordered
  }
  return calculate
}

function reachableExports(record, context, diagnostics, effectiveModules) {
  const moduleSymbol = context.checker.getSymbolAtLocation(record.sourceFile)
  if (moduleSymbol === undefined) {
    diagnostics.push(makeDiagnostic('KG_EXTRACT_EXPORT_MODULE_UNRESOLVED', 'error', record.path, undefined, 'TypeChecker did not bind source module'))
    return []
  }
  const result = []
  const effective = effectiveModules(record)
  for (const exported of context.checker.getExportsOfModule(moduleSymbol)) {
    let target = exported
    let alias = false
    if ((exported.flags & ts.SymbolFlags.Alias) !== 0) {
      alias = true
      try { target = context.checker.getAliasedSymbol(exported) } catch {
        diagnostics.push(makeDiagnostic('KG_EXTRACT_EXPORT_ALIAS_UNRESOLVED', 'error', record.path, exported.name, 'TypeChecker could not resolve export alias'))
        continue
      }
    }
    if ((target.flags & ts.SymbolFlags.Unknown) !== 0 || target.declarations === undefined) {
      diagnostics.push(makeDiagnostic('KG_EXTRACT_EXPORT_ALIAS_UNRESOLVED', 'error', record.path, exported.name, 'export target has no declaration'))
      continue
    }
    const spaces = effective.get(exported.name) ?? []
    if (spaces.length === 0) continue
    const declarations = [...new Set(target.declarations.map(declaration => slash(relative(context.root, declaration.getSourceFile().fileName))))].sort(compareText)
    result.push({ name: exported.name, alias, targetName: target.name, spaces, declarations })
  }
  return result.sort((left, right) => compareText(left.name, right.name))
}

function packageTargetKind(target) {
  const extension = extname(target)
  return ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'].includes(extension) || target.endsWith('.d.ts') ? 'code' : 'resource'
}

export async function extractExportFacts(root, sourceRecords, context, diagnostics) {
  let pkg
  try { pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) } catch (error) {
    diagnostics.push(makeDiagnostic('KG_EXTRACT_PACKAGE_JSON', 'error', 'package.json', undefined, error instanceof Error ? error.message : String(error)))
    pkg = {}
  }
  const packageExports = flattenPackageExports(pkg.exports).map(item => ({ ...item, kind: packageTargetKind(item.target) }))
  context.sourceRecords = sourceRecords
  context.recordByPath = new Map(sourceRecords.map(record => [record.path, record]))
  const effectiveModules = effectiveModuleExportsFactory(context)
  exportSemanticDiagnostics(sourceRecords, context, diagnostics)
  const reexportLayers = sourceRecords.flatMap(record => {
    const declarations = exportDeclarations(record, context, diagnostics, effectiveModules)
    return declarations.map(declaration => ({ file: record.path, ...declaration }))
  }).sort((left, right) => compareText(left.file, right.file) || left.order - right.order)
  const entryRecords = ['src/index.ts', 'src/public-api.ts', 'src/client/plugin-entry.ts', 'src/client/index.ts'].map(path => sourceRecords.find(record => record.path === path)).filter(Boolean)
  const sourceExports = []
  for (const record of entryRecords) sourceExports.push({
    file: record.path,
    declarations: reexportLayers.filter(item => item.file === record.path).map(({ file: _file, ...declaration }) => declaration),
    reachableSymbols: reachableExports(record, context, diagnostics, effectiveModules),
  })
  for (const required of ['src/index.ts', 'src/public-api.ts']) {
    if (!entryRecords.some(record => record.path === required)) diagnostics.push(makeDiagnostic('KG_EXTRACT_EXPORT_ENTRY_MISSING', 'error', required, undefined, 'required public source entrypoint is missing'))
  }
  return {
    packageExports,
    packageDshMetadata: pkg.dsh ?? null,
    reexportLayers,
    sourceExports,
    publicApiExports: sourceExports.find(item => item.file === 'src/public-api.ts')?.declarations ?? [],
    reachableRootExports: sourceExports.find(item => item.file === 'src/index.ts')?.reachableSymbols ?? [],
    reachablePublicApiExports: sourceExports.find(item => item.file === 'src/public-api.ts')?.reachableSymbols ?? [],
  }
}
