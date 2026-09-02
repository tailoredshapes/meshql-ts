import { applyLimit, authorized, Searcher, Session } from '@tailoredshapes/meshql-common';
import { DTOFactory } from '@tailoredshapes/meshql-graphlette';
import Handlebars from 'handlebars';
import { getLogger } from 'log4js';
import { Pool } from 'mysql2/promise';
import { EnvelopeRow, rowToEnvelope } from './mysqlRepo';

const logger = getLogger('meshql-ts/mysqlsearcher');

export class MySQLSearcher implements Searcher {
    private pool: Pool;
    private table: string;
    private dtoFactory: DTOFactory;

    // A delete appends a tombstone rather than flagging the versions before it,
    // so the deletion test belongs on the row a query settles on and not in the
    // filter that chooses it. Filter first, then reject what the newest matching
    // version says is gone: keep `deleted = FALSE` inside the search and a
    // tombstoned record stays readable through the version underneath it.
    private singletonQuery = Handlebars.compile(`
        SELECT *
        FROM {{_name}}
        WHERE {{{filters}}}
          AND created_at <= ?
        ORDER BY created_at DESC
        LIMIT 1
    `);

    private vectorQuery = Handlebars.compile(`
        SELECT DISTINCT id,
               FIRST_VALUE(payload) OVER w AS payload,
               FIRST_VALUE(created_at) OVER w AS created_at,
               FIRST_VALUE(deleted) OVER w AS deleted,
               FIRST_VALUE(auth) OVER w AS auth
        FROM {{_name}}
        WHERE {{{filters}}}
          AND created_at <= ?
        WINDOW w AS (PARTITION BY id ORDER BY created_at DESC)
        ORDER BY created_at DESC
    `);

    constructor(pool: Pool, table: string, dtoFactory: DTOFactory) {
        this.pool = pool;
        this.table = table;
        this.dtoFactory = dtoFactory;
    }

    /**
     * Processes a Handlebars template with the provided parameters.
     */
    processQueryTemplate(parameters: Record<string, any>, queryTemplate: Handlebars.TemplateDelegate): string {
        return queryTemplate(parameters);
    }

    /**
     * Finds a single record based on the query template and arguments.
     */
    async find(
        queryTemplate: Handlebars.TemplateDelegate,
        args: Record<string, any>,
        session: Session,
        timestamp: number = Date.now(),
    ): Promise<Record<string, any>> {
        args._name = this.table;
        args.filters = this.processQueryTemplate(args, queryTemplate);

        const sql = this.processQueryTemplate(args, this.singletonQuery);

        try {
            const [rows] = await this.pool.query<EnvelopeRow[]>(sql, [timestamp]);

            if (rows.length > 0) {
                const envelope = rowToEnvelope(rows[0]);
                if (envelope.deleted) return {};

                if (await session.isAuthorized('read', envelope)) {
                    // rowToEnvelope already merges id into row.payload as a
                    // side effect; createdAt is the only thing missing here.
                    envelope.payload.createdAt = envelope.created_at?.toISOString();
                    return this.dtoFactory.fillOne(envelope.payload, timestamp);
                }
            }
        } catch (err) {
            logger.error(`Error executing find query: ${err}`);
        }

        return {};
    }

    /**
     * Finds all records based on the query template and arguments.
     */
    async findAll(
        queryTemplate: Handlebars.TemplateDelegate,
        args: Record<string, any>,
        session: Session,
        timestamp: number = Date.now(),
    ): Promise<Record<string, any>[]> {
        args._name = this.table;
        args.filters = this.processQueryTemplate(args, queryTemplate);

        const sql = this.processQueryTemplate(args, this.vectorQuery);

        try {
            const [rows] = await this.pool.query<EnvelopeRow[]>(sql, [timestamp]);

            // The newest matching version of each id decides: reached a
            // tombstone and the record is gone, whatever lies underneath it.
            const envelopes = rows.filter((row) => !row.deleted).map(rowToEnvelope);
            const authorizedResults = await authorized(session, 'read', envelopes);

            // `limit` arrives as an ordinary query argument. It truncates after the
            // authorization filter, so a record the caller cannot read never
            // consumes a slot and hides one the caller can.
            const limited = applyLimit(authorizedResults, args.limit);

            return limited.map((envelope) => {
                const payload = envelope.payload;
                payload.id = envelope.id;
                payload.createdAt = envelope.created_at?.toISOString();
                return payload;
            });
        } catch (err) {
            logger.error(`Error executing findAll query: ${err}`);
        }

        return [];
    }

    ready = async (): Promise<boolean> => {
        try {
            await this.pool.query('SELECT 1');
            return true;
        } catch {
            return false;
        }
    };
}
