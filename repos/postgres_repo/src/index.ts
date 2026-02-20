export { PostgresSearcher } from './postgresSearcher';
export { PostgresRepository } from './postgresRepo';

import { Pool, PoolConfig } from 'pg';
import { StorageConfig } from '@tailoredshapes/meshql-server';
import { PostgresSearcher } from './postgresSearcher';
import { PostgresRepository } from './postgresRepo';

import { DTOFactory } from '@tailoredshapes/meshql-graphlette';
import { Auth } from '@tailoredshapes/meshql-auth';
import { Repository } from '@tailoredshapes/meshql-common';
import { Plugin } from '@tailoredshapes/meshql-server';
/**
 * Creates and returns a Postgres Pool connection.
 */
export interface PostgresConfig extends StorageConfig {
    host: string;
    port: number;
    db: string;
    user: string;
    password: string;
    table: string;
}

export function buildPostgresPool(config: PostgresConfig, pools: Record<string, Pool>): Pool {
    let pgConf: PoolConfig = {
        host: config.host,
        port: config.port,
        database: config.db,
        user: config.user,
        password: config.password,
    };
    let key = `${pgConf.host}:${pgConf.port}:${pgConf.database}:${pgConf.user}:${pgConf.password}`;

    if (!pools[key]) {
        pools[key] = new Pool(pgConf);
    }
    return pools[key];
}

export class PostgresPlugin implements Plugin {
    private pools: Record<string, Pool>;

    constructor() {
        this.pools = {};
    }

    async createRepository(config: StorageConfig) {
        return createPostgresRepository(config as PostgresConfig, this.pools);
    }

    async createSearcher(config: StorageConfig, dtoFactory: DTOFactory, auth: Auth) {
        return createPostgresSearcher(config as PostgresConfig, dtoFactory, auth, this.pools);
    }

    async cleanup() {
        for (const pool of Object.values(this.pools)) {
            await pool.end();
        }
    }
}
/**
 * Creates a PostgresSearcher with the given config, DTOFactory, and auth.
 */
export function createPostgresSearcher(
    pgConfig: PostgresConfig,
    dtoFactory: DTOFactory,
    auth: Auth,
    pools: Record<string, Pool>,
): PostgresSearcher {
    const pool = buildPostgresPool(pgConfig, pools);
    return new PostgresSearcher(pool, pgConfig.table, dtoFactory, auth);
}

/**
 * Creates a PostgresRepository with the given config.
 */
export async function createPostgresRepository(
    pgConfig: PostgresConfig,
    pools: Record<string, Pool>,
): Promise<Repository> {
    const pool = buildPostgresPool(pgConfig, pools);
    const repo = new PostgresRepository(pool, pgConfig.table);
    await repo.initialize();
    return repo;
}
