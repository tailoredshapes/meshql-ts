import { World } from '@cucumber/cucumber';
import { Repository, Envelope, Searcher } from '@tailoredshapes/meshql-common';
import { TemplateDelegate } from 'handlebars';
import { init, Plugin, StorageConfig } from '@tailoredshapes/meshql-server';
import { Server } from 'node:http';
import { Document, OpenAPIClient, OpenAPIClientAxios } from 'openapi-client-axios';
import { Config } from 'log4js';
import fs from 'fs';

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

        const repos: Record<string, any> = {}
        for (const api of apis) {
            const firstPath = Object.keys(api.paths)[0];
            if (firstPath.includes('hen')) {
                repos["hen"] = api;
            } else if (firstPath.includes('coop')) {
                repos["coop"] = api;
            } else if (firstPath.includes('farm')) {
                repos["farm"] = api;
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
