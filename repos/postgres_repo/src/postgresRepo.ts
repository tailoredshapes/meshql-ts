import { Pool, types } from 'pg';
import { v4 as uuid } from 'uuid';
import { Envelope, Id, Repository, getLogger } from '@tailoredshapes/meshql-common';

const logger = getLogger('meshql-ts/postgres_repo');

export class PostgresRepository implements Repository {
    private pool: Pool;
    private table: string;

    constructor(pool: Pool, table: string) {
        this.pool = pool;
        this.table = table;
    }

    async initialize(): Promise<void> {
        const TIMESTAMP_OID = 1114; // TIMESTAMP without time zone
        const TIMESTAMPTZ_OID = 1184; // TIMESTAMP with time zone

        // Override the default parsers for timestamps
        types.setTypeParser(TIMESTAMP_OID, (value: string) => new Date(value));
        types.setTypeParser(TIMESTAMPTZ_OID, (value: string) => new Date(value));

        // The table has a primary key "pk" but we also add a unique constraint on (id, created_at)
        const query = `
            CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

            CREATE TABLE IF NOT EXISTS ${this.table} (
                pk UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
                id TEXT,
                payload JSONB,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
                deleted BOOLEAN DEFAULT FALSE,
                authorized_tokens TEXT[],
                CONSTRAINT ${this.table}_id_created_at_uniq UNIQUE (id, created_at)
            );
        `;
        await this.pool.query(query);

        await this.pool.query(`
            CREATE INDEX IF NOT EXISTS idx_${this.table}_id
            ON ${this.table} (id);
        `);

        await this.pool.query(`
            CREATE INDEX IF NOT EXISTS idx_${this.table}_created_at
            ON ${this.table} (created_at);
        `);

        await this.pool.query(`
            CREATE INDEX IF NOT EXISTS idx_${this.table}_deleted
            ON ${this.table} (deleted);
        `);

        await this.pool.query(`
            CREATE INDEX IF NOT EXISTS idx_${this.table}_tokens
            ON ${this.table} USING GIN (authorized_tokens);
        `);
    }

    /**
     * Create one record. If the UNIQUE (id, created_at) constraint
     * fails, wait 2ms and retry up to 5 times.
     */
    create = async (doc: Envelope, readers: string[] = [], retryCount = 0): Promise<Envelope> => {
        const maxRetries = 5;
        const query = `
            INSERT INTO ${this.table} (id, payload, created_at, updated_at, deleted, authorized_tokens)
            VALUES ($1, $2::jsonb, NOW(), NOW(), FALSE, $3)
            RETURNING *;
        `;
        const logicalId = doc.id || uuid();
        const values = [logicalId, doc.payload, readers];

        try {
            const result = await this.pool.query(query, values);
            const row = result.rows[0];
            return {
                id: row.id,
                payload: row.payload,
                created_at: row.created_at,
                deleted: !!row.deleted,
            };
        } catch (err: any) {
            // Postgres uses "23505" for unique violation
            if (err.code === '23505' && retryCount < maxRetries) {
                await new Promise((resolve) => setTimeout(resolve, 2));
                return this.create(doc, readers, retryCount + 1);
            }
            throw err;
        }
    };

    /**
     * Create many records. If any insert conflicts on (id, created_at),
     * retry (sleep 2ms, up to 5 times) for each doc.
     */
    createMany = async (docs: Envelope[], readers: string[] = []): Promise<Envelope[]> => {
        const created: Envelope[] = [];
        for (const doc of docs) {
            created.push(await this.create(doc, readers));
        }
        return created;
    };

    // Read the latest non-deleted version by id, sorted by created_at descending.
    read = async (id: Id, tokens: string[] = [], createdAt: Date = new Date()): Promise<Envelope | undefined> => {
        const query = `
            SELECT *
            FROM ${this.table}
            WHERE id = $1
              AND deleted IS FALSE
              AND created_at <= $2
              ${tokens.length > 0 ? 'AND authorized_tokens && $3' : ''}
            ORDER BY created_at DESC
            LIMIT 1;
        `;
        const values = tokens.length > 0 ? [id, createdAt, tokens] : [id, createdAt];
        const result = await this.pool.query(query, values);
        const row = result.rows[0];

        if (!row) return undefined;
        return {
            id: row.id,
            payload: row.payload,
            created_at: row.created_at,
            deleted: !!row.deleted,
        };
    };

    // Read the latest version of multiple ids at once.
    readMany = async (ids: Id[], readers: string[] = []): Promise<Envelope[]> => {
        if (!ids.length) return [];

        const query = `
            SELECT DISTINCT ON (id) *
            FROM ${this.table}
            WHERE id = ANY($1)
              AND deleted IS FALSE
              ${readers.length > 0 ? 'AND authorized_tokens && $2' : ''}
            ORDER BY id, created_at DESC;
        `;
        const values = readers.length > 0 ? [ids, readers] : [ids];
        const result = await this.pool.query(query, values);

        return result.rows.map((row) => ({
            id: row.id,
            payload: row.payload,
            created_at: row.created_at,
            deleted: !!row.deleted,
        }));
    };

    remove = async (id: Id, readers: string[] = []): Promise<boolean> => {
        const query = `
            UPDATE ${this.table}
            SET deleted = TRUE
            WHERE id = $1
            ${readers.length > 0 ? 'AND authorized_tokens && $2' : ''};
        `;
        const values = readers.length > 0 ? [id, readers] : [id];

        await this.pool.query(query, values);
        return true;
    };

    removeMany = async (ids: Id[], readers: string[] = []): Promise<Record<Id, boolean>> => {
        if (!ids.length) return {};

        const query = `
            UPDATE ${this.table}
            SET deleted = TRUE
            WHERE id = ANY($1)
            ${readers.length > 0 ? 'AND authorized_tokens && $2' : ''};
        `;
        const values = readers.length > 0 ? [ids, readers] : [ids];
        await this.pool.query(query, values);

        return ids.reduce(
            (acc, docId) => {
                acc[docId] = true;
                return acc;
            },
            {} as Record<Id, boolean>,
        );
    };

    list = async (readers: string[] = []): Promise<Envelope[]> => {
        const query = `
            SELECT DISTINCT ON (id) *
            FROM ${this.table}
            WHERE deleted IS FALSE
            ${readers.length > 0 ? 'AND readers && $1' : ''}
            ORDER BY id, created_at DESC;
        `;
        const values = readers.length > 0 ? [readers] : [];
        const result = await this.pool.query(query, values);

        var all: Envelope[] = result.rows.map((row) => ({
            id: row.id,
            payload: row.payload,
            created_at: row.created_at,
            deleted: !!row.deleted,
        }));

        logger.debug("List query results", { 
            count: all.length,
            results: all.map(obj => ({
                id: obj.id,
                payload: obj.payload,
                created_at: obj.created_at?.getTime(),
                deleted: !!obj.deleted
            }))
        });
        return all;
    };

    ready = async (): Promise<boolean> => {
        try {
            await this.pool.query('SELECT 1');
            return true;
        } catch {
            return false;
        }
    };
}
