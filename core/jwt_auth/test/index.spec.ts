import { describe, it, expect, beforeEach } from 'vitest';
import { JWTSubAuthorizer } from '../src';
import { Request } from 'express';
import { Envelope } from '@tailoredshapes/meshql-common';

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

    describe('getAuthToken', () => {
        it('should return empty array when no authorization header', async () => {
            const mockRequest = {
                headers: {},
            } as Request;

            const result = await authorizer.getAuthToken(mockRequest);
            expect(result).toEqual([]);
        });

        it('should return empty array when authorization header is not Bearer', async () => {
            const mockRequest = {
                headers: {
                    authorization: 'Basic sometoken',
                },
            } as Request;

            const result = await authorizer.getAuthToken(mockRequest);
            expect(result).toEqual([]);
        });

        it('should extract sub from valid JWT token', async () => {
            const bearer = token({ sub: TEST_SUB });
            const mockRequest = {
                headers: {
                    authorization: `Bearer ${bearer}`,
                },
            } as Request;

            const result = await authorizer.getAuthToken(mockRequest);
            expect(result).toEqual([TEST_SUB]);
        });

        // These are the cases the previous implementation got wrong: it indexed
        // the result of jwt.decode(), which is null for anything unparseable,
        // so a bad token raised a TypeError out of an async handler and became
        // a 500 where a 401 was meant.
        it('should return empty array for a malformed token rather than throwing', async () => {
            const mockRequest = { headers: { authorization: 'Bearer not-a-jwt' } } as Request;
            await expect(authorizer.getAuthToken(mockRequest)).resolves.toEqual([]);
        });

        it('should return empty array when the token carries no sub claim', async () => {
            const mockRequest = {
                headers: { authorization: `Bearer ${token({ name: 'nobody' })}` },
            } as Request;
            await expect(authorizer.getAuthToken(mockRequest)).resolves.toEqual([]);
        });

        it('should return empty array when the payload segment is not JSON', async () => {
            const mockRequest = { headers: { authorization: 'Bearer aaa.bbb.ccc' } } as Request;
            await expect(authorizer.getAuthToken(mockRequest)).resolves.toEqual([]);
        });
    });

    describe('isAuthorized', () => {
        it('should return true when no authorized_tokens are specified', async () => {
            const envelope: Envelope = { payload: {} };
            const result = await authorizer.isAuthorized(['some-cred'], envelope);
            expect(result).toBe(true);
        });

        it('should return true when authorized_tokens is empty', async () => {
            const envelope: Envelope = { payload: {}, authorized_tokens: [] };
            const result = await authorizer.isAuthorized(['some-cred'], envelope);
            expect(result).toBe(true);
        });

        it('should return true when credentials match authorized_tokens', async () => {
            const envelope: Envelope = { payload: {}, authorized_tokens: ['user1', 'user2'] };
            const result = await authorizer.isAuthorized(['user1'], envelope);
            expect(result).toBe(true);
        });

        it('should return false when credentials do not match authorized_tokens', async () => {
            const envelope: Envelope = { payload: {}, authorized_tokens: ['user1', 'user2'] };
            const result = await authorizer.isAuthorized(['user3'], envelope);
            expect(result).toBe(false);
        });
    });
});
