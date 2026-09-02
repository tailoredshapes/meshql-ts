import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CasbinAuth, CredentialResolver } from '../src';
import { Envelope, Session } from '@tailoredshapes/meshql-common';

/**
 * MeshQL resolves identity to capabilities *once*, at the boundary, and then
 * carries the answer down. `CasbinAuth.authenticate` asks casbin for a
 * subject's roles and stops there; it never calls `enforcer.enforce(...)`, and
 * every check below it - `Session.isAuthorized`, called by each repo and
 * searcher - is a local intersection of that token set against a record's
 * mark.
 *
 * That absence is a design decision, not an oversight, and it does not look
 * like one. A scanner sees an authorization library whose decision method is
 * never called and reports a finding; a reviewer sees the same thing and
 * "fixes" it. The cost is invisible until production: a deeper `enforce` is not
 * defence in depth, it is the same decision recomputed per layer, and against a
 * remote policy engine it is a network call per layer. The meshlettes get
 * chatty and nobody remembers why.
 *
 * So the decision is executable. The enforcer below counts.
 *
 * The read is simulated at the auth boundary rather than driven through a live
 * graphlette, because `casbin_auth` is the only package that both owns this
 * decision and can see the enforcer - `graphlette` does not depend on it, and
 * the packages that do build their `CasbinAuth` internally, out of reach of a
 * test. The shape is the read path's exactly: resolve the caller once, then ask
 * `isAuthorized` per record. The equivalent test driven through a real
 * graphlette over HTTP lives in the Java repo as
 * `PolicyEvaluationCountTest.readPathMakesNoPolicyEvaluations`.
 */
describe('policy evaluations on the read path', () => {
    const MODEL = `
[request_definition]
r = sub, obj, act

[policy_definition]
p = sub, obj, act

[role_definition]
g = _, _

[policy_effect]
e = some(where (p.eft == allow))

[matchers]
m = g(r.sub, p.sub) && r.obj == p.obj && r.act == p.act
`;

    const POLICY = `p, tenant_a, hen, read
p, tenant_b, hen, read

g, alice, tenant_a
g, bob, tenant_b
`;

    /** Every method on casbin's Enforcer that decides a policy question. */
    const EVALUATORS = [
        'enforce',
        'enforceWithMatcher',
        'enforceEx',
        'enforceExWithMatcher',
        'batchEnforce',
        'batchEnforceWithMatcher',
    ];

    let modelPath: string;
    let policyPath: string;
    let evaluations: string[];
    let roleLookups: number;
    let casbinAuth: CasbinAuth;

    /**
     * A caller whose JWT resolves to the subject `alice`. `credentialsOf`
     * decodes rather than verifies, by design - the edge authenticates, MeshQL
     * authorizes - so a stub that yields the subject is faithful.
     */
    const subjectResolver: CredentialResolver = () => ['alice'];

    const records: Envelope[] = [
        { id: 'hen-1', payload: { name: 'Chuck' }, auth: ['tenant_a'] },
        { id: 'hen-2', payload: { name: 'Duck' }, auth: ['tenant_b'] },
        { id: 'hen-3', payload: { name: 'Euck' }, auth: ['tenant_a'] },
    ];

    beforeAll(() => {
        const dir = mkdtempSync(join(tmpdir(), 'meshql-policy-count-'));
        modelPath = join(dir, 'model.conf');
        policyPath = join(dir, 'policy.csv');
        writeFileSync(modelPath, MODEL);
        writeFileSync(policyPath, POLICY);
    });

    beforeEach(async () => {
        evaluations = [];
        roleLookups = 0;

        casbinAuth = await CasbinAuth.create([modelPath, policyPath], subjectResolver);

        /**
         * Count, rather than forbid. A test that made `enforce` throw would say
         * "you may not call this"; counting says "a read costs zero of these",
         * which is the actual invariant and reports the number when it breaks.
         */
        const real = casbinAuth.enforcer;
        casbinAuth.enforcer = new Proxy(real, {
            get(target, prop, receiver) {
                const value = Reflect.get(target, prop, receiver);
                if (typeof value !== 'function') return value;

                if (EVALUATORS.includes(String(prop))) {
                    return (...args: unknown[]) => {
                        evaluations.push(String(prop));
                        return value.apply(target, args);
                    };
                }
                if (prop === 'getRolesForUser') {
                    return (...args: unknown[]) => {
                        roleLookups += 1;
                        return value.apply(target, args);
                    };
                }
                return value.bind(target);
            },
        });
    });

    /**
     * **If you are here because you added an `enforce` call and this went red:
     * that is what this test is for.**
     *
     * Authorization in MeshQL is decided once, at the boundary, by resolving a
     * subject to a token set. Everything downstream intersects that set against
     * a record's mark locally. Re-asking the policy engine
     * further down does not make the answer safer - it is the same answer - and
     * it makes every layer pay for it, over the network if the engine is
     * remote.
     *
     * If you genuinely need a policy evaluation on the read path, that is a
     * change to the architecture and it needs its own argument. Do not raise
     * this number to make a build go green.
     */
    it('readPathMakesNoPolicyEvaluations', async () => {
        const session: Session = await casbinAuth.authenticate({});
        const visible: string[] = [];
        for (const record of records) {
            if (await session.isAuthorized('read', record)) {
                visible.push(record.id as string);
            }
        }

        // The read has to have actually happened, or zero evaluations is vacuous.
        // The session's credentials are not readable from outside it, so they
        // are asserted by what it says about a record marked with each tenant.
        expect(await session.isAuthorized('read', { payload: {}, auth: ['tenant_a'] })).toBe(true);
        expect(await session.isAuthorized('read', { payload: {}, auth: ['tenant_b'] })).toBe(false);
        expect(visible).toEqual(['hen-1', 'hen-3']);
        expect(roleLookups).toBeGreaterThan(0);

        expect(
            evaluations,
            `A read evaluated ${evaluations.length} casbin policies (${evaluations.join(', ')}). ` +
                'Identity is resolved to a token set once, at the boundary; every check below ' +
                'that is a local intersection. Re-evaluating the policy downstream recomputes a ' +
                'decision already made, and against a remote policy engine it is a network call ' +
                'per layer. See CasbinAuth.',
        ).toEqual([]);
    });

    /**
     * A per-record `enforce` is the version of this mistake that scales worst,
     * so count the exclusions separately: refusing a record must cost nothing
     * either.
     */
    it('excludingARecordMakesNoPolicyEvaluations', async () => {
        const session = await casbinAuth.authenticate({});
        const refused = await session.isAuthorized('read', records[1]);

        expect(refused).toBe(false);
        expect(
            evaluations,
            `Excluding one record cost ${evaluations.length} policy evaluations. Exclusion is a ` +
                'set intersection on tokens already resolved, not a question for the policy ' +
                'engine - and one evaluation per record is exactly the cost this design avoids. ' +
                'See CasbinAuth.',
        ).toEqual([]);
    });

    /**
     * Identity resolves once per request, not once per record.
     */
    it('identityIsResolvedOncePerRequestNotOncePerRecord', async () => {
        const session = await casbinAuth.authenticate({});
        for (const record of records) {
            await session.isAuthorized('read', record);
        }

        expect(
            roleLookups,
            `casbin resolved roles ${roleLookups} times for one read of ${records.length} ` +
                'records. Identity resolves to capabilities once, at the boundary, and the ' +
                'result is propagated. See CasbinAuth.',
        ).toBe(1);
    });
});
