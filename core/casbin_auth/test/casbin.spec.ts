import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CasbinAuth, CredentialResolver } from '../src';
import { Enforcer, newEnforcer } from 'casbin';
import { Envelope, Session } from '@tailoredshapes/meshql-common';

// Mock casbin module
vi.mock('casbin', () => ({
    newEnforcer: vi.fn(),
}));

describe('CasbinAuth', () => {
    let mockEnforcer: vi.Mocked<Enforcer>;
    let resolveSubject: CredentialResolver;

    beforeEach(() => {
        // Mock Enforcer methods
        mockEnforcer = {
            getRolesForUser: vi.fn(),
        } as unknown as vi.Mocked<Enforcer>;

        // Mock newEnforcer to return the mocked Enforcer
        (newEnforcer as vi.Mock).mockResolvedValue(mockEnforcer);

        resolveSubject = vi.fn(() => ['user1']) as unknown as CredentialResolver;
        mockEnforcer.getRolesForUser.mockResolvedValue(['token1', 'token2']);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('should initialize CasbinAuth correctly', async () => {
        const casbinAuth = await CasbinAuth.create(['model.conf', 'policy.csv'], resolveSubject);

        expect(casbinAuth).toBeDefined();
        expect(casbinAuth.enforcer).toBe(mockEnforcer);
        expect(newEnforcer).toHaveBeenCalledWith('model.conf', 'policy.csv');
    });

    it('should retrieve roles for a user when authenticating', async () => {
        mockEnforcer.getRolesForUser.mockResolvedValueOnce(['role1', 'role2']);

        const casbinAuth = await CasbinAuth.create(['model.conf', 'policy.csv'], resolveSubject);
        const session: Session = await casbinAuth.authenticate({});

        expect(resolveSubject).toHaveBeenCalledWith({});
        expect(mockEnforcer.getRolesForUser).toHaveBeenCalledWith('user1');

        // The roles are the caller's credentials, and the only way to observe
        // them from outside is to ask the session about a record marked with
        // one -- which is exactly the point of an opaque session.
        expect(await session.isAuthorized('read', { payload: {}, auth: ['role2'] })).toBe(true);
        expect(await session.isAuthorized('read', { payload: {}, auth: ['role3'] })).toBe(false);
    });

    it('should authorize correctly when credentials match tokens', async () => {
        const casbinAuth = await CasbinAuth.create(['model.conf', 'policy.csv'], resolveSubject);
        const session = await casbinAuth.authenticate({});

        const envelope: Envelope = {
            payload: { pay: 'load' },
            auth: ['token2', 'token9'],
        };

        expect(await session.isAuthorized('read', envelope)).toBe(true);
    });

    it('should deny authorization when credentials do not match tokens', async () => {
        const casbinAuth = await CasbinAuth.create(['model.conf', 'policy.csv'], resolveSubject);
        const session = await casbinAuth.authenticate({});

        const envelope: Envelope = {
            payload: { pay: 'load' },
            auth: ['token3'],
        };

        expect(await session.isAuthorized('read', envelope)).toBe(false);
    });

    it('should authorize everyone when the mark is empty', async () => {
        const casbinAuth = await CasbinAuth.create(['model.conf', 'policy.csv'], resolveSubject);
        const session = await casbinAuth.authenticate({});

        const envelope: Envelope = {
            payload: { pay: 'load' },
            auth: [],
        };

        expect(await session.isAuthorized('read', envelope)).toBe(true);
    });

    it('should resolve no roles for a caller with no subject', async () => {
        const casbinAuth = await CasbinAuth.create(['model.conf', 'policy.csv'], () => []);
        const session = await casbinAuth.authenticate({});

        expect(mockEnforcer.getRolesForUser).not.toHaveBeenCalled();
        expect(await session.isAuthorized('read', { payload: {}, auth: ['token1'] })).toBe(false);
        expect(await session.isAuthorized('read', { payload: {} })).toBe(true);
    });
});
