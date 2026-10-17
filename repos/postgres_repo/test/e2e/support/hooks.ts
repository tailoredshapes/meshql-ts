import { Before, AfterAll, BeforeAll } from '@cucumber/cucumber';
import Log4js from 'log4js';
import { AuthzTestWorld, ContractAuthzWorld } from '@tailoredshapes/meshql-cert';
import { PostgresConfig, PostgresPlugin } from '../../../src';
import { Plugin } from '@tailoredshapes/meshql-server';
import { Server } from 'node:http';
import { AuthzEnv, WidgetHarness } from '@tailoredshapes/meshql-cert';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

Log4js.configure({
    appenders: { out: { type: 'stdout' } },
    categories: { default: { appenders: ['out'], level: 'error' } },
});

let container: StartedPostgreSqlContainer | null = null;
let config: any;
let plugins: Record<string, Plugin>;
let authzEnv: AuthzEnv;
let authzServer: Server;
let widgetHarness: WidgetHarness;
let user = `postgres`;
let password = `password`;
let database = `test`;

BeforeAll({ timeout: 120000 }, async function () {
    container = await new PostgreSqlContainer('postgres:17-alpine3.21')
        .withUsername(user)
        .withPassword(password)
        .withDatabase(database)
        .start();

    const PREFIX = 'cert';
    const ENV = 'postgres';

    config = {
        type: ENV,
        host: container.getHost(),
        port: container.getMappedPort(5432),
        db: database,
        user: user,
        password: password,
    };

    let port = 4044;

    const queries = {
        henById: `id = '{{id}}'`,
        henByName: `payload->>'name' = '{{name}}'`,
    };

    plugins = { postgres: new PostgresPlugin() };

    // Authorization certification: its own service, its own table, so the
    // authz scenarios can't contaminate anything else.
    const authzStorage: PostgresConfig = { ...config, table: `${PREFIX}_${ENV}_authz` };
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
        (index: number): PostgresConfig => ({ ...config, table: `${PREFIX}_${ENV}_widget_${index}` }),
        { byId: queries.henById, byKind: `payload->>'kind' = '{{kind}}'` },
        plugins,
    );
});

Before(async function (this: AuthzTestWorld & ContractAuthzWorld) {
    this.authz = authzEnv;
    this.widgetHarness = widgetHarness;
});

AfterAll(async function () {
    await plugins['postgres'].cleanup();
    await new Promise<void>((resolve) => authzServer.close(() => resolve()));
    await container!.stop();
});
