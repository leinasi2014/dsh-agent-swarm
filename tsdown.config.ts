import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/index.ts', client: 'src/client/index.ts' },
  format: ['esm'],
  outDir: 'lib',
  clean: false,
  dts: false,
  sourcemap: true,
})
