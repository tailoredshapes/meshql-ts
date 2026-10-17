module.exports = {
    default: {
        requireModule: ['ts-node/register'],
        require: [
            '../../core/cert/src/steps/**/*.ts',
            'test/integration/support/**/*.ts'
        ],
        paths: ['../../core/cert/features/integration/**/*.feature'],
        format: ['progress', 'json:test-results-bdd-int.json'],
        formatOptions: { snippetInterface: 'async-await' },
        publishQuiet: true
    },
    int: {
        requireModule: ['ts-node/register'],
        require: [
            '../../core/cert/src/steps/**/*.ts',
            'test/integration/support/**/*.ts'
        ],
        paths: ['../../core/cert/features/integration/**/*.feature'],
        format: ['progress', 'json:test-results-bdd-int.json'],
        formatOptions: { snippetInterface: 'async-await' },
        publishQuiet: true
    },
    e2e: {
        requireModule: ['ts-node/register'],
        require: [
            '../../core/cert/src/steps/**/*.ts',
            'test/e2e/support/**/*.ts'
        ],
        // The egg economy runs on one store only: meshql is storage agnostic, which the
        // storage contracts (-p int, and versions.feature) prove per store.
        paths: ['../../core/cert/features/e2e/**/*.feature', '../../core/cert/features/egg/*.feature'],
        format: ['progress', 'json:test-results-bdd-e2e.json'],
        formatOptions: { snippetInterface: 'async-await' },
        publishQuiet: true
    }
};
