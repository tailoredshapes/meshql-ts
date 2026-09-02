import { v4 as uuid } from 'uuid';
import Log4js from 'log4js';
import { Collection, Document } from 'mongodb';
import { authorized, Envelope, Id, Repository, Session } from '@tailoredshapes/meshql-common';

const logger = Log4js.getLogger('meshql-ts/mongorepo');

/**
 * Mongo storage.
 *
 * It holds no credentials and knows no authorization rule. `auth` is whatever
 * the session stamped, stored in the same document as the payload and never
 * read by this file. Reads fetch and then ask.
 */
export class MongoRepository implements Repository {
    private db: Collection<Envelope>;

    constructor(db: Collection<Envelope>) {
        this.db = db;
    }

    private static toEnvelope(d: Document): Envelope {
        return {
            id: d.id,
            created_at: d.created_at,
            payload: d.payload,
            auth: d.auth,
        };
    }

    create = async (doc: Envelope, session: Session): Promise<Envelope> => {
        const stamped: Envelope = { ...(await session.stamp(doc)) };
        stamped.created_at = new Date();

        if (stamped.id === undefined) {
            stamped.id = uuid();
        }

        await this.db.insertOne(stamped, {
            writeConcern: { w: 'majority' },
        });
        return stamped;
    };

    createMany = async (clean_docs: Envelope[], session: Session): Promise<Envelope[]> => {
        const created_at = new Date();
        const docs: Envelope[] = [];

        for (const doc of clean_docs) {
            const stamped: Envelope = { ...(await session.stamp(doc)) };
            stamped.created_at = created_at;
            stamped.id = uuid();
            docs.push(stamped);
        }

        try {
            await this.db.insertMany(docs);
        } catch (e) {
            logger.error(JSON.stringify(e, null, 2));
        }

        return docs;
    };

    /** The latest non-deleted version, as stored, with no question asked. */
    private latest = async (id: Id, created_at: Date): Promise<Envelope | undefined> => {
        let results: Envelope[] = [];

        const filter: any = {
            id,
            created_at: { $lte: created_at },
            deleted: { $exists: false },
        };

        try {
            results = await this.db.find(filter).sort({ created_at: -1 }).toArray();
        } catch (err) {
            logger.error(`Can't read: ${JSON.stringify(err)}`);
        }

        return results[0];
    };

    read = async (id: Id, session: Session, created_at: Date = new Date()): Promise<Envelope | undefined> => {
        const envelope = await this.latest(id, created_at);
        if (!envelope) return undefined;
        return (await session.isAuthorized('read', envelope)) ? envelope : undefined;
    };

    readMany = async (ids: Id[], session: Session): Promise<Envelope[]> => {
        const match: any = {
            id: { $in: ids },
            deleted: { $exists: false },
        };
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

        return authorized(session, 'read', results.map(MongoRepository.toEnvelope));
    };

    remove = async (id: Id, session: Session): Promise<boolean> => {
        const current = await this.latest(id, new Date());
        if (!current) return false;
        if (!(await session.isAuthorized('remove', current))) return false;

        await this.db.updateMany({ id }, { $set: { deleted: true } });
        return true;
    };

    removeMany = async (ids: Id[], session: Session): Promise<Record<Id, boolean>> => {
        const result: Record<Id, boolean> = {};
        for (const id of ids) {
            result[id] = await this.remove(id, session);
        }
        return result;
    };

    list = async (session: Session): Promise<Envelope[]> => {
        const match = { deleted: { $exists: false } };

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

        return authorized(session, 'read', results.map(MongoRepository.toEnvelope));
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
