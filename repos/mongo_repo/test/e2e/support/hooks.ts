import { Before, AfterAll, BeforeAll } from '@cucumber/cucumber';
import { MongoMemoryServer } from 'mongodb-memory-server';
import Log4js from 'log4js';
import { FarmTestWorld, DBFactories, FarmQueries, AuthzTestWorld} from '@tailoredshapes/meshql-cert';
import { MongoConfig, MongoPlugin } from '../../../src';
import { Plugin } from '@tailoredshapes/meshql-server';
import { Server } from 'node:http';
import { FarmEnv, AuthzEnv } from '@tailoredshapes/meshql-cert';
import * as jwt from 'jsonwebtoken';

Log4js.configure({
    appenders: { out: { type: 'stdout' } },
    categories: { default: { appenders: ['out'], level: 'error' } },
});

let mongod: MongoMemoryServer;
let dbFactories: DBFactories;
let config: MongoConfig;
let plugins: Record<string, Plugin>;
let server: Server;
let farmEnv: FarmEnv;
let authzEnv: AuthzEnv;
let authzServer: Server;

BeforeAll({ timeout: 120000 }, async function() {
    mongod = new MongoMemoryServer();
    await mongod.start();

    const PREFIX = "cert";
    const ENV = "mongo";

    config = {
        type: ENV,
        uri: mongod.getUri(),
        db: `${PREFIX}_${ENV}`,
        collection: "CHANGE ME",
        options: {
            directConnection: true,
        }
    };

    dbFactories = {
        henDB: (): MongoConfig => {
            config.collection = `${PREFIX}-${ENV}-hen`;
            return config;
        },
        coopDB: (): MongoConfig => {
            config.collection = `${PREFIX}-${ENV}-coop`;
            return config;
        },
        farmDB: (): MongoConfig => {
            config.collection = `${PREFIX}-${ENV}-farm`;
            return config;
        }
    }

    let port = 3044;

    let platformUrl = 'http://localhost:' + port;

    const queries: FarmQueries = {
        farmById: '{"id": "{{id}}"}',
        coopById: '{"id": "{{id}}"}',
        coopByName: '{"payload.name": "{{id}}"}',
        coopByFarmId: '{"payload.farm_id": "{{id}}"}',
        henById: '{"id": "{{id}}"}',
        henByName: '{"payload.name": "{{name}}"}',
        henByCoopId: '{"payload.coop_id": "{{id}}"}',
    };

    farmEnv = new FarmEnv(dbFactories, queries, platformUrl, port);
    plugins = {"mongo": new MongoPlugin()}
    server = await farmEnv.buildService(plugins);

    // Initialize runtime properties in FarmEnv
    farmEnv.token = jwt.sign({ sub: 'test-user' }, 'totallyASecret', { expiresIn: '1h' });
    farmEnv.swaggerDocs = await farmEnv.getSwaggerDocs();
    farmEnv.apis = await farmEnv.buildApi(farmEnv.swaggerDocs, farmEnv.token);

    // Authorization certification: its own service, its own collection, so the
    // farm scenarios and the authz scenarios can't contaminate each other.
    const authzStorage: MongoConfig = { ...config, collection: `${PREFIX}-${ENV}-authz` };
    authzEnv = new AuthzEnv(
        authzStorage,
        { byId: queries.henById, byName: queries.henByName },
        // +100, not +1: the Fetch spec blocks a handful of ports (4045 among
        // them) and `fetch` refuses them outright.
        port + 100,
    );
    authzServer = await authzEnv.buildService(plugins);
});

Before(async function(this: FarmTestWorld & AuthzTestWorld) {
    this.server = server;
    this.env = farmEnv;
    this.authz = authzEnv;
});


AfterAll(async function(){
    await plugins["mongo"].cleanup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => authzServer.close(() => resolve()));
    await mongod.stop();
});

