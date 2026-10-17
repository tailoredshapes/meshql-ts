import { Before, AfterAll, BeforeAll } from '@cucumber/cucumber';
import { MongoMemoryServer } from 'mongodb-memory-server';
import Log4js from 'log4js';
import { AuthzTestWorld, ContractAuthzWorld } from '@tailoredshapes/meshql-cert';
import { MongoConfig, MongoPlugin } from '../../../src';
import { Plugin } from '@tailoredshapes/meshql-server';
import { Server } from 'node:http';
import { AuthzEnv, WidgetHarness } from '@tailoredshapes/meshql-cert';

Log4js.configure({
    appenders: { out: { type: 'stdout' } },
    categories: { default: { appenders: ['out'], level: 'error' } },
});

let mongod: MongoMemoryServer;
let config: MongoConfig;
let plugins: Record<string, Plugin>;
let authzEnv: AuthzEnv;
let authzServer: Server;
let widgetHarness: WidgetHarness;

BeforeAll({ timeout: 120000 }, async function () {
    mongod = new MongoMemoryServer();
    await mongod.start();

    const PREFIX = 'cert';
    const ENV = 'mongo';

    config = {
        type: ENV,
        uri: mongod.getUri(),
        db: `${PREFIX}_${ENV}`,
        collection: 'CHANGE ME',
        options: {
            directConnection: true,
        },
    };

    let port = 3044;

    const queries = {
        henById: '{"id": "{{id}}"}',
        henByName: '{"payload.name": "{{name}}"}',
    };

    plugins = { mongo: new MongoPlugin() };

    // Authorization certification: its own service, its own collection, so the
    // authz scenarios can't contaminate anything else.
    const authzStorage: MongoConfig = { ...config, collection: `${PREFIX}-${ENV}-authz` };
    authzEnv = new AuthzEnv(
        authzStorage,
        { byId: queries.henById, byName: queries.henByName },
        // +100, not +1: the Fetch spec blocks a handful of ports (4045 among
        // them) and `fetch` refuses them outright.
        port + 100,
    );
    authzServer = await authzEnv.buildService(plugins);

    // The shared authorization contract. It lists every widget and asserts
    // the result exactly, so each scenario gets its own service over its own
    // empty storage, on whatever port the OS hands it.
    widgetHarness = new WidgetHarness(
        (index: number): MongoConfig => ({ ...config, collection: `${PREFIX}-${ENV}-widget-${index}` }),
        { byId: queries.henById, byKind: `{"payload.kind": "{{kind}}"}` },
        plugins,
    );
});

Before(async function (this: AuthzTestWorld & ContractAuthzWorld) {
    this.authz = authzEnv;
    this.widgetHarness = widgetHarness;
});

AfterAll(async function () {
    await plugins['mongo'].cleanup();
    await new Promise<void>((resolve) => authzServer.close(() => resolve()));
    await mongod.stop();
});
