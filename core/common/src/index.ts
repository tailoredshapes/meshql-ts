import { TemplateDelegate } from 'handlebars';
import { z } from 'zod';

// Export logging utilities
export { configureLogging, getLogger } from './logging';

// Addressing one version of a document
export * from './versions';

import type { VersionRef } from './versions';

// Convert common types to Zod schemas
export const SingletonSchema = z.object({
    query: z.string(),
    name: z.string(),
    id: z.string().optional(),
});

export type Singleton = z.infer<typeof SingletonSchema>;

export const VectorSchema = z.object({
    query: z.string(),
    name: z.string(),
    id: z.string().optional(),
});

export type Vector = z.infer<typeof VectorSchema>;

export const ResolverSchema = z.object({
    name: z.string(),
    id: z.string().optional(),
    queryName: z.string(),
    url: z.string().url(),
});

export type Resolver = z.infer<typeof ResolverSchema>;

export const RootConfigSchema = z.object({
    singletons: z.array(SingletonSchema).optional(),
    vectors: z.array(VectorSchema).optional(),
    resolvers: z.array(ResolverSchema).optional(),
});

export type RootConfig = z.infer<typeof RootConfigSchema>;

export const IdSchema = z.string();
export type Id = z.infer<typeof IdSchema>;

export const PayloadSchema = z.record(z.any());
export type Payload = z.infer<typeof PayloadSchema>;

export const EnvelopeSchema = z.object({
    id: IdSchema.optional(),
    payload: PayloadSchema,
    created_at: z.date().optional(),
    deleted: z.boolean().optional(),
    /**
     * The auth plugin's mark, and nothing else's.
     *
     * It is deliberately `unknown`. Storage persists it verbatim, in the same
     * write as the payload, and never looks inside it -- a mark that storage
     * can read is a rule storage can reimplement, and eleven adapters
     * reimplementing one rule eleven ways is the defect this type exists to
     * make impossible. A token plugin puts a list of strings here; a plugin
     * that authorizes on an owner field puts nothing here at all.
     */
    auth: z.unknown().optional(),
});

export type Envelope = z.infer<typeof EnvelopeSchema>;

/**
 * What the caller is asking to do with a record.
 *
 * One question with an operand, rather than a visibility check and a separate
 * action check that can disagree with each other.
 */
export type Operation = 'read' | 'create' | 'remove';

/**
 * One request's authorization state, resolved once by the auth plugin and
 * carried down to storage.
 *
 * A session is request-scoped and opaque. There is no rule on it for a caller
 * to re-derive, which is precisely why it is safe to hand to a storage
 * adapter: the adapter can ask, and cannot answer.
 */
export interface Session {
    /** The mark to persist with a new version. The plugin decides what it is. */
    stamp(envelope: Envelope): Promise<Envelope>;

    /** May this session perform `operation` on this envelope? */
    isAuthorized(operation: Operation, envelope: Envelope): Promise<boolean>;
}

/**
 * The auth plugin. Its whole surface: turn a request into a session.
 *
 * `requestContext` is the portable map an edge lifts from trusted identity
 * headers -- an object carrying `headers`, not a runtime-specific request.
 */
export interface Auth {
    authenticate(requestContext: Record<string, any>): Promise<Session>;
}

/**
 * Storage. Every method takes the session, because there is no unset session:
 * a caller outside a request passes an explicit system session rather than
 * omitting one, and an omitted one is a compile error rather than a silent
 * allow.
 *
 * No method takes credentials. An adapter cannot see who is asking, only
 * whether the plugin says yes.
 */
export interface Repository {
    create: (envelope: Envelope, session: Session) => Promise<Envelope>;
    read: (id: Id, session: Session, createdAt?: Date) => Promise<Envelope | undefined>;
    list: (session: Session) => Promise<Envelope[]>;
    remove: (id: Id, session: Session) => Promise<boolean>;
    createMany: (payloads: Envelope[], session: Session) => Promise<Envelope[]>;
    readMany: (ids: Id[], session: Session) => Promise<Envelope[]>;
    removeMany: (ids: Id[], session: Session) => Promise<Record<Id, boolean>>;

    /**
     * Every version of one document, oldest first.
     *
     * A version the caller cannot read still appears, carrying when it happened
     * and whether it was a deletion, and no token. Omitting it would make the
     * history look continuous when it is not.
     *
     * Required, with no default that answers "unsupported": a default lets an
     * adapter fall out of conformance with nothing saying so.
     */
    listVersions: (id: Id, session: Session) => Promise<VersionRef[]>;

    /**
     * One version, addressed by the token a listing handed out.
     *
     * Authorized exactly as `read` is. An unknown token is `undefined`; a token
     * for a version the caller may not read throws `Unauthorized`.
     */
    readVersion: (id: Id, token: string, session: Session) => Promise<Envelope | undefined>;

    ready: () => Promise<boolean>;
}

export interface Searcher {
    find(
        queryTemplate: TemplateDelegate,
        args: Record<string, any>,
        session: Session,
        timestamp?: number,
    ): Promise<Record<string, any>>;
    findAll(
        queryTemplate: TemplateDelegate,
        args: Record<string, any>,
        session: Session,
        timestamp?: number,
    ): Promise<Record<string, any>[]>;
    ready: () => Promise<boolean>;
}

/**
 * Keeps only the envelopes the session authorizes for `operation`.
 *
 * `isAuthorized` is async, so `Array.prototype.filter` over it tests a
 * Promise -- which is always truthy, and silently authorizes everything.
 * Resolve every decision first, then filter on the resolved booleans.
 */
export async function authorized<T extends Envelope>(
    session: Session,
    operation: Operation,
    envelopes: T[],
): Promise<T[]> {
    const decisions = await Promise.all(envelopes.map((envelope) => session.isAuthorized(operation, envelope)));
    return envelopes.filter((_, i) => decisions[i]);
}

/**
 * Truncates a result set to a `limit` query argument.
 *
 * A searcher passes the raw `args.limit` it received. An absent or
 * unparseable limit leaves the results untouched, so a query without a limit
 * behaves exactly as it did before.
 *
 * Always applied AFTER authorization: a record the caller cannot read must
 * never consume a slot and hide one they can.
 */
export function applyLimit<T>(results: T[], limit: unknown): T[] {
    if (limit === undefined || limit === null) return results;

    const count = Number(limit);
    if (!Number.isFinite(count)) return results;

    return results.slice(0, Math.max(Math.trunc(count), 0));
}

export interface Validator {
    (data: Record<string, any>): Promise<boolean>;
}
