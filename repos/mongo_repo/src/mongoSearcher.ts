import { applyLimit, Envelope, Searcher } from '@tailoredshapes/meshql-common';
import { Auth } from '@tailoredshapes/meshql-auth';
import { Collection, Document } from 'mongodb';
import { DTOFactory } from '@tailoredshapes/meshql-graphlette';
import HandleBars from 'handlebars';
import Handlebars from 'handlebars';
import { getLogger } from 'log4js';
import { Schema } from './types';
import { MongoClient } from 'mongodb';

let logger = getLogger('meshql-ts/mongosearcher');

export class MongoSearcher implements Searcher {
    private authorizer: Auth;
    private db: Collection<Envelope>;
    private dtoFactory: DTOFactory;
    private dbClient: MongoClient;
    private collection: string;

    constructor(
        db: Collection<Envelope>,
        dtoFactory: DTOFactory,
        authorizer: Auth,
        dbClient: MongoClient,
        collection: string,
    ) {
        this.authorizer = authorizer;
        this.db = db;
        this.dtoFactory = dtoFactory;
        this.dbClient = dbClient;
        this.collection = collection;
    }

    processQueryTemplate(parameters: Record<string, any>, queryTemplate: HandleBars.TemplateDelegate): any {
        let query = queryTemplate(parameters);
        let json;

        try {
            json = JSON.parse(query);
        } catch (e) {
            logger.error(
                `Failed to create query:
      Query Template: ${queryTemplate}
      parameters: ${parameters}
      Updated Query: ${query}
    `,
            );
            throw e;
        }
        return json;
    }

    async find(
        queryTemplate: Handlebars.TemplateDelegate,
        args: Record<string, any>,
        creds: string[] = [],
        timestamp: number = Date.now(),
    ): Promise<Record<string, any>> {
        let query = this.processQueryTemplate(args, queryTemplate);

        query.created_at = {
            // `<=`, matching the SQL adapters: a record created in the same
            // millisecond as the query timestamp is visible, not invisible.
            $lte: new Date(timestamp),
        };

        // `MongoRepository.remove` flags a document rather than dropping it,
        // and marks it the way `MongoRepository.read` looks for. Skip this and
        // a tombstoned record stays readable through `getById` forever, which
        // is what the Postgres and MySQL adapters already refuse to do.
        query.deleted = { $exists: false };

        let doc = await this.db
            .find(query)
            .sort({ created_at: -1 })
            .toArray()
            .catch(() => {
                logger.debug(`Nothing found for: ${args}`);
                return [];
            });

        logger.trace(`Found: ${JSON.stringify(doc)}`);

        if (doc.length > 0) {
            let result = doc[0];

            // No short-circuit on empty credentials: an uncredentialed caller
            // is permitted, but only to the records whose own token list is
            // empty. `isAuthorized` already encodes that rule, and the SQL
            // adapters go through it unconditionally.
            if (await this.authorizer.isAuthorized(creds, result)) {
                result.payload.id = result.id;
                result.payload.createdAt = result.created_at?.toISOString();
                return this.dtoFactory.fillOne(result.payload, timestamp);
            } else {
                logger.trace('Not Authorized');
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
        let time_filter = {
            // `<=`, matching the SQL adapters: a record created in the same
            // millisecond as the query timestamp is visible, not invisible.
            $lte: new Date(timestamp),
        };

        let query = this.processQueryTemplate(args, queryTemplate);

        query.created_at = time_filter;
        query.deleted = { $exists: false };

        let results = await this.db
            .aggregate([
                {
                    $match: query,
                },
                {
                    $sort: { created_at: -1 },
                },
                {
                    $group: {
                        _id: '$id',
                        doc: { $first: '$$ROOT' },
                    },
                },
                {
                    $replaceRoot: { newRoot: '$doc' },
                },
            ])
            .toArray();

        // `isAuthorized` is async: filtering on it directly tests a Promise,
        // which is always truthy, so every document survives regardless of
        // credentials. Resolve first, then filter on the resolved booleans.
        // Applied unconditionally -- an uncredentialed caller still only
        // reaches records whose own token list is empty.
        const decisions = await Promise.all(
            results.map((r: Document) => this.authorizer.isAuthorized(creds, r as Envelope)),
        );
        results = results.filter((_: Document, i: number) => decisions[i]);

        // `limit` arrives as an ordinary query argument. It truncates after the
        // authorization filter, so a record the caller cannot read never
        // consumes a slot and hides one the caller can.
        const limited = applyLimit(results, args.limit);

        return limited.map((d) => {
            let r = d as Schema;
            r.payload.id = r.id;
            r.payload.createdAt = r.created_at?.toISOString();
            return r.payload;
        });
    }

    ready = async (): Promise<boolean> => {
        try {
            await this.dbClient.db().command({ ping: 1 });
            return true;
        } catch {
            return false;
        }
    };
}
