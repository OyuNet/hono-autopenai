import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  shims: true,
  splitting: false,
  banner: {
    js: '#!/usr/bin/env node',
  },
})
