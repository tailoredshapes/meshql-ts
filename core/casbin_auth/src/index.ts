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

    async getAuthToken(context: any): Promise<any> {
        const sub = await this.jwtAuth.getAuthToken(context);
        if (sub.length === 0) {
            return [];
        }
        return await this.enforcer.getRolesForUser(sub[0]);
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
     * Verb-aware RBAC check: does any of `credentials` (subjects/roles, as
     * returned by getAuthToken) have permission to perform `action` on this
     * instance's `resource`? Backed by a real casbin enforcer.enforce()
     * call, unlike isAuthorized's envelope-token ABAC. Credentials with no
     * resolved role fall back to the literal "anonymous" subject, so
     * policy.csv can grant/deny unauthenticated callers explicitly.
     */
    async authorizeAction(credentials: string[], action: Action, _data: Envelope): Promise<boolean> {
        const subjects = credentials.length > 0 ? credentials : ['anonymous'];

        for (const subject of subjects) {
            if (await this.enforcer.enforce(subject, this.resource, action)) {
                return true;
            }
        }

        return false;
    }
}
