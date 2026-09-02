import { authorized, Envelope, Id, Repository, Session } from '../src';
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

    async create(payload: Envelope, session: Session): Promise<Envelope> {
        const stamped: Envelope = { ...(await session.stamp(payload)) };
        const id = stamped.id || uuidv4();
        stamped.id = id;
        stamped.created_at = new Date();
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
        const seen = new Set<Id>();

        for (const envList of Object.values(this.db)) {
            // Filter out deleted envelopes
            const nonDeletedEnvelopes = envList.filter((e) => !e.deleted);
            if (nonDeletedEnvelopes.length > 0) {
                // Sort by created_at descending to get the latest version
                nonDeletedEnvelopes.sort((a, b) => b.created_at!.getTime() - a.created_at!.getTime());
                const latestEnvelope = nonDeletedEnvelopes[0];

                // Add the latest envelope if it hasn't been added yet
                if (!seen.has(latestEnvelope.id!)) {
                    seen.add(latestEnvelope.id!);
                    result.push(latestEnvelope);
                }
            }
        }
        return authorized(session, 'read', result);
    }

    /** The latest non-deleted version, as stored, with no question asked. */
    private latest(id: Id, created_at: Date): Envelope | undefined {
        const envelopes = this.db[id];
        if (!envelopes) return undefined;

        return envelopes
            .filter((e) => e.created_at!.getTime() <= created_at.getTime() && e.deleted === false)
            .sort((a, b) => b.created_at!.getTime() - a.created_at!.getTime())[0];
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

        this.db[id] = this.db[id].map((e) => {
            e.deleted = true;
            return e;
        });
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
