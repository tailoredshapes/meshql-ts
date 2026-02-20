import { Searcher, Envelope } from '@tailoredshapes/meshql-common';
import { Auth } from '@tailoredshapes/meshql-auth';
import { DTOFactory } from '@tailoredshapes/meshql-graphlette';
import Handlebars from 'handlebars';
import { Database } from 'sqlite';

export class SQLiteSearcher implements Searcher {
    private db: Database;
    private table: string;
    private authorizer: Auth;
    private dtoFactory: DTOFactory;

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
            AND deleted = 0
        GROUP BY id
        )
        SELECT t1.*
        FROM {{_name}} t1
        JOIN latest t2
        ON t1.id = t2.id
        AND t1.created_at = t2.max_created_at
        WHERE t1.deleted = 0`,
    );

    constructor(db: Database, table: string, dtoFactory: DTOFactory, authorizer: Auth) {
        this.db = db;
        this.table = table;
        this.dtoFactory = dtoFactory;
        this.authorizer = authorizer;
    }

    processQueryTemplate(parameters: Record<string, any>, queryTemplate: Handlebars.TemplateDelegate): string {
        return queryTemplate(parameters);
    }

    async find(
        queryTemplate: Handlebars.TemplateDelegate,
        args: Record<string, any>,
        creds: string[] = [],
        timestamp: number = Date.now(),
    ): Promise<Record<string, any>> {
        args._created_at = timestamp;
        args._name = this.table;
        args.filters = this.processQueryTemplate(args, queryTemplate);
        let sql = this.processQueryTemplate(args, this.singletonTemplate);

        const result = await this.db.get(sql, []);

        if (result && result.payload) {
            result.payload = JSON.parse(result.payload);
            result.authorized_tokens = JSON.parse(result.authorized_tokens);

            if (await this.authorizer.isAuthorized(creds, result)) {
                result.payload.id = result.id;
                return this.dtoFactory.fillOne(result.payload, timestamp);
            }
        }

        return {};
    }

    async findAll(
        queryTemplate: Handlebars.TemplateDelegate,
        args: Record<string, any>,
        creds: string[] = [],
        timestamp: number = Date.now(),
    ): Promise<Record<string, any>[]> {
        args._created_at = timestamp;
        args._name = this.table;
        args.filters = this.processQueryTemplate(args, queryTemplate);
        let sql = this.processQueryTemplate(args, this.vectorTemplate);

        const rows = await this.db.all(sql, []);
        const envelopes: Envelope[] = rows.map((i) => {
            i.payload = JSON.parse(i.payload);
            i.authorized_tokens = JSON.parse(i.authorized_tokens);
            return i;
        });

        const authorizedResults = envelopes.filter((row) => this.authorizer.isAuthorized(creds, row));

        return authorizedResults.map((row) => {
            const result = row as Envelope;
            result.payload.id = result.id;
            return result.payload;
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
