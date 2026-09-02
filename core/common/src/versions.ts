import { createHash } from 'node:crypto';
import type { Envelope, Session } from './index';

/**
 * Addressing one version of a document.
 *
 * meshql keeps every version of every document, but a version has no natural
 * address: `created_at` is millisecond precision, so two versions of one
 * document can tie, and nothing else on an envelope distinguishes them.
 *
 * The token below closes that. It is derived from the fields that identify a
 * version rather than from anything the store provides, for two reasons.
 * Postgres and MySQL carry only the envelope columns and have no stable
 * per-row key to borrow, so a natural key would mean a migration on every
 * deployment. And a content-derived token survives a move between adapters:
 * migrate SQLite to Postgres and every version URL still resolves.
 *
 * The derivation is fixed across every meshql implementation, byte for byte:
 * SHA-256, lowercase hex, over the document id, the timestamp, the deletion
 * flag, the authorization mark and the payload, each separated by one 0x1f.
 */

/** One version of a document, as it appears in a version listing. */
export interface VersionRef {
    /**
     * Addresses this version. Absent when the caller is not authorized to read
     * it -- the entry still appears, because omitting it would make the history
     * look continuous when it is not.
     */
    token?: string;
    created_at: Date;
    deleted: boolean;
}

/** Refusing a version the caller was already told exists. */
export class Unauthorized extends Error {
    /** The marker `isUnauthorized` recognizes. */
    readonly unauthorized = true;

    constructor(message = 'not authorized to read this version') {
        super(message);
        this.name = 'Unauthorized';
    }
}

/**
 * Recognizes a refusal.
 *
 * By a marker rather than by `instanceof`. A workspace can hold two copies of
 * this module -- one built, one compiled from source for a test -- and two
 * copies of the class make `instanceof` answer no to an error thrown by the
 * other one. A refusal that reads as a server fault is worse than useless: it
 * tells the caller to retry something that will never succeed.
 */
export function isUnauthorized(error: unknown): error is Unauthorized {
    return typeof error === 'object' && error !== null && (error as { unauthorized?: unknown }).unauthorized === true;
}

const UNIT_SEPARATOR = Buffer.from([0x1f]);

/**
 * Orders two strings by their UTF-8 bytes.
 *
 * JavaScript compares strings by UTF-16 code unit, which disagrees with every
 * other implementation's byte order above U+FFFF. One derivation means one
 * ordering, so the bytes decide.
 */
export function compareUtf8(a: string, b: string): number {
    return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * JSON with no whitespace and every object's keys sorted, recursively.
 *
 * The string is built by hand rather than by sorting keys into a new object and
 * handing it to `JSON.stringify`: JavaScript enumerates integer-like keys first
 * and in numeric order whatever order they were inserted in, so `{"10":…,"2":…}`
 * would serialize out of the sort this function exists to impose.
 *
 * Array order is data, not incidental, and is left exactly as it is.
 */
export function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(',')}]`;
    }

    if (value !== null && typeof value === 'object') {
        const source = value as Record<string, unknown>;
        const keys = Object.keys(source)
            .filter((key) => source[key] !== undefined)
            .sort(compareUtf8);
        return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`).join(',')}}`;
    }

    const literal = JSON.stringify(value);
    return literal === undefined ? 'null' : literal;
}

/**
 * The token plugin's mark, sorted.
 *
 * The mark is opaque -- a plugin may stamp a list of tokens, an object, or
 * nothing at all. Only a list of strings contributes to the address; anything
 * else contributes an empty list, exactly as a record with no mark does.
 */
function authParts(auth: unknown): string[] {
    if (!Array.isArray(auth)) return [];
    return auth.filter((part): part is string => typeof part === 'string').sort(compareUtf8);
}

/**
 * Derive a version's token.
 *
 * Two versions collide only when the document id, the timestamp, the deletion
 * flag, the authorization mark and the payload are all identical -- which makes
 * them the same version recorded twice, indistinguishable by any other means.
 */
export function versionToken(envelope: Envelope): string {
    const millis = Buffer.alloc(8);
    millis.writeBigInt64BE(BigInt(envelope.created_at ? envelope.created_at.getTime() : 0));

    const hash = createHash('sha256');
    hash.update(Buffer.from(envelope.id ?? '', 'utf8'));
    hash.update(UNIT_SEPARATOR);
    hash.update(millis);
    hash.update(UNIT_SEPARATOR);
    hash.update(Buffer.from([envelope.deleted ? 1 : 0]));
    hash.update(UNIT_SEPARATOR);
    hash.update(Buffer.from(canonicalJson(authParts(envelope.auth)), 'utf8'));
    hash.update(UNIT_SEPARATOR);
    hash.update(Buffer.from(canonicalJson(envelope.payload ?? {}), 'utf8'));

    return hash.digest('hex');
}

/**
 * Orders versions of one document: oldest first, then undeleted before deleted,
 * then by token.
 *
 * The middle key is not decoration. A write and the delete that buries it land
 * in the same millisecond routinely, and a deletion is by definition later than
 * the version it deletes; without it the tombstone sorts by hash and lands
 * anywhere in the history.
 *
 * The last key is arbitrary but identical on every adapter, which is what makes
 * a version listing reproducible. Leaning on a physical row id instead gives one
 * answer on SQLite and another everywhere else.
 */
export function versionOrder(a: Envelope, b: Envelope): number {
    const first = a.created_at ? a.created_at.getTime() : 0;
    const second = b.created_at ? b.created_at.getTime() : 0;
    if (first !== second) return first - second;

    const buried = Number(!!a.deleted) - Number(!!b.deleted);
    if (buried !== 0) return buried;

    return compareUtf8(versionToken(a), versionToken(b));
}

/** A version the caller may read, with the address that reaches it. */
export function visibleVersion(envelope: Envelope): VersionRef {
    return {
        token: versionToken(envelope),
        created_at: envelope.created_at ?? new Date(0),
        deleted: !!envelope.deleted,
    };
}

/**
 * A version the caller cannot read. Carries when it happened and whether it was
 * a deletion, and nothing else.
 */
export function tombstoneVersion(envelope: Envelope): VersionRef {
    return {
        created_at: envelope.created_at ?? new Date(0),
        deleted: !!envelope.deleted,
    };
}

/**
 * Every version an adapter holds, ordered and answered for.
 *
 * Adapters differ in how they fetch a document's versions and in nothing else,
 * so ordering and the authorization question live here rather than eleven
 * times over.
 */
export async function versionRefs(session: Session, envelopes: Envelope[]): Promise<VersionRef[]> {
    const ordered = [...envelopes].sort(versionOrder);
    const decisions = await Promise.all(ordered.map((envelope) => session.isAuthorized('read', envelope)));
    return ordered.map((envelope, i) => (decisions[i] ? visibleVersion(envelope) : tombstoneVersion(envelope)));
}

/**
 * The version a token addresses.
 *
 * An unknown token is absent. A version the caller cannot read is refused, not
 * absent: the listing already told them it exists, and answering "no such
 * version" would contradict the answer they were just given.
 */
export async function findVersion(
    session: Session,
    envelopes: Envelope[],
    token: string,
): Promise<Envelope | undefined> {
    for (const envelope of envelopes) {
        if (versionToken(envelope) !== token) continue;
        if (!(await session.isAuthorized('read', envelope))) throw new Unauthorized();
        return envelope;
    }
    return undefined;
}
