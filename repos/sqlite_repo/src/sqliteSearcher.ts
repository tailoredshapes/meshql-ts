import { applyLimit, authorized, Envelope, Searcher, Session } from '@tailoredshapes/meshql-common';
import { DTOFactory } from '@tailoredshapes/meshql-graphlette';
import Handlebars from 'handlebars';
import { Database } from 'sqlite';

export class SQLiteSearcher implements Searcher {
    private db: Database;
    private table: string;
    private dtoFactory: DTOFactory;

    // A delete appends a tombstone rather than flagging the versions before it,
    // so the deletion test belongs on the row a query settles on and not in the
    // filter that chooses it. Filter first, then reject what the newest version
    // says is gone: keep `deleted = 0` inside the search and a tombstoned
    // record stays readable through the version underneath its tombstone.
    private singletonTemplate = Handlebars.compile(`
        SELECT *
        FROM {{_name}}
        WHERE {{{filters}}}
         AND created_at <= {{_created_at}}
        ORDER BY created_at DESC
        LIMIT 1
    `);

    private vectorTemplate = Handlebars.compile(
        `WITH latest AS (
        SELECT
            id,
            MAX(created_at) AS max_created_at
        FROM {{_name}}
        WHERE {{{filters}}}
            AND created_at <= {{_created_at}}
        GROUP BY id
        )
        SELECT t1.*
        FROM {{_name}} t1
        JOIN latest t2
        ON t1.id = t2.id
        AND t1.created_at = t2.max_created_at
        WHERE t1.deleted = 0`,
    );

    constructor(db: Database, table: string, dtoFactory: DTOFactory) {
        this.db = db;
        this.table = table;
        this.dtoFactory = dtoFactory;
    }

    processQueryTemplate(parameters: Record<string, any>, queryTemplate: Handlebars.TemplateDelegate): string {
        return queryTemplate(parameters);
    }

    private rowToEnvelope(row: any): Envelope {
        return {
            id: row.id,
            payload: JSON.parse(row.payload),
            created_at: new Date(row.created_at),
            deleted: !!row.deleted,
            auth: row.auth === null || row.auth === undefined ? undefined : JSON.parse(row.auth),
        };
    }

    async find(
        queryTemplate: Handlebars.TemplateDelegate,
        args: Record<string, any>,
        session: Session,
        timestamp: number = Date.now(),
    ): Promise<Record<string, any>> {
        args._created_at = timestamp;
        args._name = this.table;
        args.filters = this.processQueryTemplate(args, queryTemplate);
        let sql = this.processQueryTemplate(args, this.singletonTemplate);

        const result = await this.db.get(sql, []);

        if (result && result.payload) {
            const envelope = this.rowToEnvelope(result);
            if (envelope.deleted) return {};

            if (await session.isAuthorized('read', envelope)) {
                envelope.payload.id = envelope.id;
                envelope.payload.createdAt = envelope.created_at!.toISOString();
                return this.dtoFactory.fillOne(envelope.payload, timestamp);
            }
        }

        return {};
    }

    async findAll(
        queryTemplate: Handlebars.TemplateDelegate,
        args: Record<string, any>,
        session: Session,
        timestamp: number = Date.now(),
    ): Promise<Record<string, any>[]> {
        args._created_at = timestamp;
        args._name = this.table;
        args.filters = this.processQueryTemplate(args, queryTemplate);
        let sql = this.processQueryTemplate(args, this.vectorTemplate);

        const rows = await this.db.all(sql, []);
        const envelopes: Envelope[] = rows.map((row) => this.rowToEnvelope(row));

        const authorizedResults = await authorized(session, 'read', envelopes);

        // `limit` arrives as an ordinary query argument. It truncates after the
        // authorization filter, so a record the caller cannot read never
        // consumes a slot and hides one the caller can.
        const limited = applyLimit(authorizedResults, args.limit);

        return limited.map((envelope) => {
            envelope.payload.id = envelope.id;
            envelope.payload.createdAt = envelope.created_at!.toISOString();
            return envelope.payload;
        });
    }

    ready = async (): Promise<boolean> => {
        try {
            await this.db.get('SELECT 1');
            return true;
        } catch {
            return false;
        }
    };
}
