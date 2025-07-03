import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        hookTimeout: 30000,
        coverage: {
            reportsDirectory: '../../coverage',
        },
    },
    esbuild: {
        loader: 'ts', // Use TypeScript loader
        target: 'es2022', // Align with `tsconfig.json`
    },
});
