import { v4 as uuid } from 'uuid';
import { authorized, Envelope, Id, Repository, Session } from '@tailoredshapes/meshql-common';
import { Database } from 'sqlite';

/**
 * SQLite storage.
 *
 * It holds no credentials and knows no authorization rule. On a write it asks
 * the session to stamp the envelope and stores whatever comes back, in the
 * same statement as the payload -- authorization is never a second write, so
 * a crash cannot leave a record present with its mark missing. On a read it
 * fetches, then asks.
 */
export class SQLiteRepository implements Repository {
    private db: Database;
    private table: string;

    constructor(db: Database, table: string) {
        this.db = db;
        this.table = table;
    }

    async initialize(): Promise<void> {
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS ${this.table} (
                _id INTEGER PRIMARY KEY,
                id TEXT,
                payload JSON NOT NULL,
                created_at INTEGER DEFAULT (strftime('%s', 'now')),
                deleted INTEGER DEFAULT 0,
                auth JSON,
                UNIQUE (id, created_at)
            );
        `);
    }

    private rowToEnvelope = (row: any): Envelope => {
        return {
            id: row.id,
            payload: JSON.parse(row.payload),
            created_at: new Date(row.created_at),
            deleted: !!row.deleted,
            auth: row.auth === null || row.auth === undefined ? undefined : JSON.parse(row.auth),
        };
    };

    private insert = async (stamped: Envelope): Promise<Envelope> => {
        const query = `
            INSERT INTO ${this.table} (id, payload, created_at, auth)
            VALUES (?, ?, ?, ?);
        `;
        const id = stamped.id || uuid();
        const createdAt = Date.now();
        const values = [
            id,
            JSON.stringify(stamped.payload),
            createdAt,
            stamped.auth === undefined ? null : JSON.stringify(stamped.auth),
        ];

        try {
            const { lastID } = await this.db.run(query, values);
            const row = await this.db.get(`SELECT * FROM ${this.table} WHERE rowid = ?`, [lastID]);
            return this.rowToEnvelope(row);
        } catch (err: any) {
            if (err.code === 'SQLITE_CONSTRAINT') {
                await new Promise((resolve) => setTimeout(resolve, 2));
                return this.insert(stamped);
            }
            throw err;
        }
    };

    create = async (doc: Envelope, session: Session): Promise<Envelope> => {
        return this.insert(await session.stamp(doc));
    };

    createMany = async (payloads: Envelope[], session: Session): Promise<Envelope[]> => {
        const created: Envelope[] = [];
        await this.db.run('BEGIN TRANSACTION');
        for (const envelope of payloads) {
            created.push(await this.insert(await session.stamp(envelope)));
        }
        await this.db.run('COMMIT');
        return created;
    };

    /** The latest non-deleted version, as stored, with no question asked. */
    private latest = async (id: Id, at: Date): Promise<Envelope | undefined> => {
        const row: any = await this.db.get(
            `
            SELECT * FROM ${this.table}
            WHERE id = ? AND deleted = 0 AND created_at <= ?
            ORDER BY created_at DESC
            LIMIT 1;
        `,
            [id, at.getTime()],
        );

        return row ? this.rowToEnvelope(row) : undefined;
    };

    read = async (id: Id, session: Session, at: Date = new Date()): Promise<Envelope | undefined> => {
        const envelope = await this.latest(id, at);
        if (!envelope) return undefined;
        return (await session.isAuthorized('read', envelope)) ? envelope : undefined;
    };

    readMany = async (ids: Id[], session: Session): Promise<Envelope[]> => {
        if (!ids.length) return [];
        const now = Date.now();

        const query = `
            SELECT * FROM ${this.table}
            WHERE id IN (${ids.map(() => '?').join(', ')})
            AND deleted = 0
            AND created_at <= ?
            ORDER BY created_at DESC;
        `;
        const rows = await this.db.all(query, [...ids, now]);

        const seen = new Set<Id>();
        const envelopes: Envelope[] = [];

        for (const row of rows) {
            if (!seen.has(row.id)) {
                seen.add(row.id);
                envelopes.push(this.rowToEnvelope(row));
            }
        }

        return authorized(session, 'read', envelopes);
    };

    remove = async (id: Id, session: Session): Promise<boolean> => {
        const current = await this.latest(id, new Date());
        if (!current) return false;
        if (!(await session.isAuthorized('remove', current))) return false;

        const result = await this.db.run(
            `
            UPDATE ${this.table}
            SET deleted = 1
            WHERE id = ?;
        `,
            [id],
        );
        return result.changes! > 0;
    };

    removeMany = async (ids: Id[], session: Session): Promise<Record<Id, boolean>> => {
        const result: Record<Id, boolean> = {};

        await this.db.run('BEGIN TRANSACTION');
        for (const id of ids) {
            result[id] = await this.remove(id, session);
        }
        await this.db.run('COMMIT');

        return result;
    };

    list = async (session: Session): Promise<Envelope[]> => {
        const rows = await this.db.all(`
            SELECT * FROM ${this.table}
            WHERE deleted = 0
            ORDER BY created_at DESC;
        `);

        const seen = new Set<string>();
        const envelopes: Envelope[] = [];
        for (const row of rows) {
            if (!seen.has(row.id)) {
                seen.add(row.id);
                envelopes.push(this.rowToEnvelope(row));
            }
        }
        return authorized(session, 'read', envelopes);
    };

    ready = async (): Promise<boolean> => {
        try {
            await this.db.get('SELECT 1');
            return true;
        } catch {
            return false;
        }
    };
}
