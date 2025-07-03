import { Searcher, Repository } from '@meshobj/common';
import { SearcherCertification, TestTemplates } from '@meshobj/certification';
import { DTOFactory } from '@meshobj/graphlette';
import { NoOp, Auth } from '@meshobj/auth';
import { compile } from 'handlebars';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgresRepository } from '../src/postgresRepo';
import { PostgresSearcher } from '../src/postgresSearcher';
import { describe, beforeEach, afterAll, it, expect } from 'vitest';

let container: StartedPostgreSqlContainer;

const createSearcher = async (): Promise<{ repository: Repository; searcher: Searcher }> => {
    if (!container) {
        container = await new PostgreSqlContainer()
            .withUsername('postgres')
            .withPassword('password')
            .withDatabase('test')
            .start();
    }

    const tableName = `test_${Date.now()}`;
    const repository = new PostgresRepository({
        host: container.getHost(),
        port: container.getMappedPort(5432),
        database: 'test',
        user: 'postgres',
        password: 'password',
        table: tableName,
    });
    await repository.initialize();

    const dtoFactory = new DTOFactory([]);
    const auth: Auth = new NoOp();

    const searcher = new PostgresSearcher({
        host: container.getHost(),
        port: container.getMappedPort(5432),
        database: 'test',
        user: 'postgres',
        password: 'password',
        table: tableName,
    }, dtoFactory, auth);

    return { repository, searcher };
};

const tearDown = async (): Promise<void> => {
    if (container) {
        await container.stop();
    }
};

const findById = `id = '{{id}}'`;
const findByName = `payload->>'name' = '{{id}}'`;
const findAllByType = `payload->>'type' = '{{id}}'`;
const findByNameAndType = `payload->>'type' = '{{type}}' AND payload->>'name' = '{{name}}'`;

const templates: TestTemplates = {
    findById: compile(findById),
    findByName: compile(findByName),
    findAllByType: compile(findAllByType),
    findByNameAndType: compile(findByNameAndType),
};

describe('Postgres Searcher', () => {
    SearcherCertification(createSearcher, tearDown, templates, { describe, it, beforeEach, afterAll, expect }, ['TOKEN']);
});
