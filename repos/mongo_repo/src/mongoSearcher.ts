import { Envelope, Searcher } from '@tailoredshapes/meshql-common';
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

    constructor(db: Collection<Envelope>, dtoFactory: DTOFactory, authorizer: Auth, dbClient: MongoClient, collection: string) {
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
            $lt: new Date(timestamp),
        };

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

            // Skip authorization check if no credentials provided (matches SQL repos behavior)
            if (creds.length === 0 || await this.authorizer.isAuthorized(creds, result)) {
                result.payload.id = result.id;
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
            $lt: new Date(timestamp),
        };

        let query = this.processQueryTemplate(args, queryTemplate);

        query.created_at = time_filter;

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

        // Only apply authorization filtering if credentials are provided (matches SQL repos behavior)
        if (args !== undefined && creds.length > 0) {
            results = results.filter((r: Document) => this.authorizer.isAuthorized(creds, r as Envelope));
        }

        return results.map((d) => {
            let r = d as Schema;
            r.payload.id = r.id;
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
