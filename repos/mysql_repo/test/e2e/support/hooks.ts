import { Before, AfterAll, BeforeAll } from '@cucumber/cucumber';
import Log4js from 'log4js';
import {
    FarmTestWorld,
    DBFactories,
    FarmQueries,
    AuthzTestWorld,
    ContractAuthzWorld,
    unverifiedToken,
} from '@tailoredshapes/meshql-cert';
import { MySQLConfig, MySQLPlugin } from '../../../src';
import { Plugin } from '@tailoredshapes/meshql-server';
import { Server } from 'node:http';
import { FarmEnv, AuthzEnv, WidgetHarness } from '@tailoredshapes/meshql-cert';
import { MySqlContainer, StartedMySqlContainer } from '@testcontainers/mysql';

Log4js.configure({
    appenders: { out: { type: 'stdout' } },
    categories: { default: { appenders: ['out'], level: 'error' } },
});

let container: StartedMySqlContainer;
let dbFactories: DBFactories;
let config: MySQLConfig;
let plugins: Record<string, Plugin>;
let server: Server;
let farmEnv: FarmEnv;
let authzEnv: AuthzEnv;
let authzServer: Server;
let widgetHarness: WidgetHarness;

BeforeAll({ timeout: 120000 }, async function () {
    container = await new MySqlContainer().start();

    const PREFIX = 'cert';
    const ENV = 'mysql';

    config = {
        type: ENV,
        host: container.getHost(),
        port: container.getPort(),
        db: container.getDatabase(),
        user: container.getUsername(),
        password: container.getUserPassword(),
        table: 'CHANGE ME',
    };

    dbFactories = {
        henDB: (): MySQLConfig => {
            return { ...config, table: `${PREFIX}_${ENV}_hen` };
        },
        coopDB: (): MySQLConfig => {
            return { ...config, table: `${PREFIX}_${ENV}_coop` };
        },
        farmDB: (): MySQLConfig => {
            return { ...config, table: `${PREFIX}_${ENV}_farm` };
        },
    };

    let port = 6044;

    let platformUrl = 'http://localhost:' + port;

    const queries: FarmQueries = {
        farmById: `id = '{{id}}'`,
        coopById: `id = '{{id}}'`,
        coopByName: `JSON_UNQUOTE(JSON_EXTRACT(payload, '$.name')) = '{{id}}'`,
        coopByFarmId: `JSON_UNQUOTE(JSON_EXTRACT(payload, '$.farm_id')) = '{{id}}'`,
        henById: `id = '{{id}}'`,
        henByName: `JSON_UNQUOTE(JSON_EXTRACT(payload, '$.name')) = '{{name}}'`,
        henByCoopId: `JSON_UNQUOTE(JSON_EXTRACT(payload, '$.coop_id')) = '{{id}}'`,
    };

    farmEnv = new FarmEnv(dbFactories, queries, platformUrl, port);
    plugins = { mysql: new MySQLPlugin() };
    server = await farmEnv.buildService(plugins);

    // Initialize runtime properties in FarmEnv
    farmEnv.token = unverifiedToken('test-user');
    farmEnv.swaggerDocs = await farmEnv.getSwaggerDocs();
    farmEnv.apis = await farmEnv.buildApi(farmEnv.swaggerDocs, farmEnv.token);

    // Authorization certification: its own service, its own table, so the
    // farm scenarios and the authz scenarios can't contaminate each other.
    const authzStorage: MySQLConfig = { ...config, table: `${PREFIX}_${ENV}_authz` };
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
        (index: number): MySQLConfig => ({ ...config, table: `${PREFIX}_${ENV}_widget_${index}` }),
        { byId: queries.henById, byKind: `JSON_UNQUOTE(JSON_EXTRACT(payload, '$.kind')) = '{{kind}}'` },
        plugins,
    );
});

Before(async function (this: FarmTestWorld & AuthzTestWorld & ContractAuthzWorld) {
    this.server = server;
    this.env = farmEnv;
    this.authz = authzEnv;
    this.widgetHarness = widgetHarness;
});

AfterAll(async function () {
    await plugins['mysql'].cleanup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => authzServer.close(() => resolve()));
    await container.stop();
});
