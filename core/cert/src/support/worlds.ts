import { World } from '@cucumber/cucumber';
import { Repository, Envelope, Searcher } from '@tailoredshapes/meshql-common';
import { TemplateDelegate } from 'handlebars';
import { init, Plugin, StorageConfig, Config as MeshQLConfig } from '@tailoredshapes/meshql-server';
import { Server } from 'node:http';
import { Document, OpenAPIClient, OpenAPIClientAxios } from 'openapi-client-axios';
import { Config } from 'log4js';
import fs from 'fs';
import path from 'path';
import { unverifiedToken } from './tokens';

export type SearcherTestTemplates = {
    findById: TemplateDelegate<{ id: string }>;
    findByName: TemplateDelegate<{ name: string }>;
    findAllByType: TemplateDelegate<{ type: string }>;
    findByNameAndType: TemplateDelegate<{ name: string; type: string }>;
};

export class IntegrationWorld extends World {
    //required from repository
    config?: StorageConfig;
    plugin?: Plugin;
    templates?: SearcherTestTemplates;

    //Used by steps
    repository?: Repository;
    searcher?: Searcher;
    envelopes?: Map<string, Envelope>;
    timestamps?: Map<string, number>;
    testStartTime?: number;
    searchResult?: any;
    searchResults?: any[];
    removeResult?: boolean;
    removeResults?: Record<string, boolean>;
    tokens?: string[];
}

export type FarmTestWorld = {
    //Please provide
    env: FarmEnv;

    //Per-scenario state (reset each scenario)
    queryResult?: any;
    now?: string;

    //used for clean up
    server?: Server;
};

export class FarmEnv {
    conf: Config;

    platform_url: string;
    port: number;
    queries: FarmQueries;

    farmGraph = fs.readFileSync(`${__dirname}/../../config/graph/farm.graphql`, 'utf8');
    coopGraph = fs.readFileSync(`${__dirname}/../../config/graph/coop.graphql`, 'utf8');
    henGraph = fs.readFileSync(`${__dirname}/../../config/graph/hen.graphql`, 'utf8');

    farmJSONSchema = JSON.parse(fs.readFileSync(`${__dirname}/../../config/json/farm.schema.json`, 'utf8'));
    coopJSONSchema = JSON.parse(fs.readFileSync(`${__dirname}/../../config/json/coop.schema.json`, 'utf8'));
    henJSONSchema = JSON.parse(fs.readFileSync(`${__dirname}/../../config/json/hen.schema.json`, 'utf8'));

    //Runtime state (persistent across all scenarios)
    ids: Record<string, Record<string, string>> = {};
    first_stamp?: number;
    apis?: any;
    token?: string;
    swaggerDocs?: Document[];

    constructor(dbFactories: DBFactories, queries: FarmQueries, platform_url: string, port: number) {
        this.platform_url = platform_url;
        this.port = port;
        this.queries = queries;
        this.conf = this.config(dbFactories.farmDB(), dbFactories.coopDB(), dbFactories.henDB());
    }

    async buildService(plugins: Record<string, Plugin>): Promise<Server> {
        let app = await init(this.conf, plugins);
        return app.listen(this.port);
    }

    async getSwaggerDocs(): Promise<Document[]> {
        return await Promise.all(
            this.conf.restlettes.map(async (restlette: any) => {
                const url = `http://localhost:${this.conf.port}${restlette.path}/api-docs/swagger.json`;
                const response = await fetch(url);
                return await response.json();
            }),
        );
    }

    async buildApi(swagger_docs: Document[], token: string): Promise<Record<string, any>> {
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

        const repos: Record<string, any> = {};
        for (const api of apis) {
            const firstPath = Object.keys(api.paths)[0];
            if (firstPath.includes('hen')) {
                repos['hen'] = api;
            } else if (firstPath.includes('coop')) {
                repos['coop'] = api;
            } else if (firstPath.includes('farm')) {
                repos['farm'] = api;
            }
        }
        return repos;
    }

    config(farmDB: StorageConfig, henDB: StorageConfig, coopDB: StorageConfig): Config {
        return {
            port: this.port,

            graphlettes: [
                {
                    path: '/farm/graph',
                    storage: farmDB,
                    schema: this.farmGraph,
                    rootConfig: {
                        singletons: [
                            {
                                name: 'getById',
                                query: this.queries.farmById,
                            },
                        ],
                        vectors: [],
                        resolvers: [
                            {
                                name: 'coops',
                                queryName: 'getByFarm',
                                url: `${this.platform_url}/coop/graph`,
                            },
                        ],
                    },
                },
                {
                    path: '/coop/graph',
                    storage: coopDB,
                    schema: this.coopGraph,
                    rootConfig: {
                        singletons: [
                            {
                                name: 'getByName',
                                id: 'name',
                                query: this.queries.coopByName,
                            },
                            {
                                name: 'getById',
                                query: this.queries.coopById,
                            },
                        ],
                        vectors: [
                            {
                                name: 'getByFarm',
                                query: this.queries.coopByFarmId,
                            },
                        ],
                        resolvers: [
                            {
                                name: 'farm',
                                id: 'farm_id',
                                queryName: 'getById',
                                url: `${this.platform_url}/farm/graph`,
                            },
                            {
                                name: 'hens',
                                queryName: 'getByCoop',
                                url: `${this.platform_url}/hen/graph`,
                            },
                        ],
                    },
                },
                {
                    path: '/hen/graph',
                    storage: henDB,
                    schema: this.henGraph,
                    rootConfig: {
                        singletons: [
                            {
                                name: 'getById',
                                query: this.queries.henById,
                            },
                        ],
                        vectors: [
                            {
                                name: 'getByName',
                                query: this.queries.henByName,
                            },
                            {
                                name: 'getByCoop',
                                query: this.queries.henByCoopId,
                            },
                        ],
                        resolvers: [
                            {
                                name: 'coop',
                                id: 'coop_id',
                                queryName: 'getById',
                                url: `${this.platform_url}/coop/graph`,
                            },
                        ],
                    },
                },
            ],

            restlettes: [
                {
                    path: '/farm/api',
                    storage: farmDB,
                    schema: this.farmJSONSchema,
                },
                {
                    path: '/coop/api',
                    storage: coopDB,
                    schema: this.coopJSONSchema,
                },
                {
                    path: '/hen/api',
                    storage: henDB,
                    schema: this.henJSONSchema,
                },
            ],
        };
    }
}

export interface DBFactories {
    farmDB(): StorageConfig;
    henDB(): StorageConfig;
    coopDB(): StorageConfig;
}

export interface FarmQueries {
    farmById: string;
    coopById: string;
    coopByName: string;
    coopByFarmId: string;
    henById: string;
    henByName: string;
    henByCoopId: string;
}

/**
 * ---------------------------------------------------------------------------
 * Authorization certification
 * ---------------------------------------------------------------------------
 *
 * The farm certification proves the wiring works. It cannot prove the wiring
 * is *safe*, because it drives every request as a single caller. Against one
 * caller a working authorization filter and a completely inert one look
 * identical.
 *
 * This environment stands up the same real HTTP surfaces — writes through the
 * restlette, reads through the graphlette — but with several distinct callers
 * whose credentials do NOT overlap:
 *
 *   alice   -> ["tenant_a"]
 *   bob     -> ["tenant_b"]
 *   root    -> ["tenant_a", "tenant_b"]   (entitled to everything)
 *   nobody  -> []                          (writes public records)
 *   <none>  -> []                          (anonymous; permitted, by design)
 *
 * The credential sets come from `@tailoredshapes/meshql-casbin_auth`: the JWT
 * `sub` is mapped to roles by the casbin policy in `config/casbin`. Casbin is
 * the only mechanism in this codebase that can give one caller more than one
 * credential, which is what a "sees everything" caller requires.
 */
export interface AuthzQueries {
    /** Singleton template matching on the envelope id, e.g. `id = '{{id}}'` */
    byId: string;
    /** Vector template matching on the payload's `name`, e.g. `payload->>'name' = '{{name}}'` */
    byName: string;
}

export type AuthzCaller = 'alice' | 'bob' | 'root' | 'nobody' | 'anonymous';

const AUTHZ_GRAPH_SCHEMA = `
scalar Date

type Query {
  getById(id: ID, at: Float): Hen
  getByName(name: String, at: Float): [Hen]
}

type Hen {
  id: ID
  name: String
  eggs: Int
  createdAt: String
}
`;

const AUTHZ_JSON_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['name'],
    properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        eggs: { type: 'integer', minimum: 0, maximum: 10 },
    },
};

export type AuthzCreated = {
    caller: AuthzCaller;
    name: string;
    id: string;
};

export class AuthzEnv {
    readonly conf: MeshQLConfig;
    readonly port: number;
    readonly baseUrl: string;
    readonly storage: StorageConfig;

    static readonly restPath = '/authz/api';
    static readonly graphPath = '/authz/graph';

    /** JWT `sub` claims per caller. `anonymous` deliberately sends no header. */
    static readonly subjects: Record<Exclude<AuthzCaller, 'anonymous'>, string> = {
        alice: 'alice',
        bob: 'bob',
        root: 'root',
        nobody: 'nobody',
    };

    /** The credentials each caller's JWT resolves to, per the casbin policy. */
    static readonly credentials: Record<AuthzCaller, string[]> = {
        alice: ['tenant_a'],
        bob: ['tenant_b'],
        root: ['tenant_a', 'tenant_b'],
        nobody: [],
        anonymous: [],
    };

    private plugins: Record<string, Plugin> = {};
    private repo?: Repository;

    /** `${caller}/${name}` -> envelope id, so two callers can share a name. */
    ids: Record<string, string> = {};

    constructor(storage: StorageConfig, queries: AuthzQueries, port: number) {
        this.storage = storage;
        this.port = port;
        this.baseUrl = `http://localhost:${port}`;

        const casbinDir = path.resolve(__dirname, '..', '..', 'config', 'casbin');

        this.conf = {
            port,
            casbinParams: [path.join(casbinDir, 'model.conf'), path.join(casbinDir, 'policy.csv')],
            graphlettes: [
                {
                    path: AuthzEnv.graphPath,
                    storage,
                    schema: AUTHZ_GRAPH_SCHEMA,
                    rootConfig: {
                        singletons: [{ name: 'getById', query: queries.byId }],
                        vectors: [{ name: 'getByName', query: queries.byName }],
                        resolvers: [],
                    },
                },
            ],
            restlettes: [
                {
                    // Deliberately no static `tokens`: we want the per-request
                    // credentials resolved by Auth to reach storage.
                    path: AuthzEnv.restPath,
                    storage,
                    schema: AUTHZ_JSON_SCHEMA,
                },
            ],
        };
    }

    async buildService(plugins: Record<string, Plugin>): Promise<Server> {
        this.plugins = plugins;
        const app = await init(this.conf, plugins);
        // Resolve only once the socket is actually accepting, so a bind
        // failure surfaces here instead of as an opaque "fetch failed".
        return await new Promise<Server>((resolve, reject) => {
            const server = app.listen(this.port);
            server.once('listening', () => resolve(server));
            server.once('error', reject);
        });
    }

    /**
     * A handle on the storage layer, so the certification can assert what was
     * actually persisted rather than only what the API chose to show it.
     */
    async repository(): Promise<Repository> {
        if (!this.repo) {
            this.repo = await this.plugins[this.storage.type].createRepository(this.storage);
        }
        return this.repo;
    }

    /**
     * A JWT for a caller. Unsigned-in-practice: `JWTSubAuthorizer` decodes
     * without verifying because signature validation belongs at the gateway.
     */
    tokenFor(caller: AuthzCaller): string | undefined {
        if (caller === 'anonymous') return undefined;
        const sub = AuthzEnv.subjects[caller];
        if (!sub) throw new Error(`Unknown caller "${caller}"`);
        return unverifiedToken(sub);
    }

    private headers(caller: AuthzCaller): Record<string, string> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            Accept: 'application/json',
        };
        const token = this.tokenFor(caller);
        if (token) headers.Authorization = `Bearer ${token}`;
        return headers;
    }

    /** Write through the restlette, exactly as a real client would. */
    async create(caller: AuthzCaller, payload: Record<string, any>): Promise<AuthzCreated> {
        const response = await fetch(`${this.baseUrl}${AuthzEnv.restPath}`, {
            method: 'POST',
            headers: this.headers(caller),
            body: JSON.stringify(payload),
            redirect: 'manual',
        });

        if (response.status !== 303) {
            throw new Error(`Create failed for ${caller}: ${response.status} ${await response.text()}`);
        }

        const location = response.headers.get('location');
        if (!location) throw new Error('Create returned no Location header');

        const id = location.substring(location.lastIndexOf('/') + 1);
        const created = { caller, name: payload.name, id };
        this.ids[`${caller}/${payload.name}`] = id;
        return created;
    }

    idFor(caller: AuthzCaller, name: string): string {
        const id = this.ids[`${caller}/${name}`];
        if (!id) throw new Error(`No record created by "${caller}" named "${name}"`);
        return id;
    }

    async readRest(caller: AuthzCaller, id: string): Promise<number> {
        const response = await fetch(`${this.baseUrl}${AuthzEnv.restPath}/${id}`, {
            method: 'GET',
            headers: this.headers(caller),
        });
        return response.status;
    }

    async removeRest(caller: AuthzCaller, id: string): Promise<number> {
        const response = await fetch(`${this.baseUrl}${AuthzEnv.restPath}/${id}`, {
            method: 'DELETE',
            headers: this.headers(caller),
        });
        return response.status;
    }

    /** Read through the graphlette, exactly as a real client would. */
    async query(caller: AuthzCaller, query: string): Promise<Record<string, any>> {
        const response = await fetch(`${this.baseUrl}${AuthzEnv.graphPath}`, {
            method: 'POST',
            headers: this.headers(caller),
            body: JSON.stringify({ query }),
        });

        const json = await response.json();
        if (json.errors) {
            throw new Error(`GraphQL error: ${JSON.stringify(json.errors)}`);
        }
        return json.data;
    }
}

export type AuthzTestWorld = {
    //Please provide
    authz: AuthzEnv;

    //Per-scenario state
    lastCreated?: AuthzCreated;
    lastQueryName?: string;
    singletonResult?: Record<string, any> | null;
    vectorResult?: Record<string, any>[];
    storedEnvelope?: Envelope;
    responseStatus?: number;
    capturedTime?: number;
};
