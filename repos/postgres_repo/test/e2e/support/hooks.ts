import { Before, AfterAll, BeforeAll } from '@cucumber/cucumber';
import Log4js from 'log4js';
import { FarmTestWorld, DBFactories, FarmQueries} from '@tailoredshapes/meshql-cert';
import { PostgresConfig, PostgresPlugin } from '../../../src';
import { Plugin } from '@tailoredshapes/meshql-server';
import { Server } from 'node:http';
import { FarmEnv } from '@tailoredshapes/meshql-cert';
import * as jwt from 'jsonwebtoken';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

Log4js.configure({
    appenders: { out: { type: 'stdout' } },
    categories: { default: { appenders: ['out'], level: 'error' } },
});

let container: StartedPostgreSqlContainer | null = null;
let dbFactories: DBFactories;
let config: any;
let plugins: Record<string, Plugin>;
let server: Server;
let farmEnv: FarmEnv;
let user = `postgres`;
let password = `password`;
let database = `test`;

BeforeAll({ timeout: 120000 }, async function() {
    container = await new PostgreSqlContainer("postgres:17-alpine3.21")
        .withUsername(user)
        .withPassword(password)
        .withDatabase(database)
        .start();

    const PREFIX = "cert";
    const ENV = "postgres";

    config = {
        type: ENV,
        host: container.getHost(),
        port: container.getMappedPort(5432),
        db: database,
        user: user,
        password: password,
    };

    dbFactories = {
        henDB: (): PostgresConfig => {
            return { ...config, table: `${PREFIX}_${ENV}_hen` };
        },
        coopDB: (): PostgresConfig => {
            return { ...config, table: `${PREFIX}_${ENV}_coop` };
        },
        farmDB: (): PostgresConfig => {
            return { ...config, table: `${PREFIX}_${ENV}_farm` };
        }
    }

    let port = 4044;

    let platformUrl = 'http://localhost:' + port;

    const queries: FarmQueries = {
        farmById: `id = '{{id}}'`,
        coopById: `id = '{{id}}'`,
        coopByName: `payload->>'name' = '{{id}}'`,
        coopByFarmId: `payload->>'farm_id' = '{{id}}'`,
        henById: `id = '{{id}}'`,
        henByName: `payload->>'name' = '{{name}}'`,
        henByCoopId: `payload->>'coop_id' = '{{id}}'`,
    };

    farmEnv = new FarmEnv(dbFactories, queries, platformUrl, port);
    plugins = {"postgres": new PostgresPlugin()}
    server = await farmEnv.buildService(plugins);

    // Initialize runtime properties in FarmEnv
    farmEnv.token = jwt.sign({ sub: 'test-user' }, 'totallyASecret', { expiresIn: '1h' });
    farmEnv.swaggerDocs = await farmEnv.getSwaggerDocs();
    farmEnv.apis = await farmEnv.buildApi(farmEnv.swaggerDocs, farmEnv.token);
});

Before(async function(this: FarmTestWorld) {
    this.server = server;
    this.env = farmEnv;
});


AfterAll(async function(){
    await plugins["postgres"].cleanup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await container!.stop();
});

