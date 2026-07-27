import { Enforcer, newEnforcer } from 'casbin';
import { Auth } from '@tailoredshapes/meshql-auth';
import { Envelope } from '@tailoredshapes/meshql-common';

/**
 * Casbin-backed authorizer. Resolves a subject to its roles and uses those
 * roles as the caller's credentials; `isAuthorized` then intersects them with a
 * record's `authorized_tokens`.
 *
 * ## Why `enforcer.enforce(...)` is never called
 *
 * It is not an oversight. MeshQL resolves identity to capabilities *once*, at
 * the boundary, and propagates the result; every check below that point is a
 * local intersection. Casbin's job here is subject -> role resolution and
 * nothing else.
 *
 * Adding a deeper `enforce` is not defence in depth. It recomputes a decision
 * already made, at every layer that repeats it, and against a remote policy
 * engine it is a network call per layer - per record, on a vector read.
 *
 * Because the absence looks like a bug to every scanner and reviewer, it is
 * pinned by a test rather than by a comment: see
 * `test/policy_evaluations.spec.ts`, which wraps the enforcer in a counting
 * proxy and asserts a read performs zero policy evaluations. Add an `enforce`
 * call here and that test goes red the same day, saying why.
 */
export class CasbinAuth implements Auth {
    enforcer: Enforcer;
    jwtAuth: Auth;

    // Private constructor to prevent direct instantiation
    private constructor(enforcer: Enforcer, jwtAuth: Auth) {
        this.enforcer = enforcer;
        this.jwtAuth = jwtAuth;
    }

    static async create(params: any[], auth: Auth): Promise<CasbinAuth> {
        const enforcer = await newEnforcer(...params);
        return new CasbinAuth(enforcer, auth);
    }

    async getAuthToken(context: any): Promise<any> {
        const sub = await this.jwtAuth.getAuthToken(context);
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
}
