import { describe, it, expect } from 'vitest';
import {
    canonicalJson,
    Envelope,
    isUnauthorized,
    Unauthorized,
    tombstoneVersion,
    versionOrder,
    versionToken,
    visibleVersion,
} from '../src';

/**
 * The token derivation is a cross-implementation contract: the same version
 * must address identically in TypeScript, Java and Rust, or a version URL stops
 * resolving the moment a deployment moves between them. These tests pin the
 * facts that derivation rests on.
 */

function envelope(id: string, ms: number, payload: Record<string, any>): Envelope {
    return { id, payload, created_at: new Date(ms), deleted: false, auth: ['*'] };
}

describe('versionToken', () => {
    it('hashes the same version the same way every time', () => {
        const a = envelope('d1', 1000, { name: 'Auth', tier: 'prod' });
        const b = envelope('d1', 1000, { name: 'Auth', tier: 'prod' });
        expect(versionToken(a)).toBe(versionToken(b));
    });

    /**
     * The case the whole design exists for: two writes in one millisecond are
     * distinguishable, where a timestamp alone cannot tell them apart.
     */
    it('distinguishes two versions written in the same millisecond', () => {
        const a = envelope('d1', 1000, { name: 'Auth' });
        const b = envelope('d1', 1000, { name: 'Auth Service' });
        expect(a.created_at!.getTime()).toBe(b.created_at!.getTime());
        expect(versionToken(a)).not.toBe(versionToken(b));
    });

    it('distinguishes a different document at the same instant', () => {
        const a = envelope('d1', 1000, { name: 'Auth' });
        const b = envelope('d2', 1000, { name: 'Auth' });
        expect(versionToken(a)).not.toBe(versionToken(b));
    });

    it('distinguishes a deletion from the version it deletes', () => {
        const a = envelope('d1', 1000, { name: 'Auth' });
        const b = { ...envelope('d1', 1000, { name: 'Auth' }), deleted: true };
        expect(versionToken(a)).not.toBe(versionToken(b));
    });

    it('distinguishes two versions marked for different callers', () => {
        const a = { ...envelope('d1', 1000, { name: 'Auth' }), auth: ['alice'] };
        const b = { ...envelope('d1', 1000, { name: 'Auth' }), auth: ['bob'] };
        expect(versionToken(a)).not.toBe(versionToken(b));
    });

    /** The mark's order is incidental; the mark itself is not. */
    it('does not depend on the order of the mark', () => {
        const a = { ...envelope('d1', 1000, { name: 'Auth' }), auth: ['alice', 'bob'] };
        const b = { ...envelope('d1', 1000, { name: 'Auth' }), auth: ['bob', 'alice'] };
        expect(versionToken(a)).toBe(versionToken(b));
    });

    /**
     * The token cannot depend on map iteration order, or the same version would
     * address differently on two adapters.
     */
    it('does not depend on the order of the payload keys', () => {
        const a = envelope('d1', 1000, { a: 1, b: 2 });
        const b = envelope('d1', 1000, { b: 2, a: 1 });
        expect(versionToken(a)).toBe(versionToken(b));
    });

    /**
     * `JSON.stringify` sorts nothing, so nesting is where a naive
     * canonicalization quietly stops working.
     */
    it('does not depend on the order of nested object keys', () => {
        const a = envelope('d1', 1000, { meta: { x: 1, y: 2 } });
        const b = envelope('d1', 1000, { meta: { y: 2, x: 1 } });
        expect(versionToken(a)).toBe(versionToken(b));
    });

    /** Order inside an array is data, not incidental: [1,2] is not [2,1]. */
    it('does depend on the order of an array', () => {
        const a = envelope('d1', 1000, { tags: ['x', 'y'] });
        const b = envelope('d1', 1000, { tags: ['y', 'x'] });
        expect(versionToken(a)).not.toBe(versionToken(b));
    });

    it('is lowercase hex of a SHA-256 digest', () => {
        expect(versionToken(envelope('d1', 1000, { n: 1 }))).toMatch(/^[0-9a-f]{64}$/);
    });

    /**
     * Digests taken from the Rust implementation. They are here so that a
     * change to the derivation cannot pass in one language while the other two
     * keep the old addresses -- the failure would otherwise only show up as a
     * dead version URL after a deployment migrated between stores.
     */
    it('agrees with the reference implementation, byte for byte', () => {
        const cases: [Envelope, string][] = [
            [
                {
                    id: 'd1',
                    created_at: new Date(1000),
                    deleted: false,
                    auth: ['*'],
                    payload: { name: 'Auth', tier: 'prod' },
                },
                '178d0564f9eb77a977ea9ff0eb0836917413ba5dc2e6d5bd6b416883cdfb690b',
            ],
            [
                {
                    id: 'd1',
                    created_at: new Date(1000),
                    deleted: true,
                    auth: ['alice'],
                    payload: { meta: { y: 2, x: 1 }, tags: ['y', 'x'], n: 3 },
                },
                '4131aeb5962dc36b32437d2229d266d44b480ca79bb08985b59bb18a4646bf56',
            ],
            [
                { id: 'widget-42', created_at: new Date(1756832400123), deleted: false, auth: [], payload: {} },
                'af2a1573b7bc4c0ffc5ce7a14b5085ce0019fec2f6a7290ca50dc875284dd72b',
            ],
            [
                {
                    id: 'd\u00e9j\u00e0',
                    created_at: new Date(-1000),
                    deleted: false,
                    auth: ['b', 'a'],
                    payload: { '10': 'a', '2': 'b', z: [1, { q: true, p: null }] },
                },
                'f3c7964321d7f131f67b1ab772f4d74e5afd8afce88517c0bd4d6864ead42be8',
            ],
        ];

        for (const [env, expected] of cases) {
            expect(versionToken(env)).toBe(expected);
        }
    });
});

describe('canonicalJson', () => {
    it('sorts keys at every level and leaves arrays alone', () => {
        expect(canonicalJson({ meta: { y: 2, x: 1 }, a: 1 })).toBe('{"a":1,"meta":{"x":1,"y":2}}');
        expect(canonicalJson({ tags: ['y', 'x'] })).toBe('{"tags":["y","x"]}');
    });

    /**
     * JavaScript enumerates integer-like keys first and in numeric order, so a
     * canonicalization that sorts keys into an object and stringifies it emits
     * `{"2":…,"10":…}` here. The bytes say `"10"` comes first.
     */
    it('sorts integer-like keys by their bytes, not numerically', () => {
        expect(canonicalJson({ '10': 'a', '2': 'b' })).toBe('{"10":"a","2":"b"}');
    });

    it('emits no whitespace', () => {
        expect(canonicalJson({ a: [1, { b: 2 }] })).toBe('{"a":[1,{"b":2}]}');
    });
});

describe('versionOrder', () => {
    /**
     * A write and the delete that buries it land in the same millisecond
     * routinely, and a deletion is by definition later than the version it
     * deletes. Without this key the tombstone sorts by hash and lands anywhere.
     */
    it('puts a deletion after the version it buries, in the same millisecond', () => {
        const written = envelope('d1', 1000, { name: 'Auth' });
        const buried = { ...written, deleted: true };

        expect(versionOrder(written, buried)).toBeLessThan(0);
        expect(versionOrder(buried, written)).toBeGreaterThan(0);
    });

    it('still puts an older deletion before a newer write', () => {
        const buried = { ...envelope('d1', 1000, { name: 'Auth' }), deleted: true };
        const rewritten = envelope('d1', 2000, { name: 'Auth' });

        expect(versionOrder(buried, rewritten)).toBeLessThan(0);
    });

    it('is oldest first, and total within a millisecond', () => {
        const older = envelope('d1', 1000, { n: 1 });
        const a = envelope('d1', 2000, { n: 2 });
        const b = envelope('d1', 2000, { n: 3 });

        expect(versionOrder(older, a)).toBeLessThan(0);
        expect(versionOrder(a, b)).not.toBe(0);
        expect(versionOrder(a, b)).toBe(versionOrder(a, b));
        expect(Math.sign(versionOrder(b, a))).toBe(-Math.sign(versionOrder(a, b)));
    });
});

describe('VersionRef', () => {
    it('carries an address when the caller may read the version', () => {
        const e = envelope('d1', 1000, { secret: true });
        expect(visibleVersion(e).token).toBe(versionToken(e));
    });

    it('carries when, but not what, when the caller may not', () => {
        const e = envelope('d1', 1000, { secret: true });
        const t = tombstoneVersion(e);
        expect(t.token).toBeUndefined();
        expect('token' in t).toBe(false);
        expect(t.created_at).toEqual(e.created_at);
        expect(t.deleted).toBe(false);
    });
});

describe('isUnauthorized', () => {
    /**
     * Recognition cannot rest on `instanceof`: a workspace that loads this
     * module twice -- built once, compiled from source for a test -- gets two
     * classes, and a refusal from one would read as a server fault to the other.
     */
    it('recognizes a refusal thrown by another copy of this module', () => {
        const foreign = { unauthorized: true, name: 'Unauthorized', message: 'nope' };

        expect(isUnauthorized(new Unauthorized())).toBe(true);
        expect(isUnauthorized(foreign)).toBe(true);
        expect(isUnauthorized(new Error('storage is down'))).toBe(false);
        expect(isUnauthorized(undefined)).toBe(false);
    });
});
