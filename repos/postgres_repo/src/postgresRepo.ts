import { Pool, types } from 'pg';
import { v4 as uuid } from 'uuid';
import {
    authorized,
    Envelope,
    findVersion,
    getLogger,
    Id,
    Repository,
    Session,
    versionRefs,
    VersionRef,
} from '@tailoredshapes/meshql-common';

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
            VALUES ($1, $2::jsonb, NOW(), NOW(), $3, $4::jsonb)
            RETURNING *;
        `;
        const logicalId = stamped.id || uuid();
        const values = [logicalId, stamped.payload, stamped.deleted === true, marshalAuth(stamped.auth)];

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

    /**
     * The most recent version at `createdAt`, deleted or not, as stored.
     *
     * A delete appends a tombstone rather than flagging the versions before it,
     * so "is this record gone" is a question about the newest version and not
     * about any of the ones underneath it.
     */
    private latestVersion = async (id: Id, createdAt: Date): Promise<Envelope | undefined> => {
        const query = `
            SELECT *
            FROM ${this.table}
            WHERE id = $1
              AND created_at <= $2
            ORDER BY created_at DESC
            LIMIT 1;
        `;
        const result = await this.pool.query(query, [id, createdAt]);
        const row = result.rows[0];

        return row ? PostgresRepository.toEnvelope(row) : undefined;
    };

    /** The latest live version: a tombstone on top means there is none. */
    private latest = async (id: Id, createdAt: Date): Promise<Envelope | undefined> => {
        const envelope = await this.latestVersion(id, createdAt);
        return envelope && !envelope.deleted ? envelope : undefined;
    };

    /** Every stored version of one document; `versionRefs` orders them. */
    private versions = async (id: Id): Promise<Envelope[]> => {
        const result = await this.pool.query(`SELECT * FROM ${this.table} WHERE id = $1;`, [id]);
        return result.rows.map(PostgresRepository.toEnvelope);
    };

    listVersions = async (id: Id, session: Session): Promise<VersionRef[]> =>
        versionRefs(session, await this.versions(id));

    readVersion = async (id: Id, token: string, session: Session): Promise<Envelope | undefined> =>
        findVersion(session, await this.versions(id), token);

    read = async (id: Id, session: Session, createdAt: Date = new Date()): Promise<Envelope | undefined> => {
        const envelope = await this.latest(id, createdAt);
        if (!envelope) return undefined;
        return (await session.isAuthorized('read', envelope)) ? envelope : undefined;
    };

    readMany = async (ids: Id[], session: Session): Promise<Envelope[]> => {
        if (!ids.length) return [];

        // The newest version of each id decides: reached a tombstone and the
        // record is gone, whatever lies underneath it.
        const query = `
            SELECT * FROM (
                SELECT DISTINCT ON (id) *
                FROM ${this.table}
                WHERE id = ANY($1)
                ORDER BY id, created_at DESC
            ) latest
            WHERE deleted IS FALSE;
        `;
        const result = await this.pool.query(query, [ids]);

        return authorized(session, 'read', result.rows.map(PostgresRepository.toEnvelope));
    };

    remove = async (id: Id, session: Session): Promise<boolean> => {
        const current = await this.latest(id, new Date());
        if (!current) return false;
        if (!(await session.isAuthorized('remove', current))) return false;

        // A delete is a version, not an erasure. The tombstone keeps the mark of
        // the record it buries -- re-stamping it would answer for the plugin --
        // and leaves the versions before it saying what they always said.
        await this.insert({ ...current, deleted: true });
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
            SELECT * FROM (
                SELECT DISTINCT ON (id) *
                FROM ${this.table}
                ORDER BY id, created_at DESC
            ) latest
            WHERE deleted IS FALSE;
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
