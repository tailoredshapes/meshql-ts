import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        hookTimeout: 30000,
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            reportsDirectory: '../../coverage',
            exclude: ['**/dist/**', '**/node_modules/**', '**/test/**', '**/*.spec.packages'],
        },
    },
    esbuild: {
        loader: 'ts', // Use TypeScript loader
        target: 'es2022', // Align with `tsconfig.json`
    },
});
