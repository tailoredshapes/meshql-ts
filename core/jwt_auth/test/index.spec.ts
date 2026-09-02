import { describe, it, expect, beforeEach } from 'vitest';
import { JWTSubAuthorizer, TokenSession } from '../src';
import { Request } from 'express';
import { Envelope, Session } from '@tailoredshapes/meshql-common';

/**
 * An unsecured JWT (RFC 7519 section 6). meshql never verifies a signature —
 * the gateway does — so this is a faithful fixture, not a weakened one.
 */
function token(claims: Record<string, unknown>): string {
    const seg = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    return `${seg({ alg: 'none', typ: 'JWT' })}.${seg(claims)}.`;
}

describe('JWTSubAuthorizer', () => {
    let authorizer: JWTSubAuthorizer;
    const TEST_SUB = 'test-user';

    beforeEach(() => {
        authorizer = new JWTSubAuthorizer();
    });

    /**
     * The credentials a session resolved are no longer readable from outside
     * it, which is the point of the change: a caller can ask the session a
     * question but cannot re-derive its rule. So they are asserted the only
     * honest way — by what the session says about a record marked with them.
     */
    async function resolvesTo(session: Session, credential: string): Promise<boolean> {
        return session.isAuthorized('read', { payload: {}, auth: [credential] });
    }

    describe('authenticate', () => {
        it('should resolve no credentials when there is no authorization header', async () => {
            const session = await authorizer.authenticate({ headers: {} } as Request);
            expect(await resolvesTo(session, TEST_SUB)).toBe(false);
        });

        it('should resolve no credentials when the authorization header is not Bearer', async () => {
            const session = await authorizer.authenticate({
                headers: { authorization: 'Basic sometoken' },
            } as Request);
            expect(await resolvesTo(session, TEST_SUB)).toBe(false);
        });

        it('should extract sub from a valid JWT token', async () => {
            const session = await authorizer.authenticate({
                headers: { authorization: `Bearer ${token({ sub: TEST_SUB })}` },
            } as Request);

            expect(await resolvesTo(session, TEST_SUB)).toBe(true);
            expect(await resolvesTo(session, 'someone-else')).toBe(false);
        });

        it('should stamp the resolved credentials onto a new version', async () => {
            const session = await authorizer.authenticate({
                headers: { authorization: `Bearer ${token({ sub: TEST_SUB })}` },
            } as Request);

            const stamped = await session.stamp({ payload: { name: 'chuck' } });
            expect(stamped.auth).toEqual([TEST_SUB]);
        });

        it('should stamp an empty mark for a caller with no credentials', async () => {
            const session = await authorizer.authenticate({ headers: {} } as Request);
            const stamped = await session.stamp({ payload: { name: 'chuck' } });
            expect(stamped.auth).toEqual([]);
        });

        // These are the cases the previous implementation got wrong: it indexed
        // the result of jwt.decode(), which is null for anything unparseable,
        // so a bad token raised a TypeError out of an async handler and became
        // a 500 where a 401 was meant.
        it('should resolve no credentials for a malformed token rather than throwing', async () => {
            const session = await authorizer.authenticate({
                headers: { authorization: 'Bearer not-a-jwt' },
            } as Request);
            expect(await resolvesTo(session, TEST_SUB)).toBe(false);
        });

        it('should resolve no credentials when the token carries no sub claim', async () => {
            const session = await authorizer.authenticate({
                headers: { authorization: `Bearer ${token({ name: 'nobody' })}` },
            } as Request);
            expect(await resolvesTo(session, TEST_SUB)).toBe(false);
        });

        it('should resolve no credentials when the payload segment is not JSON', async () => {
            const session = await authorizer.authenticate({
                headers: { authorization: 'Bearer aaa.bbb.ccc' },
            } as Request);
            expect(await resolvesTo(session, TEST_SUB)).toBe(false);
        });
    });

    describe('TokenSession.isAuthorized', () => {
        it('should return true when the envelope carries no mark', async () => {
            const envelope: Envelope = { payload: {} };
            expect(await new TokenSession(['some-cred']).isAuthorized('read', envelope)).toBe(true);
        });

        it('should return true when the mark is empty', async () => {
            const envelope: Envelope = { payload: {}, auth: [] };
            expect(await new TokenSession(['some-cred']).isAuthorized('read', envelope)).toBe(true);
        });

        it('should return true when credentials match the mark', async () => {
            const envelope: Envelope = { payload: {}, auth: ['user1', 'user2'] };
            expect(await new TokenSession(['user1']).isAuthorized('read', envelope)).toBe(true);
        });

        it('should return false when credentials do not match the mark', async () => {
            const envelope: Envelope = { payload: {}, auth: ['user1', 'user2'] };
            expect(await new TokenSession(['user3']).isAuthorized('read', envelope)).toBe(false);
        });

        // The wildcard rule, which used to live wherever anyone chose to write it.
        it('should return true for a wildcard caller whatever the mark says', async () => {
            const envelope: Envelope = { payload: {}, auth: ['user1', 'user2'] };
            expect(await new TokenSession(['*']).isAuthorized('read', envelope)).toBe(true);
        });

        it('should refuse a remove the caller has no token for', async () => {
            const envelope: Envelope = { payload: {}, auth: ['user1'] };
            expect(await new TokenSession(['user3']).isAuthorized('remove', envelope)).toBe(false);
        });

        // A mark another plugin left behind is not a token list, and reading it
        // as one would be inventing an answer.
        it('should treat a mark that is not a token list as no tokens at all', async () => {
            const envelope: Envelope = { payload: {}, auth: { owner: 'alice' } };
            expect(await new TokenSession(['user3']).isAuthorized('read', envelope)).toBe(true);
        });
    });
});
