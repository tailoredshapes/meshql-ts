import { Config } from '@tailoredshapes/meshql-server';
import { MongoConfig } from '@tailoredshapes/meshql-mongo_repo';
import { PostgresConfig } from '@tailoredshapes/meshql-postgres_repo';
import fs from 'fs';

const PORT = 4055;
const ENV = 'test';
const PREFIX = 'events';
const PLATFORM_URL = `http://localhost:${PORT}`;
const config_dir = `${__dirname}/../config/`;

const mongoDatabase = (): MongoConfig => ({
    type: 'mongo',
    uri: process.env.MONGO_URI || 'mongodb://localhost:27017',
    db: `${PREFIX}_${ENV}`,
    collection: `${PREFIX}-${ENV}-raw`,
    options: {
        directConnection: true,
    },
});

const postgresDatabase = (): PostgresConfig => ({
    type: 'postgres',
    uri: process.env.POSTGRES_URI || 'postgresql://localhost:5432/events_test',
    collection: `${PREFIX}_${ENV}_processed`,
});

const rawEventSchema = fs.readFileSync(`${config_dir}graph/raw_event.graphql`, 'utf8');
const processedEventSchema = fs.readFileSync(`${config_dir}graph/processed_event.graphql`, 'utf8');
const rawEventJSONSchema = JSON.parse(fs.readFileSync(`${config_dir}json/raw_event.schema.json`, 'utf8'));
const processedEventJSONSchema = JSON.parse(fs.readFileSync(`${config_dir}json/processed_event.schema.json`, 'utf8'));

export const config = (): Config => ({
    port: PORT,
    
    graphlettes: [
        {
            path: '/raw-events/graph',
            storage: mongoDatabase(),
            schema: rawEventSchema,
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
                        name: 'getAll',
                        query: '{}',
                    },
                ],
                resolvers: [],
            },
        },
        {
            path: '/processed-events/graph',
            storage: postgresDatabase(),
            schema: processedEventSchema,
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
                        name: 'getByRawEventId',
                        query: '{"payload.raw_event_id": "{{raw_event_id}}"}',
                    },
                    {
                        name: 'getAll',
                        query: '{}',
                    },
                ],
                resolvers: [
                    {
                        name: 'rawEvent',
                        id: 'raw_event_id',
                        queryName: 'getById',
                        url: `${PLATFORM_URL}/raw-events/graph`,
                    },
                ],
            },
        },
    ],
    
    restlettes: [
        {
            path: '/raw-events/api',
            storage: mongoDatabase(),
            schema: rawEventJSONSchema,
        },
        {
            path: '/processed-events/api',
            storage: postgresDatabase(),
            schema: processedEventJSONSchema,
        },
    ],
});