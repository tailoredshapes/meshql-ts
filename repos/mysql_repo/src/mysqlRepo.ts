import { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { v4 as uuid } from 'uuid';
import { Envelope, Id, Payload, Repository } from '@tailoredshapes/meshql-common';
import Log4js from 'log4js';

const logger = Log4js.getLogger('meshql-ts/mysql_repo');

export interface EnvelopeRow extends RowDataPacket {
    id: string;
    payload: Payload;
    created_at: bigint;
    updated_at: bigint;
    deleted: boolean;
    authorized_tokens: string[];
}

export const rowToEnvelope = (row: EnvelopeRow): Envelope => {
    row.payload.id = row.id;
    return {
        id: row.id,
        payload: row.payload,
        created_at: new Date(Number(row.created_at)),
        deleted: row.deleted,
    };
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
                authorized_tokens JSON,
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

    create = async (doc: Envelope, readers: string[] = []): Promise<Envelope> => {
        const logicalId = doc.id || uuid();
        const now = Date.now();
        const query = `
            INSERT INTO ${this.table} (id, payload, authorized_tokens, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?);
        `;
        const values = [logicalId, JSON.stringify(doc.payload), JSON.stringify(readers), now, now];

        try {
            await this.pool.query<ResultSetHeader>(query, values);
            return {
                id: logicalId,
                payload: doc.payload,
                created_at: new Date(now),
                deleted: false,
            };
        } catch (err) {
            logger.error(`Failed to create document: ${err}`);
            throw err;
        }
    };

    createMany = async (docs: Envelope[], readers: string[] = []): Promise<Envelope[]> => {
        const created: Envelope[] = [];
        for (const doc of docs) {
            created.push(await this.create(doc, readers));
        }
        return created;
    };

    read = async (id: Id, tokens: string[] = [], createdAt: Date = new Date()): Promise<Envelope | undefined> => {
        const query = `
            SELECT *
            FROM ${this.table}
            WHERE id = ?
              AND deleted = FALSE
              AND created_at <= ?
              ${tokens.length ? 'AND JSON_OVERLAPS(authorized_tokens, CAST(? AS JSON))' : ''}
            ORDER BY created_at DESC
            LIMIT 1;
        `;
        const values = tokens.length ? [id, createdAt.getTime(), JSON.stringify(tokens)] : [id, createdAt.getTime()];

        try {
            const [rows] = await this.pool.query<EnvelopeRow[]>(query, values);
            if (!rows.length) return undefined;

            const row = rows[0];

            return rowToEnvelope(row);
        } catch (err) {
            logger.error(`Failed to read document: ${err}`);
            throw err;
        }
    };

    readMany = async (ids: Id[], readers: string[] = []): Promise<Envelope[]> => {
        if (!ids.length) return [];

        const placeholders = ids.map(() => '?').join(',');
        const query = `
            SELECT DISTINCT id, 
                   FIRST_VALUE(payload) OVER w AS payload,
                   FIRST_VALUE(created_at) OVER w AS created_at,
                   FIRST_VALUE(deleted) OVER w AS deleted
            FROM ${this.table}
            WHERE id IN (${placeholders})
              AND deleted = FALSE
              ${readers.length ? 'AND JSON_OVERLAPS(authorized_tokens, CAST(? AS JSON))' : ''}
            WINDOW w AS (PARTITION BY id ORDER BY created_at DESC)
            ORDER BY created_at DESC;
        `;
        const values = readers.length ? [...ids, JSON.stringify(readers)] : ids;

        try {
            const [rows] = await this.pool.query<EnvelopeRow[]>(query, values);
            return rows.map(rowToEnvelope);
        } catch (err) {
            logger.error(`Failed to read multiple documents: ${err}`);
            throw err;
        }
    };

    remove = async (id: Id, readers: string[] = []): Promise<boolean> => {
        const query = `
            UPDATE ${this.table}
            SET deleted = TRUE
            WHERE id = ?
            ${readers.length ? 'AND JSON_OVERLAPS(authorized_tokens, CAST(? AS JSON))' : ''};
        `;
        const values = readers.length ? [id, JSON.stringify(readers)] : [id];

        try {
            await this.pool.query<ResultSetHeader>(query, values);
            return true;
        } catch (err) {
            logger.error(`Failed to remove document: ${err}`);
            throw err;
        }
    };

    removeMany = async (ids: Id[], readers: string[] = []): Promise<Record<Id, boolean>> => {
        if (!ids.length) return {};

        const placeholders = ids.map(() => '?').join(',');
        const query = `
            UPDATE ${this.table}
            SET deleted = TRUE
            WHERE id IN (${placeholders})
            ${readers.length ? 'AND JSON_OVERLAPS(authorized_tokens, CAST(? AS JSON))' : ''};
        `;
        const values = readers.length ? [...ids, JSON.stringify(readers)] : ids;

        try {
            await this.pool.query<ResultSetHeader>(query, values);
            return ids.reduce(
                (acc, id) => {
                    acc[id] = true;
                    return acc;
                },
                {} as Record<Id, boolean>,
            );
        } catch (err) {
            logger.error(`Failed to remove multiple documents: ${err}`);
            throw err;
        }
    };

    list = async (readers: string[] = []): Promise<Envelope[]> => {
        const query = `
            SELECT DISTINCT id,
                   FIRST_VALUE(payload) OVER w AS payload,
                   FIRST_VALUE(created_at) OVER w AS created_at,
                   FIRST_VALUE(deleted) OVER w AS deleted
            FROM ${this.table}
            WHERE deleted = FALSE
            ${readers.length ? 'AND JSON_OVERLAPS(authorized_tokens, CAST(? AS JSON))' : ''}
            WINDOW w AS (PARTITION BY id ORDER BY created_at DESC)
            ORDER BY created_at DESC;
        `;
        const values = readers.length ? [JSON.stringify(readers)] : [];

        try {
            const [rows] = await this.pool.query<EnvelopeRow[]>(query, values);
            return rows.map((row) => ({
                id: row.id,
                payload: row.payload as Payload,
                created_at: new Date(Number(row.created_at)),
                deleted: !!row.deleted,
            }));
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
