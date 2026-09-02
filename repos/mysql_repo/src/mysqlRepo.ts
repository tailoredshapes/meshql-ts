import { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { v4 as uuid } from 'uuid';
import {
    authorized,
    Envelope,
    findVersion,
    Id,
    Payload,
    Repository,
    Session,
    versionRefs,
    VersionRef,
} from '@tailoredshapes/meshql-common';
import Log4js from 'log4js';

const logger = Log4js.getLogger('meshql-ts/mysql_repo');

export interface EnvelopeRow extends RowDataPacket {
    id: string;
    payload: Payload;
    created_at: bigint;
    updated_at: bigint;
    deleted: boolean;
    auth: unknown;
}

/**
 * MySQL hands back a JSON column already parsed when it is selected directly,
 * and as a string when it arrives through a window function. Either way the
 * value must survive onto the Envelope untouched: it is the plugin's mark, and
 * this file has no idea what is in it.
 */
export const parseAuth = (auth: unknown): unknown => {
    if (auth === undefined || auth === null) return undefined;
    if (typeof auth === 'string') {
        try {
            return JSON.parse(auth);
        } catch {
            return undefined;
        }
    }
    return auth;
};

const marshalAuth = (auth: unknown): string | null => (auth === undefined ? null : JSON.stringify(auth));

/**
 * A row as it is stored, with nothing merged into the payload.
 *
 * A version's address is derived from its payload, so anything this mapper adds
 * would become part of the address and MySQL would hand out URLs no other
 * adapter could resolve.
 */
export const rowToStoredEnvelope = (row: EnvelopeRow): Envelope => ({
    id: row.id,
    payload: row.payload,
    created_at: new Date(Number(row.created_at)),
    deleted: !!row.deleted,
    auth: parseAuth(row.auth),
});

export const rowToEnvelope = (row: EnvelopeRow): Envelope => {
    row.payload.id = row.id;
    return rowToStoredEnvelope(row);
};

export class MySQLRepository implements Repository {
    private pool: Pool;
    private table: string;

    constructor(pool: Pool, table: string) {
        this.pool = pool;
        this.table = table;
    }

    async initialize(): Promise<void> {
        // Create the table with appropriate indexes
        const query = `
            CREATE TABLE IF NOT EXISTS ${this.table} (
                pk BINARY(16) PRIMARY KEY DEFAULT (UUID_TO_BIN(UUID())),
                id VARCHAR(255),
                payload JSON,
                created_at BIGINT UNSIGNED NOT NULL,
                updated_at BIGINT UNSIGNED NOT NULL,
                deleted BOOLEAN DEFAULT FALSE,
                auth JSON,
                UNIQUE KEY unique_id_created (id, created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `;
        await this.pool.query(query);

        // Create indexes - MySQL way
        try {
            await this.pool.query(`
                CREATE INDEX idx_${this.table}_id
                ON ${this.table} (id);
            `);
        } catch (err) {
            // Index might already exist, ignore error
        }

        try {
            await this.pool.query(`
                CREATE INDEX idx_${this.table}_created_at
                ON ${this.table} (created_at);
            `);
        } catch (err) {
            // Index might already exist, ignore error
        }
    }

    /**
     * Insert one version. `UNIQUE (id, created_at)` makes two versions of one
     * document in the same millisecond a duplicate-key error rather than a
     * silent collision, so a colliding write waits and takes the next
     * millisecond, exactly as the SQLite and Postgres adapters do.
     */
    private insert = async (stamped: Envelope, retryCount = 0): Promise<Envelope> => {
        const maxRetries = 5;
        const logicalId = stamped.id || uuid();
        const now = Date.now();
        const deleted = stamped.deleted === true;
        const query = `
            INSERT INTO ${this.table} (id, payload, auth, created_at, updated_at, deleted)
            VALUES (?, ?, ?, ?, ?, ?);
        `;
        const values = [logicalId, JSON.stringify(stamped.payload), marshalAuth(stamped.auth), now, now, deleted];

        try {
            await this.pool.query<ResultSetHeader>(query, values);
            return {
                id: logicalId,
                payload: stamped.payload,
                created_at: new Date(now),
                deleted,
                auth: stamped.auth,
            };
        } catch (err: any) {
            if (err?.code === 'ER_DUP_ENTRY' && retryCount < maxRetries) {
                await new Promise((resolve) => setTimeout(resolve, 2));
                return this.insert(stamped, retryCount + 1);
            }
            logger.error(`Failed to create document: ${err}`);
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
            WHERE id = ?
              AND created_at <= ?
            ORDER BY created_at DESC
            LIMIT 1;
        `;

        const [rows] = await this.pool.query<EnvelopeRow[]>(query, [id, createdAt.getTime()]);
        if (!rows.length) return undefined;
        return rowToStoredEnvelope(rows[0]);
    };

    /** The latest live version: a tombstone on top means there is none. */
    private latest = async (id: Id, createdAt: Date): Promise<Envelope | undefined> => {
        const envelope = await this.latestVersion(id, createdAt);
        return envelope && !envelope.deleted ? envelope : undefined;
    };

    /** Every stored version of one document, payloads exactly as written. */
    private versions = async (id: Id): Promise<Envelope[]> => {
        const [rows] = await this.pool.query<EnvelopeRow[]>(`SELECT * FROM ${this.table} WHERE id = ?;`, [id]);
        return rows.map(rowToStoredEnvelope);
    };

    listVersions = async (id: Id, session: Session): Promise<VersionRef[]> =>
        versionRefs(session, await this.versions(id));

    readVersion = async (id: Id, token: string, session: Session): Promise<Envelope | undefined> =>
        findVersion(session, await this.versions(id), token);

    read = async (id: Id, session: Session, createdAt: Date = new Date()): Promise<Envelope | undefined> => {
        try {
            const envelope = await this.latest(id, createdAt);
            if (!envelope) return undefined;
            return (await session.isAuthorized('read', envelope)) ? envelope : undefined;
        } catch (err) {
            logger.error(`Failed to read document: ${err}`);
            throw err;
        }
    };

    readMany = async (ids: Id[], session: Session): Promise<Envelope[]> => {
        if (!ids.length) return [];

        const placeholders = ids.map(() => '?').join(',');
        const query = `
            SELECT DISTINCT id,
                   FIRST_VALUE(payload) OVER w AS payload,
                   FIRST_VALUE(created_at) OVER w AS created_at,
                   FIRST_VALUE(deleted) OVER w AS deleted,
                   FIRST_VALUE(auth) OVER w AS auth
            FROM ${this.table}
            WHERE id IN (${placeholders})
            WINDOW w AS (PARTITION BY id ORDER BY created_at DESC)
            ORDER BY created_at DESC;
        `;

        try {
            const [rows] = await this.pool.query<EnvelopeRow[]>(query, ids);
            // The newest version of each id decides: reached a tombstone and
            // the record is gone, whatever lies underneath it.
            const live = rows.filter((row) => !row.deleted);
            return authorized(session, 'read', live.map(rowToStoredEnvelope));
        } catch (err) {
            logger.error(`Failed to read multiple documents: ${err}`);
            throw err;
        }
    };

    remove = async (id: Id, session: Session): Promise<boolean> => {
        try {
            const current = await this.latest(id, new Date());
            if (!current) return false;
            if (!(await session.isAuthorized('remove', current))) return false;

            // A delete is a version, not an erasure. The tombstone keeps the
            // mark of the record it buries -- re-stamping it would answer for
            // the plugin -- and leaves the versions before it saying what they
            // always said.
            await this.insert({ ...current, deleted: true });
            return true;
        } catch (err) {
            logger.error(`Failed to remove document: ${err}`);
            throw err;
        }
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
            SELECT DISTINCT id,
                   FIRST_VALUE(payload) OVER w AS payload,
                   FIRST_VALUE(created_at) OVER w AS created_at,
                   FIRST_VALUE(deleted) OVER w AS deleted,
                   FIRST_VALUE(auth) OVER w AS auth
            FROM ${this.table}
            WINDOW w AS (PARTITION BY id ORDER BY created_at DESC)
            ORDER BY created_at DESC;
        `;

        try {
            const [rows] = await this.pool.query<EnvelopeRow[]>(query);
            // The newest version of each id decides: reached a tombstone and
            // the record is gone, whatever lies underneath it.
            const envelopes: Envelope[] = rows
                .filter((row) => !row.deleted)
                .map((row) => ({
                    id: row.id,
                    payload: row.payload as Payload,
                    created_at: new Date(Number(row.created_at)),
                    deleted: !!row.deleted,
                    auth: parseAuth(row.auth),
                }));
            return authorized(session, 'read', envelopes);
        } catch (err) {
            logger.error(`Failed to list documents: ${err}`);
            throw err;
        }
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
