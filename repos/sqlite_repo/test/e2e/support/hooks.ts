import { Before, AfterAll, BeforeAll } from '@cucumber/cucumber';
import Log4js from 'log4js';
import { FarmTestWorld, DBFactories, FarmQueries} from '@tailoredshapes/meshql-cert';
import { SQLConfig, SQLitePlugin } from '../../../src';
import { Plugin } from '@tailoredshapes/meshql-server';
import { Server } from 'node:http';
import { FarmEnv } from '@tailoredshapes/meshql-cert';
import * as jwt from 'jsonwebtoken';
import fs from 'fs';

Log4js.configure({
    appenders: { out: { type: 'stdout' } },
    categories: { default: { appenders: ['out'], level: 'error' } },
});

let dbFactories: DBFactories;
let config: SQLConfig;
let plugins: Record<string, Plugin>;
let server: Server;
let farmEnv: FarmEnv;

BeforeAll({ timeout: 120000 }, async function() {
    const PREFIX = "cert";
    const ENV = "sqlite";

    const dbPath = "/tmp/test_sqlite_e2e.db";

    // Clean up the database file from previous runs
    if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
    }

    config = {
        type: ENV,
        uri: dbPath,
        collection: "CHANGE ME",
    };

    dbFactories = {
        henDB: (): SQLConfig => {
            return { ...config, collection: `${PREFIX}_${ENV}_hen` };
        },
        coopDB: (): SQLConfig => {
            return { ...config, collection: `${PREFIX}_${ENV}_coop` };
        },
        farmDB: (): SQLConfig => {
            return { ...config, collection: `${PREFIX}_${ENV}_farm` };
        }
    }

    let port = 5044;

    let platformUrl = 'http://localhost:' + port;

    const queries: FarmQueries = {
        farmById: `id = '{{id}}'`,
        coopById: `id = '{{id}}'`,
        coopByName: `json_extract(payload, '$.name') = '{{id}}'`,
        coopByFarmId: `json_extract(payload, '$.farm_id') = '{{id}}'`,
        henById: `id = '{{id}}'`,
        henByName: `json_extract(payload, '$.name') = '{{name}}'`,
        henByCoopId: `json_extract(payload, '$.coop_id') = '{{id}}'`,
    };

    farmEnv = new FarmEnv(dbFactories, queries, platformUrl, port);
    plugins = {"sqlite": new SQLitePlugin()}
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
    await plugins["sqlite"].cleanup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

