import { applyLimit, authorized, Envelope, Searcher, Session } from '@tailoredshapes/meshql-common';
import { DTOFactory } from '@tailoredshapes/meshql-graphlette';
import Handlebars from 'handlebars';
import { getLogger } from 'log4js';
import { Pool } from 'pg';

const logger = getLogger('meshql-ts/postgressearcher');

export class PostgresSearcher implements Searcher {
    private pool: Pool;
    private table: string;
    private dtoFactory: DTOFactory;

    private singletonQuery = Handlebars.compile(`
        SELECT *
        FROM {{_name}}
        WHERE {{{filters}}}
          AND created_at <= '{{_createdAt}}'
          AND deleted = false
        ORDER BY created_at DESC
        LIMIT 1
        `);

    private vectorQuery = Handlebars.compile(`
        SELECT DISTINCT ON (id) *
        FROM {{_name}}
        WHERE {{{filters}}}
          AND created_at <= '{{_createdAt}}'
          AND deleted = false
        ORDER BY id, created_at DESC
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
     * Finds a single record based on the query template and arguments.
     */
    async find(
        queryTemplate: Handlebars.TemplateDelegate,
        args: Record<string, any>,
        session: Session,
        timestamp: number = Date.now(),
    ): Promise<Record<string, any>> {
        args._createdAt = new Date(timestamp).toISOString();
        args._name = this.table;
        args.filters = this.processQueryTemplate(args, queryTemplate);

        const sql = this.processQueryTemplate(args, this.singletonQuery);

        try {
            const result = await this.pool.query(sql);

            if (result.rows.length > 0) {
                const envelope = PostgresSearcher.toEnvelope(result.rows[0]);

                if (await session.isAuthorized('read', envelope)) {
                    envelope.payload.id = envelope.id;
                    envelope.payload.createdAt = envelope.created_at?.toISOString();
                    return this.dtoFactory.fillOne(envelope.payload, timestamp);
                }
            }
        } catch (err) {
            logger.error(`Error executing find query: ${err} for ${sql}`);
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
        args._createdAt = new Date(timestamp).toISOString();
        args._name = this.table;
        args.filters = this.processQueryTemplate(args, queryTemplate);

        const sql = this.processQueryTemplate(args, this.vectorQuery);

        try {
            const result = await this.pool.query(sql);

            const envelopes = result.rows.map(PostgresSearcher.toEnvelope);
            const authorizedResults = await authorized(session, 'read', envelopes);

            // `limit` arrives as an ordinary query argument. It truncates after the
            // authorization filter, so a record the caller cannot read never
            // consumes a slot and hides one the caller can.
            const limited = applyLimit(authorizedResults, args.limit);

            return limited.map((envelope) => {
                envelope.payload.id = envelope.id;
                envelope.payload.createdAt = envelope.created_at?.toISOString();
                return envelope.payload;
            });
        } catch (err) {
            logger.error(`Error executing findAll query: ${err} for ${sql}`);
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
