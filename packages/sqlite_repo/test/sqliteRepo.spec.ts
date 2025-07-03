import { Repository } from '@meshobj/common';
import { RepositoryCertification } from '@meshobj/certification';
import { SQLiteRepository } from '../src/sqliteRepo';
import { Database, open } from 'sqlite';
import sqlite3 from 'sqlite3';
import { describe, beforeEach, afterAll, it, expect } from 'vitest';

const dbs: Database[] = [];

const createRepository = async (): Promise<Repository> => {
    let db = await open({ filename: ':memory:', driver: sqlite3.Database });
    dbs.push(db);
    
    // Generate a random table name that is valid for SQLite
    const name = `tbl_${Math.random().toString(36).substring(2, 15)}`;
    let repo = new SQLiteRepository(db, name);
    await repo.initialize();
    return repo;
};

const tearDown = async (): Promise<void> => {
    await Promise.all(
        dbs.map((db) => {
            db.close();
        }),
    );
};

describe('SQLite Repo', () => {
    RepositoryCertification(createRepository, tearDown, { describe, it, beforeEach, afterAll, expect });
});
