import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { callSubgraph } from '@meshobj/graphlette';
import { Application } from 'express';
import { Server } from 'http';
import { init } from '@meshobj/server';
import { Document, OpenAPIClient, OpenAPIClientAxios } from 'openapi-client-axios';
import { Restlette } from '@meshobj/server';
import * as jwt from 'jsonwebtoken';
import { Plugin } from '@meshobj/server';
import { Config } from '@meshobj/server';

let __TOKEN__ = ''; // Placeholder for JWT token
let config: Config;

let app: Application;
let server: Server;

let farm_id = '';
let coop1_id = '';
let coop2_id = '';
let hen_ids: Record<string, string> = {};
let first_stamp = 0;

let hen_api: any;
let coop_api: any;
let farm_api: any;

export function ServerCertificiation(setup: () => Promise<void>, plugins: Record<string, Plugin>, configurize: () => Promise<Config>, cleanup?: () => Promise<void>) {
    beforeAll(async () => {
        await setup();

        config = await configurize();

        const sub = 'test-user';
        __TOKEN__ = jwt.sign({ sub }, 'totallyASecret', { expiresIn: '1h' });

        try {
            app = await init(config, plugins);
        } catch (e) {
            console.error(e);
            console.log(JSON.stringify(config, null, 2));
            throw e;
        }

        let port = config.port;

        server = await app.listen(port, () => {
            console.log(`Server running on http://localhost:${port}`);
        });

        // Build API clients
        try {
            const swagger_docs: Document[] = await getSwaggerDocs(config);

            await buildApi(swagger_docs, __TOKEN__);

            await buildModels();
        } catch (e) {
            console.error(e);
            console.log(JSON.stringify(config, null, 2));
            throw e;
        }
    });

    afterAll(async () => {
        for (const plugin of Object.values(plugins)) {
            await plugin.cleanup();
        }
        if (server) {
            server.close();
        }
        if (cleanup) {
            await cleanup();
        }
    });

    describe('The Farm', () => {
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

            const json = await callSubgraph(
                new URL(`http://localhost:${config.port}/farm/graph`),
                query,
                'getById',
                `Bearer ${__TOKEN__}`,
            );

            expect(json.name, `This is a catch all, your config is probably wrong: ${JSON.stringify(config)}`).toBe(
                'Emerdale',
            );
            expect(json.coops.length).toBe(3);
        });

        it('should answer simple queries', async () => {
            const query = `{
                getByName(name: "duck") {
                    id
                    name
                }
            }`;

            const json = await callSubgraph(
                new URL(`http://localhost:${config.port}/hen/graph`),
                query,
                'getByName',
                `Bearer ${__TOKEN__}`,
            );

            const duck_id:any = hen_ids['duck'];
            expect(json[0].id, `Most of the time this has failed its because you have old data in storage`).toBe(
                duck_id
            );
            expect(json[0].name).toBe('duck');
        });

        it('should query in both directions', async () => {
            const query = `{
                getByCoop(id: "${coop1_id}") {
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

            const json = await callSubgraph(
                new URL(`http://localhost:${config.port}/hen/graph`),
                query,
                'getByCoop',
                `Bearer ${__TOKEN__}`,
            );

            expect(json.length).toBe(2);
            expect(json.map((res: any) => res.name)).toEqual(expect.arrayContaining(['chuck', 'duck']));
            expect(json[0].coop.name).toBe('purple');
        });

        it('should get latest by default', async () => {
            const query = `{
                getById(id: "${coop1_id}") {
                    id
                    name
                }
            }`;

            const json = await callSubgraph(
                new URL(`http://localhost:${config.port}/coop/graph`),
                query,
                'getById',
                `Bearer ${__TOKEN__}`,
            );

            expect(json.id, `Idempotency isn't working. Check the plugins for examples of how to implement it`).toBe(
                coop1_id,
            );
            expect(json.name).toBe('purple');
        });

        it('should get closest to the timestamp when specified', async () => {
            const query = `{
                getById(id: "${coop1_id}", at: ${first_stamp}) {
                    name
                }
            }`;

            const json = await callSubgraph(
                new URL(`http://localhost:${config.port}/coop/graph`),
                query,
                'getById',
                `Bearer ${__TOKEN__}`,
            );

            expect(json.name).toBe('red');
        });

        it('should obey the timestamps', async () => {
            const query = `{
                getById(id: "${farm_id}", at: ${first_stamp}) {
                    coops {
                    name
                    }
                }
            }`;

            const json = await callSubgraph(
                new URL(`http://localhost:${config.port}/farm/graph`),
                query,
                'getById',
                `Bearer ${__TOKEN__}`,
            );

            const names = json.coops.map((c: any) => c.name);
            expect(names).not.toContain('purple');
        });

        it('should pass timestamps to next layer', async () => {
            const query = `{
                getById(id: "${farm_id}", at: ${Date.now()}) {
                    coops {
                    name
                    }
                }
            }`;

            const json = await callSubgraph(
                new URL(`http://localhost:${config.port}/farm/graph`),
                query,
                'getById',
                `Bearer ${__TOKEN__}`,
            );

            const names = json.coops.map((c: any) => c.name);
            expect(names).toContain('purple');
        });
    });
}

async function getSwaggerDocs(config: Config) {
    return await Promise.all(
        config.restlettes.map(async (restlette: Restlette) => {
            let url = `http://localhost:${config.port}${restlette.path}/api-docs/swagger.json`;

            const response = await fetch(url);
            let doc = await response.json();
            return doc;
        }),
    );
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

    const coop1 = await coop_api.create(null, { name: 'red', farm_id: farm_id });
    coop1_id = coop1.request.path.slice(-36);

    const coop2 = await coop_api.create(null, { name: 'yellow', farm_id: farm_id });
    coop2_id = coop2.request.path.slice(-36);

    await coop_api.create(null, { name: 'pink', farm_id: farm_id });

    first_stamp = Date.now();

    await coop_api.update({ id: coop1_id }, { name: 'purple', farm_id: farm_id });

    const hens = [
        { name: 'chuck', eggs: 2, coop_id: coop1_id },
        { name: 'duck', eggs: 0, coop_id: coop1_id },
        { name: 'euck', eggs: 1, coop_id: coop2_id },
        { name: 'fuck', eggs: 2, coop_id: coop2_id },
    ];

    const savedHens = await Promise.all(hens.map((hen) => hen_api.create(null, hen)));

    savedHens.forEach((hen: any) => {
        hen_ids[hen.data.name] = hen.headers['x-canonical-id'];
    });

    console.log('Hens:', JSON.stringify(hen_ids));
}
