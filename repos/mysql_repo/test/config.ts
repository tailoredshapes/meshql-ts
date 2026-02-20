import { Config } from '@tailoredshapes/meshql-server';
import fs from 'fs';
import { MySQLConfig } from '../src';

let port = 5043;

let platformUrl = 'http://localhost:' + port;
let config_dir = `${__dirname}/../../../core/server/test/config/`;

let database = () => ({
    type: 'mysql',
    host: process.env.MYSQL_HOST || 'localhost',
    port: parseInt(process.env.MYSQL_PORT || '3306'),
    db: 'test',
    user: 'test',
    password: 'test',
});

let henDB = (): MySQLConfig => ({
    ...database(),
    table: 'hen',
});

let coopDB = (): MySQLConfig => ({
    ...database(),
    table: 'coop',
});

let farmDB = (): MySQLConfig => ({
    ...database(),
    table: 'farm',
});

let farmGraph = fs.readFileSync(config_dir + 'graph/farm.graphql', 'utf8');
let henGraph = fs.readFileSync(config_dir + 'graph/hen.graphql', 'utf8');
let coopGraph = fs.readFileSync(config_dir + 'graph/coop.graphql', 'utf8');

let farmSchema = JSON.parse(fs.readFileSync(config_dir + 'json/farm.schema.json', 'utf8'));
let coopSchema = JSON.parse(fs.readFileSync(config_dir + 'json/coop.schema.json', 'utf8'));
let henSchema = JSON.parse(fs.readFileSync(config_dir + 'json/hen.schema.json', 'utf8'));

export const config = async (): Promise<Config> => ({
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
                        url: platformUrl + '/coop/graph',
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
                        query: "JSON_EXTRACT(payload, '$.name') = '{{id}}'",
                    },
                    {
                        name: 'getById',
                        query: "id = '{{id}}'",
                    },
                ],
                vectors: [
                    {
                        name: 'getByFarm',
                        query: "JSON_EXTRACT(payload, '$.farm_id') = '{{id}}'",
                    },
                ],
                resolvers: [
                    {
                        name: 'farm',
                        id: 'farm_id',
                        queryName: 'getById',
                        url: platformUrl + '/farm/graph',
                    },
                    {
                        name: 'hens',
                        queryName: 'getByCoop',
                        url: platformUrl + '/hen/graph',
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
                        query: "JSON_EXTRACT(payload, '$.name') = '{{name}}'",
                    },
                    {
                        name: 'getByCoop',
                        query: "JSON_EXTRACT(payload, '$.coop_id') = '{{id}}'",
                    },
                ],
                resolvers: [
                    {
                        name: 'coop',
                        id: 'coop_id',
                        queryName: 'getById',
                        url: platformUrl + '/coop/graph',
                    },
                ],
            },
        },
    ],
    restlettes: [
        {
            path: '/farm/api',
            storage: farmDB(),
            schema: farmSchema,
        },
        {
            path: '/coop/api',
            storage: coopDB(),
            schema: coopSchema,
        },
        {
            path: '/hen/api',
            storage: henDB(),
            schema: henSchema,
        },
    ],
});
