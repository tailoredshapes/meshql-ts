import { Searcher, Envelope, Repository } from '@meshobj/common';
import { SearcherCertification, TestTemplates } from '@meshobj/certification';
import { DTOFactory } from '@meshobj/graphlette';
import { NoOp, Auth } from '@meshobj/auth';
import { compile } from 'handlebars';
import { Database, open } from 'sqlite';
import sqlite3 from 'sqlite3';
import { SQLiteRepository } from '../src/sqliteRepo';
import { SQLiteSearcher } from '../src/sqliteSearcher';
import { describe, beforeEach, afterAll, it, expect } from 'vitest';

const dbs: Database[] = [];

const createSearcher = async (): Promise<{ repository: Repository; searcher: Searcher }> => {
    let db = await open({ filename: ':memory:', driver: sqlite3.Database });

    dbs.push(db);
    // Generate a random table name that is valid for SQLite
    const name = `tbl_${Math.random().toString(36).substring(2, 15)}`;
    let repo = new SQLiteRepository(db, name);

    await repo.initialize();

    let dtoFactory = new DTOFactory([]);
    let auth: Auth = new NoOp();

    return { repository: repo, searcher: new SQLiteSearcher(db, name, dtoFactory, auth) };
};

const tearDown = async (): Promise<void> => {
    await Promise.all(
        dbs.map((db) => {
            db.close();
        }),
    );
};

const findById = `id = '{{id}}'`;

const findByName = `json_extract(payload, '$.name') = '{{id}}'`;

const findAllByType = `json_extract(payload, '$.type') = '{{id}}'`;

const findByNameAndType = `json_extract(payload, '$.type') = '{{type}}' AND json_extract(payload, '$.name') = '{{name}}'`;

const templates: TestTemplates = {
    findById: compile(findById),
    findByName: compile(findByName),
    findAllByType: compile(findAllByType),
    findByNameAndType: compile(findByNameAndType),
};

describe('SQLite Searcher', () => {
    SearcherCertification(createSearcher, tearDown, templates, { describe, it, beforeEach, afterAll, expect }, ['TOKEN']);
});
