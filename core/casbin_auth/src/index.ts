import { Enforcer, newEnforcer } from 'casbin';
import { Auth, Session } from '@tailoredshapes/meshql-common';
import { credentialsOf, TokenSession } from '@tailoredshapes/meshql-jwt_auth';

/**
 * Casbin-backed token plugin. Resolves a subject to its roles and hands those
 * roles to a `TokenSession`, which owns every rule about what a token means.
 *
 * ## Why `enforcer.enforce(...)` is never called
 *
 * It is not an oversight. MeshQL resolves identity to capabilities *once*, at
 * the boundary, and propagates the resulting session; every check below that
 * point is a local decision inside that session.
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
export type CredentialResolver = (context: Record<string, any>) => string[];

export class CasbinAuth implements Auth {
    enforcer: Enforcer;
    private readonly resolveSubject: CredentialResolver;

    // Private constructor to prevent direct instantiation
    private constructor(enforcer: Enforcer, resolveSubject: CredentialResolver) {
        this.enforcer = enforcer;
        this.resolveSubject = resolveSubject;
    }

    static async create(params: any[], resolveSubject: CredentialResolver = credentialsOf): Promise<CasbinAuth> {
        const enforcer = await newEnforcer(...params);
        return new CasbinAuth(enforcer, resolveSubject);
    }

    async authenticate(context: Record<string, any>): Promise<Session> {
        const subjects = this.resolveSubject(context);
        const roles = subjects.length > 0 ? await this.enforcer.getRolesForUser(subjects[0]) : [];
        return new TokenSession(roles);
    }
}
