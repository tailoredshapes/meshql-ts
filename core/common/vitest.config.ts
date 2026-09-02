import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        setupFiles: [],
        hookTimeout: 120_000,
        testTimeout: 120_000,
        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            exclude: ['**/*.d.ts', '**/*.js', '**/test/**', '**/coverage/**'],
            all: false,
        },
    },
    esbuild: {
        loader: 'ts',
        target: 'es2022',
    },
});
