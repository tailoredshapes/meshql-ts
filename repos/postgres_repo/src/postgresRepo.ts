import { Pool, types } from 'pg';
import { v4 as uuid } from 'uuid';
import { authorized, Envelope, Id, Repository, Session, getLogger } from '@tailoredshapes/meshql-common';

const logger = getLogger('meshql-ts/postgres_repo');

/** `undefined` must reach the column as SQL NULL, not as the JSON string "null". */
const marshalAuth = (auth: unknown): string | null => (auth === undefined ? null : JSON.stringify(auth));

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

        // `auth` is JSONB rather than the TEXT[] the token rule used to need.
        // The mark is opaque now: a plugin may stamp a list, an object, or
        // nothing, and this column has to hold whatever it stamps.
        const query = `
            CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

            CREATE TABLE IF NOT EXISTS ${this.table} (
                pk UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
                id TEXT,
                payload JSONB,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
                deleted BOOLEAN DEFAULT FALSE,
                auth JSONB,
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
    }

    private static toEnvelope(row: any): Envelope {
        return {
            id: row.id,
            payload: row.payload,
            created_at: row.created_at,
            deleted: !!row.deleted,
            auth: row.auth === null ? undefined : row.auth,
        };
    }

    /**
     * Insert one version. If the UNIQUE (id, created_at) constraint fails,
     * wait 2ms and retry up to 5 times.
     */
    private insert = async (stamped: Envelope, retryCount = 0): Promise<Envelope> => {
        const maxRetries = 5;
        const query = `
            INSERT INTO ${this.table} (id, payload, created_at, updated_at, deleted, auth)
            VALUES ($1, $2::jsonb, NOW(), NOW(), FALSE, $3::jsonb)
            RETURNING *;
        `;
        const logicalId = stamped.id || uuid();
        const values = [logicalId, stamped.payload, marshalAuth(stamped.auth)];

        try {
            const result = await this.pool.query(query, values);
            return PostgresRepository.toEnvelope(result.rows[0]);
        } catch (err: any) {
            // Postgres uses "23505" for unique violation
            if (err.code === '23505' && retryCount < maxRetries) {
                await new Promise((resolve) => setTimeout(resolve, 2));
                return this.insert(stamped, retryCount + 1);
            }
            throw err;
        }
    };

    create = async (doc: Envelope, session: Session): Promise<Envelope> => {
        return this.insert(await session.stamp(doc));
    };

    createMany = async (docs: Envelope[], session: Session): Promise<Envelope[]> => {
        const created: Envelope[] = [];
        for (const doc of docs) {
            created.push(await this.insert(await session.stamp(doc)));
        }
        return created;
    };

    /** The latest non-deleted version, as stored, with no question asked. */
    private latest = async (id: Id, createdAt: Date): Promise<Envelope | undefined> => {
        const query = `
            SELECT *
            FROM ${this.table}
            WHERE id = $1
              AND deleted IS FALSE
              AND created_at <= $2
            ORDER BY created_at DESC
            LIMIT 1;
        `;
        const result = await this.pool.query(query, [id, createdAt]);
        const row = result.rows[0];

        return row ? PostgresRepository.toEnvelope(row) : undefined;
    };

    read = async (id: Id, session: Session, createdAt: Date = new Date()): Promise<Envelope | undefined> => {
        const envelope = await this.latest(id, createdAt);
        if (!envelope) return undefined;
        return (await session.isAuthorized('read', envelope)) ? envelope : undefined;
    };

    readMany = async (ids: Id[], session: Session): Promise<Envelope[]> => {
        if (!ids.length) return [];

        const query = `
            SELECT DISTINCT ON (id) *
            FROM ${this.table}
            WHERE id = ANY($1)
              AND deleted IS FALSE
            ORDER BY id, created_at DESC;
        `;
        const result = await this.pool.query(query, [ids]);

        return authorized(session, 'read', result.rows.map(PostgresRepository.toEnvelope));
    };

    remove = async (id: Id, session: Session): Promise<boolean> => {
        const current = await this.latest(id, new Date());
        if (!current) return false;
        if (!(await session.isAuthorized('remove', current))) return false;

        await this.pool.query(
            `
            UPDATE ${this.table}
            SET deleted = TRUE
            WHERE id = $1;
        `,
            [id],
        );
        return true;
    };

    removeMany = async (ids: Id[], session: Session): Promise<Record<Id, boolean>> => {
        if (!ids.length) return {};

        const result: Record<Id, boolean> = {};
        for (const id of ids) {
            result[id] = await this.remove(id, session);
        }
        return result;
    };

    list = async (session: Session): Promise<Envelope[]> => {
        const query = `
            SELECT DISTINCT ON (id) *
            FROM ${this.table}
            WHERE deleted IS FALSE
            ORDER BY id, created_at DESC;
        `;
        const result = await this.pool.query(query);

        const all: Envelope[] = result.rows.map(PostgresRepository.toEnvelope);

        logger.debug('List query results', {
            count: all.length,
            results: all.map((obj) => ({
                id: obj.id,
                payload: obj.payload,
                created_at: obj.created_at?.getTime(),
                deleted: !!obj.deleted,
            })),
        });

        return authorized(session, 'read', all);
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
