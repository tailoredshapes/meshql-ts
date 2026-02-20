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

describe.skip('Farm Service Smoke Test', () => {
    beforeAll(async () => {
        const startTime = Date.now();
        
        // Start the docker-compose environment
        environment = await new DockerComposeEnvironment(path.resolve(__dirname, '..'), 'docker-compose.yml')
            .withBuild()
            .withWaitStrategy('farm', Wait.forHttp('/ready', 3033).withStartupTimeout(30000))
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

    it('should build a server with multiple nodes', async () => {
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

        const json = await callSubgraph(new URL(`http://localhost:3033/farm/graph`), query, 'getById', null);

        expect(json.name).toBe('Emerdale');
        expect(json.coops.length).toBe(3);
    });
}, 300000);

async function getSwaggerDocs() {
    const maxRetries = 10;
    const retryDelay = 2000;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await Promise.all(
                ['/hen', '/coop', '/farm'].map(async (restlette) => {
                    let url = `http://localhost:3033${restlette}/api/api-docs/swagger.json`;
                    const response = await fetch(url);
                    
                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                    }
                    
                    let doc = await response.json();
                    return doc;
                }),
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
