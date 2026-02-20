import { describe, it, expect, beforeEach } from 'vitest';
import { JWTSubAuthorizer } from '../src';
import { Request } from 'express';
import { Envelope } from '@tailoredshapes/meshql-common';
import jwt from 'jsonwebtoken';

describe('JWTSubAuthorizer', () => {
    let authorizer: JWTSubAuthorizer;
    const SECRET = 'test-secret';
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
            const token = jwt.sign({ sub: TEST_SUB }, SECRET);
            const mockRequest = {
                headers: {
                    authorization: `Bearer ${token}`,
                },
            } as Request;

            const result = await authorizer.getAuthToken(mockRequest);
            expect(result).toEqual([TEST_SUB]);
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
