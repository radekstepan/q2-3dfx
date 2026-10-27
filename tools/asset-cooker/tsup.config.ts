import { defineConfig } from 'tsup';
export default defineConfig({ entry: ['src/index.ts', 'src/cli.ts', 'src/check-deps.ts'], format: ['esm','cjs'], dts: true, sourcemap: true, clean: true });
