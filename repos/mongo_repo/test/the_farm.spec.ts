import { MongoMemoryServer } from 'mongodb-memory-server';
import { ServerCertificiation } from '@meshobj/certification';
import Log4js from 'log4js';
import { describe } from 'vitest';
import { MongoPlugin } from '../src';
import { config } from './config';
let mongod: MongoMemoryServer;
let uri: string;

Log4js.configure({
    appenders: {
        out: {
            type: 'stdout',
        },
    },
    categories: {
        default: { appenders: ['out'], level: 'error' },
    },
});

let setup = async () => {
    try {
        mongod = await MongoMemoryServer.create();
    } catch (err) {
        console.error(JSON.stringify(err));
    }

    uri = mongod.getUri();

    process.env.MONGO_URI = uri;
};

let cleanup = async () => {
    if (mongod) await mongod.stop();
};

describe('Mongo Farm', () => {
    ServerCertificiation(setup, { mongo: new MongoPlugin() }, config);
});
