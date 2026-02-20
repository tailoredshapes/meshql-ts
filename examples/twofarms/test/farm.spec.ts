import { DockerComposeEnvironment, StartedDockerComposeEnvironment, Wait } from 'testcontainers';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import { callSubgraph } from '@tailoredshapes/meshql-graphlette';
import { Document, OpenAPIClient, OpenAPIClientAxios } from 'openapi-client-axios';
import { defineConfig } from 'vitest/config';


let farm_id = '';
let coop1_id = '';
let coop2_id = '';

let hen_api: any;
let coop_api: any;
let farm_api: any;

let environment: StartedDockerComposeEnvironment;

// Skip in CI - requires Docker and takes 100+ seconds
describe.skipIf(process.env.CI === 'true').sequential('Two Farms Service Smoke Test', () => {
    beforeAll(async () => {
        const startTime = Date.now();
        
        // Start the docker-compose environment
        environment = await new DockerComposeEnvironment(path.resolve(__dirname, '..'), 'docker-compose.yml')
            .withBuild()
            .withWaitStrategy('farm', Wait.forHttp('/ready', 5055).withStartupTimeout(30000))
            .withWaitStrategy('equipment', Wait.forHttp('/ready', 6066).withStartupTimeout(30000))
            .withWaitStrategy('mongodb', Wait.forLogMessage('Waiting for connections'))
            .up();

        const swagger_docs: Document[] = await getSwaggerDocs();
        await buildApi(swagger_docs, '');
        await buildModels();
    }, 300000); // Increase timeout for container startup

    afterAll(async () => {
        if (environment) {
            await environment.down();
        }
    });

    it('should query farm with nested coops and hens via cross-service resolvers', async () => {
        const query = `{
            getById(id: "${farm_id}") {
                name
                coops {
                    name
                    hens {
                        eggs
                        name
                    }
                }
            }
        }`;

        const json = await callSubgraph(new URL(`http://localhost:5055/farm/graph`), query, 'getById', null);

        expect(json.name).toBe('Emerdale');
        expect(json.coops.length).toBe(3);
        expect(json.coops.find((c: any) => c.name === 'purple')).toBeDefined();

        // Verify hens were resolved from the equipment service
        const purpleCoop = json.coops.find((c: any) => c.name === 'purple');
        expect(purpleCoop.hens.length).toBe(2);
        expect(purpleCoop.hens.map((h: any) => h.name)).toContain('chuck');
    });

    it('should query coop with nested farm and hens via resolvers', async () => {
        const query = `{
            getById(id: "${coop1_id}") {
                name
                farm {
                    name
                }
                hens {
                    name
                    eggs
                }
            }
        }`;

        const json = await callSubgraph(new URL(`http://localhost:6066/coop/graph`), query, 'getById', null);

        expect(json.name).toBe('purple');
        expect(json.farm.name).toBe('Emerdale'); // Resolved from farm service
        expect(json.hens.length).toBe(2);
    });

    it('should query hen with nested coop via resolver', async () => {
        const query = `{
            getByName(name: "chuck") {
                name
                eggs
                coop {
                    name
                    farm {
                        name
                    }
                }
            }
        }`;

        const json = await callSubgraph(new URL(`http://localhost:6066/hen/graph`), query, 'getByName', null);

        expect(json[0].name).toBe('chuck');
        expect(json[0].eggs).toBe(2);
        expect(json[0].coop.name).toBe('purple'); // Resolved from coop
        expect(json[0].coop.farm.name).toBe('Emerdale'); // Nested resolution
    });

    it('should support REST API alongside GraphQL', async () => {
        // Create a new hen via REST API
        await hen_api.create(null, {
            name: 'clucky',
            eggs: 5,
            coop_id: coop1_id
        });

        // Verify it appears in GraphQL queries
        const query = `{
            getByName(name: "clucky") {
                name
                eggs
                coop {
                    name
                }
            }
        }`;

        const json = await callSubgraph(new URL(`http://localhost:6066/hen/graph`), query, 'getByName', null);

        expect(json.length).toBeGreaterThan(0);
        const clucky = json.find((h: any) => h.name === 'clucky');
        expect(clucky).toBeDefined();
        expect(clucky.eggs).toBe(5);
        expect(clucky.coop.name).toBe('purple'); // Resolved from coop service
    });

    it('should demonstrate vector queries (multiple results)', async () => {
        const query = `{
            getByFarm(id: "${farm_id}") {
                name
                hens {
                    name
                    eggs
                }
            }
        }`;

        const json = await callSubgraph(new URL(`http://localhost:6066/coop/graph`), query, 'getByFarm', null);

        expect(json.length).toBe(3); // All coops for this farm
        const totalHens = json.reduce((sum: number, coop: any) => sum + coop.hens.length, 0);
        expect(totalHens).toBeGreaterThanOrEqual(4); // At least 4 hens (may be more if previous test created one)
    });
}, 300000);

async function getSwaggerDocs() {
    const maxRetries = 10;
    const retryDelay = 2000;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await Promise.all(
                ['/hen', '/coop'].map(async (restlette) => {
                    let url = `http://localhost:6066${restlette}/api/api-docs/swagger.json`;
                    const response = await fetch(url);
                    
                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                    }
                    
                    let doc = await response.json();
                    return doc;
                }).concat(['/farm'].map(async (restlette) => {
                    let url = `http://localhost:5055${restlette}/api/api-docs/swagger.json`;
                    const response = await fetch(url);
                    
                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                    }
                    
                    let doc = await response.json();
                    return doc;
                }))
            );
        } catch (error) {
            if (attempt === maxRetries) {
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
    }
}

async function buildApi(swagger_docs: Document[], token: string) {
    const authHeaders = { Authorization: `Bearer ${token}` };

    const apis: OpenAPIClient[] = await Promise.all(
        swagger_docs.map(async (doc: Document): Promise<OpenAPIClient> => {
            if (!doc.paths || Object.keys(doc.paths).length === 0) {
                throw new Error(`Swagger document for ${doc.info.title} has no paths defined`);
            }

            const api = new OpenAPIClientAxios({
                definition: doc,
                axiosConfigDefaults: { headers: authHeaders },
            });

            return api.init();
        }),
    );

    for (const api of apis) {
        const firstPath = Object.keys(api.paths)[0];
        if (firstPath.includes('hen')) {
            hen_api = api;
        } else if (firstPath.includes('coop')) {
            coop_api = api;
        } else if (firstPath.includes('farm')) {
            farm_api = api;
        }
    }
}

async function buildModels() {
    const farm = await farm_api.create(null, { name: 'Emerdale' });

    farm_id = farm.request.path.slice(-36);

    const coop1 = await coop_api.create(null, { name: 'red', farm_id });
    coop1_id = coop1.request.path.slice(-36);

    const coop2 = await coop_api.create(null, { name: 'yellow', farm_id });
    coop2_id = coop2.request.path.slice(-36);

    await coop_api.create(null, { name: 'pink', farm_id });

    await coop_api.update({ id: coop1_id }, { name: 'purple', farm_id });

    const hens = [
        { name: 'chuck', eggs: 2, coop_id: coop1_id },
        { name: 'duck', eggs: 0, coop_id: coop1_id },
        { name: 'euck', eggs: 1, coop_id: coop2_id },
        { name: 'fuck', eggs: 2, coop_id: coop2_id },
    ];

    await Promise.all(hens.map((hen) => hen_api.create(null, hen)));
} 