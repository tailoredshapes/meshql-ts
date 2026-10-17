import { Before, AfterAll, BeforeAll } from '@cucumber/cucumber';
import Log4js from 'log4js';
import { AuthzTestWorld, ContractAuthzWorld } from '@tailoredshapes/meshql-cert';
import { SQLConfig, SQLitePlugin } from '../../../src';
import { Plugin } from '@tailoredshapes/meshql-server';
import { Server } from 'node:http';
import { AuthzEnv, WidgetHarness, EggHarness, EggWorld } from '@tailoredshapes/meshql-cert';
import fs from 'fs';

Log4js.configure({
    appenders: { out: { type: 'stdout' } },
    categories: { default: { appenders: ['out'], level: 'error' } },
});

let config: SQLConfig;
let plugins: Record<string, Plugin>;
let authzEnv: AuthzEnv;
let authzServer: Server;
let widgetHarness: WidgetHarness;
let eggHarness: EggHarness;

BeforeAll({ timeout: 120000 }, async function () {
    const PREFIX = 'cert';
    const ENV = 'sqlite';

    const dbPath = '/tmp/test_sqlite_e2e.db';

    // Clean up the database file from previous runs
    if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
    }

    config = {
        type: ENV,
        uri: dbPath,
        collection: 'CHANGE ME',
    };

    let port = 5044;

    const queries = {
        henById: `id = '{{id}}'`,
        henByName: `json_extract(payload, '$.name') = '{{name}}'`,
    };

    plugins = { sqlite: new SQLitePlugin() };

    // Authorization certification: its own service, its own table, so the
    // authz scenarios can't contaminate anything else.
    const authzStorage: SQLConfig = { ...config, collection: `${PREFIX}_${ENV}_authz` };
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
        (index: number): SQLConfig => ({ ...config, collection: `${PREFIX}_${ENV}_widget_${index}` }),
        { byId: queries.henById, byKind: `json_extract(payload, '$.kind') = '{{kind}}'` },
        plugins,
    );

    // The egg economy: fourteen entities per scenario, each in its own table.
    eggHarness = new EggHarness(
        (entity, scenario): SQLConfig => ({ ...config, collection: `${PREFIX}_${ENV}_egg${scenario}_${entity}` }),
        {
            byId: queries.henById,
            where: (field, arg) => `json_extract(payload, '$.${field}') = '{{${arg}}}'`,
        },
        plugins,
    );
});

Before(async function (this: AuthzTestWorld & ContractAuthzWorld & EggWorld) {
    this.authz = authzEnv;
    this.widgetHarness = widgetHarness;
    this.eggs = eggHarness;
});

AfterAll(async function () {
    await plugins['sqlite'].cleanup();
    await new Promise<void>((resolve) => authzServer.close(() => resolve()));
});
