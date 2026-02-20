import { Searcher } from '@tailoredshapes/meshql-common';
import { Auth } from '@tailoredshapes/meshql-auth';
import { DTOFactory } from '@tailoredshapes/meshql-graphlette';
import Handlebars from 'handlebars';
import { getLogger } from 'log4js';
import { Pool } from 'pg';

const logger = getLogger('meshql-ts/postgressearcher');

export class PostgresSearcher implements Searcher {
    private pool: Pool;
    private table: string;
    private authorizer: Auth;
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
        args._createdAt = new Date(timestamp).toISOString();
        args._name = this.table;
        args.filters = this.processQueryTemplate(args, queryTemplate);

        const sql = this.processQueryTemplate(args, this.singletonQuery);

        try {
            const result = await this.pool.query(sql);

            if (result.rows.length > 0) {
                let row = result.rows[0];

                if (await this.authorizer.isAuthorized(creds, row)) {
                    row.payload.id = row.id;
                    return this.dtoFactory.fillOne(row.payload, timestamp);
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
        creds: string[] = [],
        timestamp: number = Date.now(),
    ): Promise<Record<string, any>[]> {
        args._createdAt = new Date(timestamp).toISOString();
        args._name = this.table;
        args.filters = this.processQueryTemplate(args, queryTemplate);

        const sql = this.processQueryTemplate(args, this.vectorQuery);

        try {
            const result = await this.pool.query(sql);

            const authorizedResults = result.rows.filter((row) => this.authorizer.isAuthorized(creds, row));

            return authorizedResults.map((row) => {
                row.payload.id = row.id;
                return row.payload;
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
