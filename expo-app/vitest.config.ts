import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Metro/Expo resolve the app's `@/*` alias from tsconfig `paths`; vitest does
// not read tsconfig, so mirror it here (`@/x` → `sources/x`). Scoped packages
// like `@scope/pkg` are untouched (only a literal `@/` prefix matches).
const sources = fileURLToPath(new URL('./sources/', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: /^@\//, replacement: sources }],
  },
});
