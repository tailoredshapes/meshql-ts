import { Repository } from '@meshobj/common';
import { PostgresRepository } from '../src/postgresRepo'; // Assuming the repository is in this file
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RepositoryCertification } from '@meshobj/certification';
import { Environment } from 'testcontainers/build/types';
import { describe, beforeEach, afterAll, it, expect } from 'vitest';

let container: StartedPostgreSqlContainer;

const createRepository = async (): Promise<Repository> => {
    if (!container) {
        container = await new PostgreSqlContainer()
            .withUsername('postgres')
            .withPassword('password')
            .withDatabase('test')
            .start();
    }

    const repo = new PostgresRepository({
        host: container.getHost(),
        port: container.getMappedPort(5432),
        database: 'test',
        user: 'postgres',
        password: 'password',
        table: `test_${Date.now()}`,
    });

    await repo.initialize();
    return repo;
};

const tearDown = async (): Promise<void> => {
    if (container) {
        await container.stop();
    }
};

describe('Postgres Repo', () => {
    RepositoryCertification(createRepository, tearDown, { describe, it, beforeEach, afterAll, expect });
});
