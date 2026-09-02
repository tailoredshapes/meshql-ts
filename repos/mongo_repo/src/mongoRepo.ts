import { v4 as uuid } from 'uuid';
import Log4js from 'log4js';
import { Collection, Document } from 'mongodb';
import {
    authorized,
    Envelope,
    findVersion,
    Id,
    Repository,
    Session,
    versionRefs,
    VersionRef,
} from '@tailoredshapes/meshql-common';

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
            // A tombstone is the only document that carries the field, so an
            // absent one is a live version rather than a missing answer.
            deleted: !!d.deleted,
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

    /**
     * The most recent version at `created_at`, deleted or not, as stored.
     *
     * A delete appends a tombstone rather than flagging the versions before it,
     * so "is this record gone" is a question about the newest version and not
     * about any of the ones underneath it.
     */
    private latestVersion = async (id: Id, created_at: Date): Promise<Envelope | undefined> => {
        let results: Document[] = [];

        const filter: any = { id, created_at: { $lte: created_at } };

        try {
            results = await this.db.find(filter).sort({ created_at: -1 }).toArray();
        } catch (err) {
            logger.error(`Can't read: ${JSON.stringify(err)}`);
        }

        return results[0] ? MongoRepository.toEnvelope(results[0]) : undefined;
    };

    /** The latest live version: a tombstone on top means there is none. */
    private latest = async (id: Id, created_at: Date): Promise<Envelope | undefined> => {
        const envelope = await this.latestVersion(id, created_at);
        return envelope && !envelope.deleted ? envelope : undefined;
    };

    /** Every stored version of one document; `versionRefs` orders them. */
    private versions = async (id: Id): Promise<Envelope[]> => {
        const results = await this.db.find({ id } as any).toArray();
        return results.map(MongoRepository.toEnvelope);
    };

    listVersions = async (id: Id, session: Session): Promise<VersionRef[]> =>
        versionRefs(session, await this.versions(id));

    readVersion = async (id: Id, token: string, session: Session): Promise<Envelope | undefined> =>
        findVersion(session, await this.versions(id), token);

    read = async (id: Id, session: Session, created_at: Date = new Date()): Promise<Envelope | undefined> => {
        const envelope = await this.latest(id, created_at);
        if (!envelope) return undefined;
        return (await session.isAuthorized('read', envelope)) ? envelope : undefined;
    };

    readMany = async (ids: Id[], session: Session): Promise<Envelope[]> => {
        const match: any = { id: { $in: ids } };
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

        // The newest version of each id decides: reached a tombstone and the
        // record is gone, whatever lies underneath it.
        const live = results.map(MongoRepository.toEnvelope).filter((envelope) => !envelope.deleted);
        return authorized(session, 'read', live);
    };

    remove = async (id: Id, session: Session): Promise<boolean> => {
        const current = await this.latest(id, new Date());
        if (!current) return false;
        if (!(await session.isAuthorized('remove', current))) return false;

        // A delete is a version, not an erasure. The tombstone keeps the mark of
        // the record it buries -- re-stamping it would answer for the plugin --
        // and leaves the versions before it saying what they always said.
        await this.db.insertOne(
            {
                id,
                payload: current.payload,
                created_at: new Date(),
                deleted: true,
                auth: current.auth,
            } as Envelope,
            { writeConcern: { w: 'majority' } },
        );
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
        const match = {};

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

        // The newest version of each id decides: reached a tombstone and the
        // record is gone, whatever lies underneath it.
        const live = results.map(MongoRepository.toEnvelope).filter((envelope) => !envelope.deleted);
        return authorized(session, 'read', live);
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
