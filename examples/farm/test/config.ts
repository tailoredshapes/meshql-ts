import { Config } from '@tailoredshapes/meshql-server';
import { MongoConfig } from '@tailoredshapes/meshql-mongo_repo';
import fs from 'fs';
const PORT = 3044;
const ENV = 'test';
const PREFIX = 'farm';
const PLATFORM_URL = `http://localhost:${PORT}`;
const config_dir = `${__dirname}/../config/`;

const database = () => ({
    type: 'mongo',
    uri: process.env.MONGO_URI || 'mongodb://localhost:27017',
    db: `${PREFIX}_${ENV}`,
    options: {
        directConnection: true,
    },
});

const henDB = (): MongoConfig => ({
    ...database(),
    collection: `${PREFIX}-${ENV}-hen`,
});
const coopDB = (): MongoConfig => ({
    ...database(),
    collection: `${PREFIX}-${ENV}-coop`,
});
const farmDB = (): MongoConfig => ({
    ...database(),
    collection: `${PREFIX}-${ENV}-farm`,
});

const farmSchema = fs.readFileSync(`${config_dir}graph/farm.graphql`, 'utf8');
const coopSchema = fs.readFileSync(`${config_dir}graph/coop.graphql`, 'utf8');
const henSchema = fs.readFileSync(`${config_dir}graph/hen.graphql`, 'utf8');
const farmJSONSchema = JSON.parse(fs.readFileSync(`${config_dir}json/farm.schema.json`, 'utf8'));
const coopJSONSchema = JSON.parse(fs.readFileSync(`${config_dir}json/coop.schema.json`, 'utf8'));
const henJSONSchema = JSON.parse(fs.readFileSync(`${config_dir}json/hen.schema.json`, 'utf8'));

export const config = (): Config => ({
    port: PORT,

    graphlettes: [
        {
            path: '/farm/graph',
            storage: farmDB(),
            schema: farmSchema,
            rootConfig: {
                singletons: [
                    {
                        name: 'getById',
                        query: '{"id": "{{id}}"}',
                    },
                ],
                vectors: [],
                resolvers: [
                    {
                        name: 'coops',
                        queryName: 'getByFarm',
                        url: `${PLATFORM_URL}/coop/graph`,
                    },
                ],
            },
        },
        {
            path: '/coop/graph',
            storage: coopDB(),
            schema: coopSchema,
            rootConfig: {
                singletons: [
                    {
                        name: 'getByName',
                        id: 'name',
                        query: '{"payload.name": "{{id}}"}',
                    },
                    {
                        name: 'getById',
                        query: '{"id": "{{id}}"}',
                    },
                ],
                vectors: [
                    {
                        name: 'getByFarm',
                        query: '{"payload.farm_id": "{{id}}"}',
                    },
                ],
                resolvers: [
                    {
                        name: 'farm',
                        id: 'farm_id',
                        queryName: 'getById',
                        url: `${PLATFORM_URL}/farm/graph`,
                    },
                    {
                        name: 'hens',
                        queryName: 'getByCoop',
                        url: `${PLATFORM_URL}/hen/graph`,
                    },
                ],
            },
        },
        {
            path: '/hen/graph',
            storage: henDB(),
            schema: henSchema,
            rootConfig: {
                singletons: [
                    {
                        name: 'getById',
                        query: '{"id": "{{id}}"}',
                    },
                ],
                vectors: [
                    {
                        name: 'getByName',
                        query: '{"payload.name": "{{name}}"}',
                    },
                    {
                        name: 'getByCoop',
                        query: '{"payload.coop_id": "{{id}}"}',
                    },
                ],
                resolvers: [
                    {
                        name: 'coop',
                        id: 'coop_id',
                        queryName: 'getById',
                        url: `${PLATFORM_URL}/coop/graph`,
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
