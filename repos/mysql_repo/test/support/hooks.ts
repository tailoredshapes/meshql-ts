import { Before, After, AfterAll, BeforeAll, setDefaultTimeout } from '@cucumber/cucumber';
import { TestWorld } from 'core/common/test/support/worlds';
import { FarmTestWorld } from '@tailoredshapes/meshql-common/test/steps/farm_steps';
import { MySQLRepository } from '../../src/mysqlRepo';
import { MySQLSearcher } from '../../src/mysqlSearcher';
import { createPool, Pool } from 'mysql2/promise';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { compile } from 'handlebars';
import { DTOFactory } from '@tailoredshapes/meshql-graphlette';
import { NoOp } from '@tailoredshapes/meshql-auth';
import { randomUUID } from 'crypto';
import { init, Plugin, StorageConfig } from '@tailoredshapes/meshql-server';
import { Auth } from '@tailoredshapes/meshql-auth';
import * as jwt from 'jsonwebtoken';
import { config as getFarmConfig } from '../config';
import Log4js from 'log4js';
import { MySQLConfig } from '../../src';

Log4js.configure({
    appenders: { out: { type: 'stdout' } },
    categories: { default: { appenders: ['out'], level: 'error' } },
});

// MySQLPlugin class defined inline
class MySQLPlugin implements Plugin {
    private pools: Pool[] = [];

    async createRepository(config: StorageConfig) {
        const mysqlConfig = config as MySQLConfig;
        const pool = createPool({
            host: mysqlConfig.host,
            port: mysqlConfig.port,
            user: mysqlConfig.user,
            password: mysqlConfig.password,
            database: mysqlConfig.db,
            waitForConnections: true,
            connectionLimit: 10,
        });
        this.pools.push(pool);

        const repo = new MySQLRepository(pool, mysqlConfig.db);
        await repo.initialize();
        return repo;
    }

    async createSearcher(config: StorageConfig, dtoFactory: DTOFactory, auth: Auth) {
        const mysqlConfig = config as MySQLConfig;
        const pool = createPool({
            host: mysqlConfig.host,
            port: mysqlConfig.port,
            user: mysqlConfig.user,
            password: mysqlConfig.password,
            database: mysqlConfig.db,
            waitForConnections: true,
            connectionLimit: 10,
        });
        this.pools.push(pool);

        return new MySQLSearcher(pool, mysqlConfig.table, dtoFactory, auth);
    }

    async cleanup() {
        await Promise.all(this.pools.map(pool => pool.end()));
        this.pools = [];
    }
}

setDefaultTimeout(60000);

let container: StartedTestContainer;
let pools: Pool[] = [];
let globalFarmServer: any = null;

// Setup for farm tests
BeforeAll(async function() {
    // Start MySQL container for farm tests
    if (!container) {
        container = await new GenericContainer('mysql:8.0')
            .withEnvironment({
                MYSQL_ROOT_PASSWORD: 'root',
                MYSQL_DATABASE: 'test',
            })
            .withExposedPorts(3306)
            .start();
    }

    const config = await getFarmConfig();
    // Override connection settings to use test container
    const mysqlSettings = {
        host: container.getHost(),
        port: container.getMappedPort(3306),
        user: 'root',
        password: 'root',
        database: 'test',
    };
    config.graphlettes.forEach((g: any) => Object.assign(g.storage, mysqlSettings));
    config.restlettes.forEach((r: any) => Object.assign(r.storage, mysqlSettings));

    const token = jwt.sign({ sub: 'test-user' }, 'totallyASecret', { expiresIn: '1h' });
    const plugin = new MySQLPlugin();

    try {
        const app = await init(config, { mysql: plugin });
        const server = await app.listen(config.port);

        globalFarmServer = {
            app,
            server,
            config,
            token,
            plugin
        };
    } catch (e) {
        console.error('Failed to setup farm server:', e);
        throw e;
    }
});

Before(async function(this: TestWorld & FarmTestWorld) {
    if (!container) {
        container = await new GenericContainer('mysql:8.0')
            .withEnvironment({
                MYSQL_ROOT_PASSWORD: 'root',
                MYSQL_DATABASE: 'test',
            })
            .withExposedPorts(3306)
            .start();
    }

    // For repository/searcher tests
    this.createRepository = async () => {
        const pool = createPool({
            host: container.getHost(),
            port: container.getMappedPort(3306),
            user: 'root',
            password: 'root',
            database: 'test',
            waitForConnections: true,
            connectionLimit: 10,
            maxIdle: 10,
            idleTimeout: 60000,
            queueLimit: 0,
            enableKeepAlive: true,
            keepAliveInitialDelay: 0,
        });
        pools.push(pool);

        const repo = new MySQLRepository(pool, tableName);
        await repo.initialize();
        return repo;
    };

    this.createSearcher = async () => {
        const pool = createPool({
            host: container.getHost(),
            port: container.getMappedPort(3306),
            user: 'root',
            password: 'root',
            database: 'test',
            waitForConnections: true,
            connectionLimit: 10,
            maxIdle: 10,
            idleTimeout: 60000,
            queueLimit: 0,
            enableKeepAlive: true,
            keepAliveInitialDelay: 0,
        });
        pools.push(pool);

        const repo = new MySQLRepository(pool, tableName);
        await repo.initialize();

        const dtoFactory = new DTOFactory([]);
        const auth = new NoOp();
        const searcher = new MySQLSearcher(pool, tableName, dtoFactory, auth);

        return { repository: repo, searcher };
    };

    this.tearDown = async () => {
        await Promise.all(pools.map(pool => pool.end()));
        pools = [];
    };

    // Templates for searcher tests - MySQL SQL syntax
    this.templates = {
        findById: compile(`id = '{{id}}'`),
        findByName: compile(`JSON_EXTRACT(payload, '$.name') = '{{id}}'`),
        findAllByType: compile(`JSON_EXTRACT(payload, '$.type') = '{{id}}'`),
        findByNameAndType: compile(`JSON_EXTRACT(payload, '$.type') = '{{type}}' AND JSON_EXTRACT(payload, '$.name') = '{{name}}'`),
    };

    // For farm tests - share global server state
    if (globalFarmServer) {
        this.app = globalFarmServer.app;
        this.server = globalFarmServer.server;
        this.config = globalFarmServer.config;
        this.token = globalFarmServer.token;
        this.farm_id = globalFarmServer.farm_id;
        this.coop_ids = globalFarmServer.coop_ids;
        this.hen_ids = globalFarmServer.hen_ids;
        this.first_stamp = globalFarmServer.first_stamp;
    }
});

After(async function(this: TestWorld) {
    if (this.tearDown) {
        await this.tearDown();
    }
});

AfterAll(async () => {
    if (globalFarmServer) {
        await globalFarmServer.plugin.cleanup();
        if (globalFarmServer.server) {
            globalFarmServer.server.close();
        }
        globalFarmServer = null;
    }

    if (container) {
        await container.stop();
    }
});