import { readFileSync } from 'node:fs'
import ts from 'typescript'

/** Load the real browser store and its sole runtime dependency; storage is never mocked. */
export function draftStoreScript(name: 'public-draft-store' | 'work-request-draft-store'): string {
  return `const draftDatabaseModule = {}; ((exports) => { ${compile('draft-indexed-db')} })(draftDatabaseModule);
    const require = (name) => { if (name !== './draft-indexed-db.js') throw new Error('Unexpected draft dependency'); return draftDatabaseModule; };
    ${compile(name)}`
}

const compile = (moduleName: string): string => ts.transpileModule(readFileSync(new URL(`../../src/client/${moduleName}.ts`, import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
