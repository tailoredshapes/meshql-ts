import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { init } from '../src/server';
import { Config, Graphlette } from '../src/configTypes';
import { SQLitePlugin, SQLConfig } from '@tailoredshapes/meshql-sqlite_repo';

describe('Server Health Checks', () => {
    let app: any;
    let server: any;
    const port = 40502;

    beforeAll(async () => {
        const dbconf: SQLConfig = {
            type: 'sqlite',
            uri: 'health.db',
            collection: 'test'
        };

        const graphlette: Graphlette = {
            schema: `
                type Query {
                    hello: String
                }
            `,
            path: '/test/graph',
            storage: dbconf,
            rootConfig: {
                resolvers: [{
                    name: 'hello',
                    queryName: 'hello',
                    url: 'http://localhost:4000/hello',
                }],
            },
        };

        const config: Config = {
            port,
            graphlettes: [graphlette],
            restlettes: [],
        };

        app = await init(config, { sqlite: new SQLitePlugin() });
        server = await app.listen(port);
    });

    afterAll(async () => {
        if (server) {
            server.close();
        }
    });

    describe('GET /health', () => {
        it('should return health status of all services', async () => {
            const response = await fetch(`http://localhost:${port}/health`);
            const data = await response.json();

            expect(response.status).toBe(200);
            expect(data.status).toBe('ok');
            expect(data.services).toHaveProperty('/test/graph');
            expect(data.services['/test/graph'].status).toBe('ok');
        });
    });

    describe('GET /ready', () => {
        it('should return ready status of all services', async () => {
            const response = await fetch(`http://localhost:${port}/ready`);
            const data = await response.json();

            expect(response.status).toBe(200);
            expect(data.status).toBe('ok');
            expect(data.services).toHaveProperty('/test/graph');
            expect(data.services['/test/graph'].status).toBe('ok');
        });

        it('should return 503 if any service is not ready', async () => {
            // Mock a service being not ready
            const originalFetch = global.fetch;
            global.fetch = async () => {
                return {
                    status: 503,
                    json: async () => ({
                        status: 'error',
                        message: 'Service not ready',
                        services: {
                            '/test/graph': {
                                status: 'error',
                                message: 'Service not ready'
                            }
                        }
                    }),
                } as any;
            };

            const response = await fetch(`http://localhost:${port}/ready`);
            const data = await response.json();

            expect(response.status).toBe(503);
            expect(data.status).toBe('error');
            expect(data.services).toHaveProperty('/test/graph');
            expect(data.services['/test/graph'].status).toBe('error');

            // Restore original fetch
            global.fetch = originalFetch;
        });
    });
}); 