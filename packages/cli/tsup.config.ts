import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', cli: 'src/cli.ts' },
  format: ['esm'],
  target: 'node20',
  dts: true,
  clean: true,
  sourcemap: true,
  // Non-JS assets (the install page templates, exportOptions.plist) are resolved
  // from the package root at runtime, never from `import.meta.dirname` of a
  // bundled chunk — see src/assets.ts.
  splitting: false,
  banner: { js: '#!/usr/bin/env node' },
});
