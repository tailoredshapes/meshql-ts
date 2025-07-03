import { SearcherCertification, TestTemplates } from '@meshobj/certification';
import { createPool, Pool } from 'mysql2/promise';
import { MySQLSearcher } from '../src/mysqlSearcher';
import { MySQLRepository } from '../src/mysqlRepo';
import { compile } from 'handlebars';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { randomUUID } from 'crypto';
import { DTOFactory } from '@meshobj/graphlette';
import { NoOp } from '@meshobj/auth';
import { describe, beforeEach, afterAll, it, expect } from 'vitest';

const pools: Pool[] = [];
let container: StartedTestContainer;

const createSearcher = async () => {
    if (!container) {
        container = await new GenericContainer('mysql:8.0')
            .withEnvironment({
                MYSQL_ROOT_PASSWORD: 'root',
                MYSQL_DATABASE: 'test',
            })
            .withExposedPorts(3306)
            .start();
    }

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
    const tableName = `test_${randomUUID().replace(/-/g, '')}`;
    const repository = new MySQLRepository(pool, tableName);
    await repository.initialize();

    const dtoFactory = new DTOFactory([]);

    const auth = new NoOp();

    const searcher = new MySQLSearcher(pool, tableName, dtoFactory, auth);
    return { repository, searcher };
};

const tearDown = async (): Promise<void> => {
    await Promise.all(pools.map((pool) => pool.end()));
    if (container) {
        await container.stop();
    }
};

const findById = `id = '{{id}}'`;

const findByName = `JSON_EXTRACT(payload, '$.name') = '{{id}}'`;

const findAllByType = `JSON_EXTRACT(payload, '$.type') = '{{id}}'`;

const findByNameAndType = `JSON_EXTRACT(payload, '$.type') = '{{type}}' AND JSON_EXTRACT(payload, '$.name') = '{{name}}'`;

const templates: TestTemplates = {
    findById: compile(findById),
    findByName: compile(findByName),
    findAllByType: compile(findAllByType),
    findByNameAndType: compile(findByNameAndType),
};

describe('MySQL Searcher', () => {
    SearcherCertification(createSearcher, tearDown, templates, { describe, it, beforeEach, afterAll, expect });
});
