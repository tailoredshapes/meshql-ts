import { Before, AfterAll, BeforeAll } from '@cucumber/cucumber';
import Log4js from 'log4js';
import { FarmTestWorld, DBFactories, FarmQueries } from '@tailoredshapes/meshql-cert';
import { MySQLConfig, MySQLPlugin } from '../../../src';
import { Plugin } from '@tailoredshapes/meshql-server';
import { Server } from 'node:http';
import { FarmEnv } from '@tailoredshapes/meshql-cert';
import * as jwt from 'jsonwebtoken';
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

BeforeAll({ timeout: 120000 }, async function() {
    container = await new MySqlContainer().start();

    const PREFIX = "cert";
    const ENV = "mysql";

    config = {
        type: ENV,
        host: container.getHost(),
        port: container.getPort(),
        db: container.getDatabase(),
        user: container.getUsername(),
        password: container.getUserPassword(),
        table: "CHANGE ME",
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
        }
    }

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
    plugins = {"mysql": new MySQLPlugin()}
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
    await plugins["mysql"].cleanup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await container.stop();
});

