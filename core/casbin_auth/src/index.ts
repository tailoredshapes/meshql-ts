import { Enforcer, newEnforcer } from 'casbin';
import { Action, Auth } from '@tailoredshapes/meshql-auth';
import { Envelope } from '@tailoredshapes/meshql-common';

export class CasbinAuth implements Auth {
    enforcer: Enforcer;
    jwtAuth: Auth;
    resource: string;

    // Private constructor to prevent direct instantiation
    private constructor(enforcer: Enforcer, jwtAuth: Auth, resource: string = '') {
        this.enforcer = enforcer;
        this.jwtAuth = jwtAuth;
        this.resource = resource;
    }

    static async create(params: any[], auth: Auth, resource: string = ''): Promise<CasbinAuth> {
        const enforcer = await newEnforcer(...params);
        return new CasbinAuth(enforcer, auth, resource);
    }

    /**
     * Returns a new CasbinAuth sharing this instance's enforcer/policy but
     * scoped to a different Casbin object ("resource"). Lets one loaded
     * model.conf/policy.csv back several per-restlette Auth instances
     * without re-parsing the policy files for each one.
     */
    withResource(resource: string): CasbinAuth {
        return new CasbinAuth(this.enforcer, this.jwtAuth, resource);
    }

    /**
     * Returns the caller's RAW identity (whatever the wrapped `jwtAuth`
     * resolves — e.g. a JWT `sub`), never a resolved Casbin role.
     *
     * This is deliberate, fixing a real bug: this used to return
     * `enforcer.getRolesForUser(sub[0])` (resolved roles), which then got
     * written into `envelope.authorized_tokens` on every write — but reads
     * go through a plain `JWTSubAuthorizer` that resolves the raw `sub`,
     * never a role name. Since a role name and a raw `sub` never coincide,
     * an authenticated writer could never read their own record back via
     * GraphQL, and any role-unmapped caller's writes got
     * `authorized_tokens = []` (public) instead of scoped to themselves.
     * Returning the raw identity here makes writes and reads agree on what
     * "this caller" means, matching `JWTSubAuthorizer`'s behavior exactly.
     * RBAC role resolution still happens, but only inside
     * `authorizeAction`'s `enforce()` call, below — never here.
     */
    async getAuthToken(context: any): Promise<any> {
        return await this.jwtAuth.getAuthToken(context);
    }

    async isAuthorized(credentials: string[], data: Envelope): Promise<boolean> {
        const authorizedTokens = data.authorized_tokens;

        // Allow access if authorized_tokens is empty or undefined
        if (!authorizedTokens || authorizedTokens.length === 0) {
            return true;
        }

        // Check if any of the credentials match authorized tokens
        return authorizedTokens.some((token) => credentials.includes(token));
    }

    /**
     * Verb-aware RBAC check: does any of `credentials` (raw identities, as
     * now returned by getAuthToken — see its doc comment) have permission
     * to perform `action` on this instance's `resource`? Backed by a real
     * casbin enforcer.enforce() call, unlike isAuthorized's envelope-token
     * ABAC.
     *
     * Role resolution happens HERE, not in getAuthToken: this model's
     * matcher is flat (`r.sub == p.sub`, no `g()` call inside the matcher
     * itself — see examples/farm/config/casbin/model.conf), so `enforce()`
     * only ever matches a policy row when `subject` IS already a role name.
     * Each raw credential is resolved via `getRolesForUser` first; a
     * credential with no resolved role is enforced under its own raw value
     * instead (so a `policy.csv` row can still target a specific subject
     * directly, not only roles), and when the credentials list is empty it
     * falls back to the literal "anonymous" subject, so policy.csv can
     * grant/deny unauthenticated callers explicitly.
     */
    async authorizeAction(credentials: string[], action: Action): Promise<boolean> {
        const subjects = credentials.length > 0 ? credentials : ['anonymous'];

        for (const subject of subjects) {
            const roles = await this.enforcer.getRolesForUser(subject);
            const subjectsToEnforce = roles.length > 0 ? roles : [subject];

            for (const s of subjectsToEnforce) {
                if (await this.enforcer.enforce(s, this.resource, action)) {
                    return true;
                }
            }
        }

        return false;
    }
}
