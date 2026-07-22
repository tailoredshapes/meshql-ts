import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CasbinAuth } from '../src';
import { Enforcer, newEnforcer } from 'casbin';
import { Auth } from '@tailoredshapes/meshql-auth';
import { Envelope } from '@tailoredshapes/meshql-common';

// Mock casbin module
vi.mock('casbin', () => ({
    newEnforcer: vi.fn(),
}));

describe('CasbinAuth', () => {
    let mockEnforcer: vi.Mocked<Enforcer>;
    let mockAuth: vi.Mocked<Auth>;

    beforeEach(() => {
        // Mock Enforcer methods
        mockEnforcer = {
            getRolesForUser: vi.fn(),
        } as unknown as vi.Mocked<Enforcer>;

        // Mock newEnforcer to return the mocked Enforcer
        (newEnforcer as vi.Mock).mockResolvedValue(mockEnforcer);

        // Mock Auth methods
        mockAuth = {
            getAuthToken: vi.fn(),
            isAuthorized: vi.fn(),
            authorizeAction: vi.fn(),
        } as vi.Mocked<Auth>;

        mockAuth.getAuthToken.mockResolvedValue(['user1']);
        mockAuth.isAuthorized.mockResolvedValue(true);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('should initialize CasbinAuth correctly', async () => {
        const casbinAuth = await CasbinAuth.create(['model.conf', 'policy.csv'], mockAuth);

        expect(casbinAuth).toBeDefined();
        expect(casbinAuth.enforcer).toBe(mockEnforcer);
        expect(newEnforcer).toHaveBeenCalledWith('model.conf', 'policy.csv');
    });

    it('should retrieve roles for a user via getAuthToken', async () => {
        mockAuth.getAuthToken.mockResolvedValueOnce(['user1']);
        mockEnforcer.getRolesForUser.mockResolvedValueOnce(['role1', 'role2']);

        const casbinAuth = await CasbinAuth.create(['model.conf', 'policy.csv'], mockAuth);

        const roles = await casbinAuth.getAuthToken({});

        expect(mockAuth.getAuthToken).toHaveBeenCalledWith({});
        expect(mockEnforcer.getRolesForUser).toHaveBeenCalledWith('user1');
        expect(roles).toEqual(['role1', 'role2']);
    });

    it('should authorize correctly when credentials match tokens', async () => {
        const casbinAuth = await CasbinAuth.create(['model.conf', 'policy.csv'], mockAuth);

        const envelope: Envelope = {
            payload: { pay: 'load' },
            authorized_tokens: ['token1', 'token2'],
        };

        const isAuthorized = await casbinAuth.isAuthorized(['token2'], envelope);

        expect(isAuthorized).toBe(true);
    });

    it('should deny authorization when credentials do not match tokens', async () => {
        const casbinAuth = await CasbinAuth.create(['model.conf', 'policy.csv'], mockAuth);

        const envelope: Envelope = {
            payload: { pay: 'load' },
            authorized_tokens: ['token1', 'token2'],
        };

        const isAuthorized = await casbinAuth.isAuthorized(['token3'], envelope);

        expect(isAuthorized).toBe(false);
    });

    it('should authorize everyone when authorized_tokens is empty', async () => {
        const casbinAuth = await CasbinAuth.create(['model.conf', 'policy.csv'], mockAuth);

        const envelope: Envelope = {
            payload: { pay: 'load' },
            authorized_tokens: [],
        };

        const isAuthorized = await casbinAuth.isAuthorized([], envelope);

        expect(isAuthorized).toBe(true);
    });

    describe('authorizeAction', () => {
        it('grants when enforcer.enforce resolves true for a credential', async () => {
            mockEnforcer.enforce = vi.fn().mockResolvedValue(true);
            const casbinAuth = await CasbinAuth.create(['model.conf', 'policy.csv'], mockAuth, 'lay_report');

            const result = await casbinAuth.authorizeAction(['anonymous'], 'create', { payload: {} });

            expect(result).toBe(true);
            expect(mockEnforcer.enforce).toHaveBeenCalledWith('anonymous', 'lay_report', 'create');
        });

        it('denies when enforcer.enforce resolves false for every credential', async () => {
            mockEnforcer.enforce = vi.fn().mockResolvedValue(false);
            const casbinAuth = await CasbinAuth.create(['model.conf', 'policy.csv'], mockAuth, 'lay_report');

            const result = await casbinAuth.authorizeAction(['anonymous'], 'update', { payload: {} });

            expect(result).toBe(false);
        });

        it('falls back to the literal subject "anonymous" when credentials is empty', async () => {
            mockEnforcer.enforce = vi.fn().mockResolvedValue(true);
            const casbinAuth = await CasbinAuth.create(['model.conf', 'policy.csv'], mockAuth, 'farm');

            await casbinAuth.authorizeAction([], 'create', { payload: {} });

            expect(mockEnforcer.enforce).toHaveBeenCalledWith('anonymous', 'farm', 'create');
        });
    });

    describe('withResource', () => {
        it('clones with a different resource but the same enforcer', async () => {
            const casbinAuth = await CasbinAuth.create(['model.conf', 'policy.csv'], mockAuth, 'farm');
            const scoped = casbinAuth.withResource('hen_productivity');

            expect(scoped.enforcer).toBe(casbinAuth.enforcer);
            expect(scoped.resource).toBe('hen_productivity');
            expect(casbinAuth.resource).toBe('farm');
        });
    });

    describe('getAuthToken with no bearer token', () => {
        it('returns [] without calling getRolesForUser(undefined)', async () => {
            mockAuth.getAuthToken.mockResolvedValueOnce([]);
            const casbinAuth = await CasbinAuth.create(['model.conf', 'policy.csv'], mockAuth);

            const roles = await casbinAuth.getAuthToken({});

            expect(roles).toEqual([]);
            expect(mockEnforcer.getRolesForUser).not.toHaveBeenCalled();
        });
    });
});
