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

    it('getAuthToken returns the raw identity from the wrapped Auth, never resolved roles', async () => {
        mockAuth.getAuthToken.mockResolvedValueOnce(['user1']);

        const casbinAuth = await CasbinAuth.create(['model.conf', 'policy.csv'], mockAuth);

        const identity = await casbinAuth.getAuthToken({});

        expect(mockAuth.getAuthToken).toHaveBeenCalledWith({});
        // The bug this replaced: getAuthToken used to call
        // enforcer.getRolesForUser(sub[0]) and return roles instead of the
        // raw sub. Role resolution now happens only inside authorizeAction.
        expect(mockEnforcer.getRolesForUser).not.toHaveBeenCalled();
        expect(identity).toEqual(['user1']);
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
        it('grants when enforcer.enforce resolves true for a credential with no mapped role', async () => {
            mockEnforcer.getRolesForUser.mockResolvedValue([]);
            mockEnforcer.enforce = vi.fn().mockResolvedValue(true);
            const casbinAuth = await CasbinAuth.create(['model.conf', 'policy.csv'], mockAuth, 'lay_report');

            const result = await casbinAuth.authorizeAction(['anonymous'], 'create', { payload: {} });

            expect(result).toBe(true);
            // No role mapped for "anonymous" -> falls back to enforcing the
            // raw subject directly, so policy.csv can target it by name.
            expect(mockEnforcer.enforce).toHaveBeenCalledWith('anonymous', 'lay_report', 'create');
        });

        it('denies when enforcer.enforce resolves false for every credential', async () => {
            mockEnforcer.getRolesForUser.mockResolvedValue([]);
            mockEnforcer.enforce = vi.fn().mockResolvedValue(false);
            const casbinAuth = await CasbinAuth.create(['model.conf', 'policy.csv'], mockAuth, 'lay_report');

            const result = await casbinAuth.authorizeAction(['anonymous'], 'update', { payload: {} });

            expect(result).toBe(false);
        });

        it('falls back to the literal subject "anonymous" when credentials is empty', async () => {
            mockEnforcer.getRolesForUser.mockResolvedValue([]);
            mockEnforcer.enforce = vi.fn().mockResolvedValue(true);
            const casbinAuth = await CasbinAuth.create(['model.conf', 'policy.csv'], mockAuth, 'farm');

            await casbinAuth.authorizeAction([], 'create', { payload: {} });

            expect(mockEnforcer.enforce).toHaveBeenCalledWith('anonymous', 'farm', 'create');
        });

        it('resolves a raw credential to its mapped role and enforces against the role, not the raw subject', async () => {
            // This is the load-bearing case: this model's matcher is flat
            // (r.sub == p.sub, no g() call inside the matcher), so a
            // policy.csv row granting the "worker" role would never match
            // if enforce() were called with the raw sub "svc-account-42"
            // directly.
            mockEnforcer.getRolesForUser.mockResolvedValue(['worker']);
            mockEnforcer.enforce = vi.fn().mockResolvedValue(true);
            const casbinAuth = await CasbinAuth.create(['model.conf', 'policy.csv'], mockAuth, 'hen_productivity');

            const result = await casbinAuth.authorizeAction(['svc-account-42'], 'create', { payload: {} });

            expect(result).toBe(true);
            expect(mockEnforcer.getRolesForUser).toHaveBeenCalledWith('svc-account-42');
            expect(mockEnforcer.enforce).toHaveBeenCalledWith('worker', 'hen_productivity', 'create');
            expect(mockEnforcer.enforce).not.toHaveBeenCalledWith('svc-account-42', expect.anything(), expect.anything());
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

    describe('identity consistency between write (CasbinAuth) and read (a plain Auth like JWTSubAuthorizer) paths', () => {
        it('the same underlying identity resolves to the same value whether wrapped in CasbinAuth or not', async () => {
            // Simulates the actual bug: a graphlette's plain JWTSubAuthorizer
            // (not wrapped in CasbinAuth) resolves the raw JWT sub directly.
            // CasbinAuth wraps the SAME kind of Auth for restlette writes.
            // Before this fix, CasbinAuth.getAuthToken returned resolved
            // roles instead, so the value written to authorized_tokens on
            // write could never match what a read path resolved for the
            // same caller. Now both resolve identically.
            const plainReadAuth = mockAuth; // stands in for JWTSubAuthorizer
            plainReadAuth.getAuthToken.mockResolvedValue(['alice-jwt-sub']);

            const casbinWriteAuth = await CasbinAuth.create(['model.conf', 'policy.csv'], mockAuth);
            // Even though alice maps to a role, that must NOT leak into
            // what's written as her identity.
            mockEnforcer.getRolesForUser.mockResolvedValue(['worker']);

            const writeIdentity = await casbinWriteAuth.getAuthToken({});
            const readIdentity = await plainReadAuth.getAuthToken({});

            expect(writeIdentity).toEqual(readIdentity);
            expect(writeIdentity).toEqual(['alice-jwt-sub']);
        });
    });

    describe('unmapped subject defaults to private, not public', () => {
        it('an authenticated caller with no Casbin role mapping still gets their own identity written, not []', async () => {
            // Before this fix: getAuthToken called getRolesForUser(sub),
            // which returns [] for a subject with no `g` role mapping in
            // policy.csv -- so an authenticated-but-unmapped caller's write
            // got authorized_tokens = [], which the framework treats as
            // "public, visible to everyone" (see isAuthorized above:
            // empty/undefined authorized_tokens => true for any caller).
            // That's backwards: an authenticated caller's default should be
            // private to themselves, not open to everyone.
            mockAuth.getAuthToken.mockResolvedValue(['authenticated-but-unmapped-sub']);
            mockEnforcer.getRolesForUser.mockResolvedValue([]); // no role mapping exists

            const casbinAuth = await CasbinAuth.create(['model.conf', 'policy.csv'], mockAuth);
            const identity = await casbinAuth.getAuthToken({});

            expect(identity).toEqual(['authenticated-but-unmapped-sub']);
            expect(identity).not.toEqual([]);

            // Proves the consequence: authorized_tokens set to this
            // identity now correctly scopes visibility to this caller only.
            const envelope: Envelope = {
                payload: {},
                authorized_tokens: identity,
            };
            expect(await casbinAuth.isAuthorized(identity, envelope)).toBe(true);
            expect(await casbinAuth.isAuthorized(['someone-else'], envelope)).toBe(false);
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
