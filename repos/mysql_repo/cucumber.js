module.exports = {
    default: {
        requireModule: ['ts-node/register'],
        require: [
            '../../core/cert/src/support/**/*.ts',
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
            '../../core/cert/src/support/**/*.ts',
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
            '../../core/cert/src/support/**/*.ts',
            '../../core/cert/src/steps/**/*.ts',
            'test/e2e/support/**/*.ts'
        ],
        paths: ['../../core/cert/features/e2e/**/*.feature'],
        // schema.feature certifies the restlette, not storage: it runs once, on SQLite.
        tags: 'not @restlette',
        format: ['progress', 'json:test-results-bdd-e2e.json'],
        formatOptions: { snippetInterface: 'async-await' },
        publishQuiet: true
    }
};
