import { Searcher } from '@tailoredshapes/meshql-common';
import { Auth } from '@tailoredshapes/meshql-auth';
import { DTOFactory } from '@tailoredshapes/meshql-graphlette';
import Handlebars from 'handlebars';
import { getLogger } from 'log4js';
import { Pool } from 'mysql2/promise';
import { EnvelopeRow, rowToEnvelope } from './mysqlRepo';

const logger = getLogger('meshql-ts/mysqlsearcher');

export class MySQLSearcher implements Searcher {
    private pool: Pool;
    private table: string;
    private authorizer: Auth;
    private dtoFactory: DTOFactory;

    private singletonQuery = Handlebars.compile(`
        SELECT *
        FROM {{_name}}
        WHERE {{{filters}}}
          AND created_at <= ?
          AND deleted = FALSE
        ORDER BY created_at DESC
        LIMIT 1
    `);

    private vectorQuery = Handlebars.compile(`
        SELECT DISTINCT id,
               FIRST_VALUE(payload) OVER w AS payload,
               FIRST_VALUE(created_at) OVER w AS created_at,
               FIRST_VALUE(deleted) OVER w AS deleted,
               FIRST_VALUE(authorized_tokens) OVER w AS authorized_tokens
        FROM {{_name}}
        WHERE {{{filters}}}
          AND created_at <= ?
          AND deleted = FALSE
        WINDOW w AS (PARTITION BY id ORDER BY created_at DESC)
        ORDER BY created_at DESC
    `);

    constructor(pool: Pool, table: string, dtoFactory: DTOFactory, authorizer: Auth) {
        this.pool = pool;
        this.table = table;
        this.dtoFactory = dtoFactory;
        this.authorizer = authorizer;
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
        creds: string[] = [],
        timestamp: number = Date.now(),
    ): Promise<Record<string, any>> {
        args._name = this.table;
        args.filters = this.processQueryTemplate(args, queryTemplate);

        const sql = this.processQueryTemplate(args, this.singletonQuery);

        try {
            const [rows] = await this.pool.query<EnvelopeRow[]>(sql, [timestamp]);

            if (rows.length > 0) {
                const row = rowToEnvelope(rows[0]);

                if (await this.authorizer.isAuthorized(creds, row)) {
                    // rowToEnvelope already merges id into row.payload as a
                    // side effect; createdAt is the only thing missing here.
                    row.payload.createdAt = row.created_at?.toISOString();
                    return this.dtoFactory.fillOne(row.payload, timestamp);
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
        creds: string[] = [],
        timestamp: number = Date.now(),
    ): Promise<Record<string, any>[]> {
        args._name = this.table;
        args.filters = this.processQueryTemplate(args, queryTemplate);

        const sql = this.processQueryTemplate(args, this.vectorQuery);

        try {
            const [rows] = await this.pool.query<EnvelopeRow[]>(sql, [timestamp]);

            // `isAuthorized` is async: filtering on it directly tests a Promise,
            // which is always truthy, so every row survives regardless of
            // credentials. Resolve first, then filter on the resolved booleans.
            const envelopes = rows.map(rowToEnvelope);
            const decisions = await Promise.all(envelopes.map((e) => this.authorizer.isAuthorized(creds, e)));
            const authorizedResults = envelopes.filter((_, i) => decisions[i]);

            return authorizedResults.map((envelope) => {
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
