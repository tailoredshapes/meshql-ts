import { authorized, Envelope, findVersion, Id, Repository, Session, versionRefs, VersionRef } from '../src';
import { v4 as uuidv4 } from 'uuid';

/**
 * The in-memory Repository the restlette tests run against.
 *
 * It is held to the same contract as a real adapter: the session stamps the
 * mark on a write, and every read fetches and then asks. An in-memory
 * repository that skipped the question would let the restlette's tests pass
 * while a real one refused, which is the wrong way round.
 */
export class InMemory implements Repository {
    db: Record<Id, Envelope[]> = {};

    /**
     * When the next version of a document happened.
     *
     * Two versions of one document never share an instant, which is what the
     * `UNIQUE (id, created_at)` constraint and its insert retry buy the SQL
     * adapters. An in-memory double writes fast enough to collide on every
     * write, and a double that collides where a real adapter cannot would let
     * an ordering bug pass here and fail in production.
     */
    private nextInstant(id: Id): Date {
        const versions = this.db[id];
        const previous = versions?.[versions.length - 1]?.created_at?.getTime();
        const now = Date.now();
        return new Date(previous === undefined ? now : Math.max(now, previous + 1));
    }

    async create(payload: Envelope, session: Session): Promise<Envelope> {
        const stamped: Envelope = { ...(await session.stamp(payload)) };
        const id = stamped.id || uuidv4();
        stamped.id = id;
        stamped.created_at = this.nextInstant(id);
        stamped.deleted = false;

        if (this.db[id]) {
            this.db[id].push(stamped);
        } else {
            this.db[id] = [stamped];
        }

        return stamped;
    }

    async createMany(payloads: Envelope[], session: Session): Promise<Envelope[]> {
        const created: Envelope[] = [];
        for (const p of payloads) {
            created.push(await this.create(p, session));
        }
        return created;
    }

    async list(session: Session): Promise<Envelope[]> {
        const result: Envelope[] = [];

        for (const id of Object.keys(this.db)) {
            const latest = this.latest(id, new Date());
            if (latest) result.push(latest);
        }
        return authorized(session, 'read', result);
    }

    /**
     * The most recent version at `created_at`, deleted or not, as stored.
     *
     * A delete appends a tombstone rather than flagging the versions before it,
     * so "is this record gone" is a question about the newest version.
     */
    private latestVersion(id: Id, created_at: Date): Envelope | undefined {
        const envelopes = this.db[id];
        if (!envelopes) return undefined;

        return envelopes
            .filter((e) => e.created_at!.getTime() <= created_at.getTime())
            .sort((a, b) => b.created_at!.getTime() - a.created_at!.getTime())[0];
    }

    /** The latest live version: a tombstone on top means there is none. */
    private latest(id: Id, created_at: Date): Envelope | undefined {
        const envelope = this.latestVersion(id, created_at);
        return envelope && !envelope.deleted ? envelope : undefined;
    }

    async listVersions(id: Id, session: Session): Promise<VersionRef[]> {
        return versionRefs(session, this.db[id] ?? []);
    }

    async readVersion(id: Id, token: string, session: Session): Promise<Envelope | undefined> {
        return findVersion(session, this.db[id] ?? [], token);
    }

    async read(id: Id, session: Session, created_at: Date = new Date()): Promise<Envelope | undefined> {
        const envelope = this.latest(id, created_at);
        if (!envelope) return undefined;
        return (await session.isAuthorized('read', envelope)) ? envelope : undefined;
    }

    async readMany(ids: Id[], session: Session): Promise<Envelope[]> {
        const found = ids.map((id) => this.latest(id, new Date())).filter((e): e is Envelope => e !== undefined);
        return authorized(session, 'read', found);
    }

    async remove(id: Id, session: Session): Promise<boolean> {
        const current = this.latest(id, new Date());
        if (!current) return false;
        if (!(await session.isAuthorized('remove', current))) return false;

        // A delete is a version, not an erasure. The tombstone keeps the mark
        // of the record it buries, and the versions before it keep saying what
        // they always said.
        this.db[id].push({ ...current, created_at: this.nextInstant(id), deleted: true });
        return true;
    }

    async removeMany(ids: Id[], session: Session): Promise<Record<string, boolean>> {
        let r: Record<Id, boolean> = {};

        for (let id of ids) {
            r[id] = await this.remove(id, session);
        }
        return r;
    }

    async ready(): Promise<boolean> {
        return true;
    }
}
