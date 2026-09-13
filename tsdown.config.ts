import { defineConfig } from 'tsdown'

const clientExternals = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
])

export default defineConfig([
  {
    // Host build face: BOTH official Host entries live in ONE build graph so
    // shared chunks stay singletons across `.` and `./skills` (one
    // TeamDomainError class, one symbol set). The skills entry is Root
    // approved; the main entry face is otherwise unchanged.
    entry: { index: 'src/index.ts', skills: 'src/skills/plugin.ts' },
    format: ['esm'],
    outDir: 'lib',
    clean: false,
    dts: false,
    sourcemap: true,
  },
  {
    entry: { client: 'src/client/plugin-entry.ts' },
    format: ['cjs'],
    platform: 'browser',
    target: 'es2023',
    fixedExtension: false,
    outDir: 'lib',
    clean: false,
    dts: false,
    sourcemap: true,
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    deps: {
      neverBundle: specifier => clientExternals.has(specifier),
      alwaysBundle: specifier => !clientExternals.has(specifier),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-agent-swarm", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
