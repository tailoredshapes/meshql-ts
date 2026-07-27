import { v4 as uuid } from 'uuid';
import Log4js from 'log4js';
import { Collection, Document } from 'mongodb';
import { Envelope, Id, Repository } from '@tailoredshapes/meshql-common';

const logger = Log4js.getLogger('meshql-ts/mongorepo');

// The field on the stored envelope is `authorized_tokens`; filtering on
// `authorized_readers` matched nothing, so every token-scoped read came back
// empty instead of coming back scoped.
function secureRead(tokens: string[], match: any): any {
    if (tokens.length > 0) {
        match.authorized_tokens = { $in: tokens };
    }
    return match;
}

export class MongoRepository implements Repository {
    private db: Collection<Envelope>;

    constructor(db: Collection<Envelope>) {
        this.db = db;
    }

    /**
     * The envelope is the source of truth for `authorized_tokens`: the
     * restlette resolves the caller's tokens and puts them there. The `tokens`
     * parameter is the fallback for direct Repository callers that build a
     * bare envelope.
     */
    private static tokensFor(doc: Envelope, tokens: string[] = []): string[] {
        return doc.authorized_tokens ?? tokens ?? [];
    }

    create = async (doc: Envelope, tokens: string[] = []): Promise<Envelope> => {
        doc.created_at = new Date();
        doc.authorized_tokens = MongoRepository.tokensFor(doc, tokens);

        if (!Object.hasOwnProperty.call(doc, 'id')) {
            doc.id = uuid();
        }

        await this.db.insertOne(doc, {
            writeConcern: { w: 'majority' },
        });
        return doc;
    };

    createMany = async (clean_docs: Envelope[], tokens: string[] = []): Promise<Envelope[]> => {
        const created_at = new Date();
        const docs: Envelope[] = clean_docs.map((doc) => {
            doc.created_at = created_at;
            doc.authorized_tokens = MongoRepository.tokensFor(doc, tokens);
            doc.id = uuid();
            return doc;
        });

        try {
            await this.db.insertMany(docs);
        } catch (e) {
            logger.error(JSON.stringify(e, null, 2));
        }

        return docs;
    };

    read = async (id: Id, tokens: string[] = [], created_at: Date = new Date()): Promise<Envelope | undefined> => {
        let results: Envelope[] = [];

        let filter: any = {
            id,
            created_at: { $lte: created_at },
            deleted: { $exists: false },
        };

        secureRead(tokens, filter);
        try {
            results = await this.db.find(filter).sort({ created_at: -1 }).toArray();
        } catch (err) {
            logger.error(`Can't read: ${JSON.stringify(err)}`);
        }

        return results[0];
    };

    readMany = async (ids: Id[], tokens: string[] = []): Promise<Envelope[]> => {
        const match: any = {
            id: { $in: ids },
            deleted: { $exists: false },
        };
        secureRead(tokens, match);
        let results: Document[] = [];

        try {
            results = await this.db
                .aggregate([
                    {
                        $match: match,
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
        } catch (err) {
            logger.error(`Error listing: ${JSON.stringify(err, null, 2)}`);
        }

        return results.map((d) => {
            return {
                id: d.id,
                created_at: d.created_at,
                payload: d.payload,
                authorized_tokens: d.authorized_tokens ?? [],
            };
        });
    };

    remove = async (id: Id, tokens: string[] = []): Promise<boolean> => {
        await this.db.updateMany(secureRead(tokens, { id }), { $set: { deleted: true } });
        return true;
    };

    removeMany = async (ids: Id[], tokens: string[] = []): Promise<Record<Id, boolean>> => {
        await this.db.updateMany(secureRead(tokens, { id: { $in: ids } }), { $set: { deleted: true } });
        //hack: should compare match to modified then figure out what didn't get removed
        let result: Record<Id, boolean> = {};
        for (let id of ids) {
            result[id] = true;
        }
        return result;
    };

    list = async (tokens: string[] = []): Promise<Envelope[]> => {
        const match = secureRead(tokens, { deleted: { $exists: false } });

        let results: Document[] = [];

        try {
            results = await this.db
                .aggregate([
                    {
                        $match: match,
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
        } catch (err) {
            logger.error(`Error listing: ${JSON.stringify(err)}`);
        }

        return results.map((d) => {
            return {
                id: d.id,
                created_at: d.created_at,
                payload: d.payload,
                authorized_tokens: d.authorized_tokens ?? [],
            };
        });
    };

    ready = async (): Promise<boolean> => {
        try {
            await (this.db as any).db.command({ ping: 1 });
            return true;
        } catch {
            return false;
        }
    };
}
