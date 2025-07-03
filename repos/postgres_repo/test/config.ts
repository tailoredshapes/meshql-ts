import { Config } from '@meshobj/server';
import fs from 'fs';
import { PostgresConfig } from '../src';

const port = 4242;

const url = `http://localhost:${port}`;

let config_dir = `${__dirname}/../../server/test/config/`;

const prefix = 'farm';
const env = 'test';

const database = () => ({
    type: 'postgres',
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432'),
    db: `test`,
    user: `postgres`,
    password: `password`,
});

const henDB = (): PostgresConfig => ({
    ...database(),
    table: `${prefix}_${env}_hen`,
});

const coopDB = (): PostgresConfig => ({
    ...database(),
    table: `${prefix}_${env}_coop`,
});

const farmDB = (): PostgresConfig => ({
    ...database(),
    table: `${prefix}_${env}_farm`,
});

const farmGraph = fs.readFileSync(`${config_dir}graph/farm.graphql`, 'utf8');
const coopGraph = fs.readFileSync(`${config_dir}graph/coop.graphql`, 'utf8');
const henGraph = fs.readFileSync(`${config_dir}graph/hen.graphql`, 'utf8');

const farmJSONSchema = JSON.parse(fs.readFileSync(`${config_dir}json/farm.schema.json`, 'utf8'));
const coopJSONSchema = JSON.parse(fs.readFileSync(`${config_dir}json/coop.schema.json`, 'utf8'));
const henJSONSchema = JSON.parse(fs.readFileSync(`${config_dir}json/hen.schema.json`, 'utf8'));

export const config = (): Config => ({
    port,

    graphlettes: [
        {
            path: '/farm/graph',
            storage: farmDB(),
            schema: farmGraph,
            rootConfig: {
                singletons: [
                    {
                        name: 'getById',
                        query: "id = '{{id}}'",
                    },
                ],
                vectors: [],
                resolvers: [
                    {
                        name: 'coops',
                        queryName: 'getByFarm',
                        url: `${url}/coop/graph`,
                    },
                ],
            },
        },
        {
            path: '/coop/graph',
            storage: coopDB(),
            schema: coopGraph,
            rootConfig: {
                singletons: [
                    {
                        name: 'getByName',
                        id: 'name',
                        query: "payload->>'name' = '{{id}}'",
                    },
                    {
                        name: 'getById',
                        query: "id = '{{id}}'",
                    },
                ],
                vectors: [
                    {
                        name: 'getByFarm',
                        query: "payload->>'farm_id' = '{{id}}'",
                    },
                ],
                resolvers: [
                    {
                        name: 'farm',
                        id: 'farm_id',
                        queryName: 'getById',
                        url: `${url}/farm/graph`,
                    },
                    {
                        name: 'hens',
                        queryName: 'getByCoop',
                        url: `${url}/hen/graph`,
                    },
                ],
            },
        },
        {
            path: '/hen/graph',
            storage: henDB(),
            schema: henGraph,
            rootConfig: {
                singletons: [
                    {
                        name: 'getById',
                        query: "id = '{{id}}'",
                    },
                ],
                vectors: [
                    {
                        name: 'getByName',
                        query: "payload->>'name' = '{{name}}'",
                    },
                    {
                        name: 'getByCoop',
                        query: "payload->>'coop_id' = '{{id}}'",
                    },
                ],
                resolvers: [
                    {
                        name: 'coop',
                        id: 'coop_id',
                        queryName: 'getById',
                        url: `${url}/coop/graph`,
                    },
                ],
            },
        },
    ],

    restlettes: [
        {
            path: '/farm/api',
            storage: farmDB(),
            schema: farmJSONSchema,
        },
        {
            path: '/coop/api',
            storage: coopDB(),
            schema: coopJSONSchema,
        },
        {
            path: '/hen/api',
            storage: henDB(),
            schema: henJSONSchema,
        },
    ],
});
