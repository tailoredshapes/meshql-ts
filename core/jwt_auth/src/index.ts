import { Auth, Envelope, Operation, Session } from '@tailoredshapes/meshql-common';
import { getLogger } from 'log4js';

let logger = getLogger('meshql-ts/jwtauth');

/** A caller holding this sees every record, whatever its mark. */
export const WILDCARD = '*';

/**
 * Reads the `sub` claim out of a bearer token **without verifying its
 * signature**, deliberately. See CLAUDE.md, "JWT Token Handling".
 *
 * The gateway authenticates; meshql authorizes. By the time a request arrives
 * the signature has already been checked by whatever terminates OIDC in front
 * of this service, and re-checking it here would be a second verification --
 * and, with a JWKS-backed issuer, a second network call -- for an answer we
 * already hold. Signing secrets stay at the gateway, which is the point.
 *
 * **There is no JWT library in this file, and that is the design.** Verifying
 * is the only part of JWT handling that needs one, and this does not verify.
 * Previously `jsonwebtoken` sat here doing nothing but `decode`, which meant
 * every scanner and every reviewer saw an imported verifier that was never
 * called and reported a missing signature check -- forever. Removing it removes
 * the accusation rather than answering it each time.
 *
 * It also removes a real dependency problem: `jsonwebtoken` reaches
 * `buffer-equal-constant-time`, which uses the long-removed `SlowBuffer` and
 * throws on load under current Node. This path was dead on anything newer than
 * Node 20.
 *
 * If a deployment ever needs genuine verification -- no trusted gateway, tokens
 * arriving straight from clients -- that is a real feature, and this is the seam
 * for it: a sibling `verifiedSubjectOf(token, key)` selected by config. It
 * would need `jose` or equivalent, an algorithm **pinned in config** rather
 * than read from the token's own `alg` header, `exp`/`aud`/`iss` checks, and it
 * must refuse to start on an unreadable key rather than quietly falling back to
 * this function. Silent fallback is how a deployment comes to believe it
 * verifies when it does not.
 *
 * Total by construction: anything malformed yields `undefined`, never a throw.
 */
export function subjectOf(token: string): string | undefined {
    const payload = token.split('.')[1];
    if (!payload) return undefined;
    try {
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        return typeof claims?.sub === 'string' && claims.sub.length > 0 ? claims.sub : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The caller's credentials, lifted from the request context's bearer token.
 *
 * No credentials rather than an error for anything unreadable. A caller with
 * none reaches exactly the public records and no more, which is the right
 * outcome for a token we cannot read -- and matches the "no credentials is
 * permitted" invariant the authz certification pins.
 */
export function credentialsOf(context: Record<string, any>): string[] {
    const authHeader = context?.headers?.authorization;

    if (authHeader === null || authHeader === undefined) {
        return [];
    }

    if (!authHeader.startsWith('Bearer ')) {
        logger.error('Missing Bearer Token');
        return [];
    }

    const subject = subjectOf(authHeader.substring(7));

    if (subject === undefined) {
        logger.error('Bearer token carried no usable sub claim');
        return [];
    }

    return [subject];
}

/** Whatever a token session stamped, read back defensively. */
function marksOf(auth: unknown): string[] {
    return Array.isArray(auth) ? auth.filter((t): t is string => typeof t === 'string') : [];
}

/**
 * The token plugin's session, and the only place in meshql where the token
 * rules live.
 *
 * All three of them used to be spread through framework code, where every
 * lette and every adapter could -- and did -- reinterpret them:
 *
 *   - a caller holding the wildcard sees everything;
 *   - a record with an empty mark is public;
 *   - a write is marked with the caller's own credentials.
 *
 * They are rules about tokens, so they belong to the plugin that invented
 * tokens. Nothing outside this file knows that a mark is a list of strings.
 */
export class TokenSession implements Session {
    private readonly credentials: string[];

    constructor(credentials: string[]) {
        this.credentials = credentials;
    }

    /** Copying the caller's credentials onto the envelope: the write-path rule. */
    async stamp(envelope: Envelope): Promise<Envelope> {
        return { ...envelope, auth: [...this.credentials] };
    }

    async isAuthorized(_operation: Operation, envelope: Envelope): Promise<boolean> {
        // The wildcard rule.
        if (this.credentials.includes(WILDCARD)) return true;

        const marks = marksOf(envelope.auth);

        // The empty-mark-means-public rule.
        if (marks.length === 0) return true;

        return marks.some((token) => this.credentials.includes(token));
    }
}

/** Resolves a caller to the single credential in their bearer token's `sub`. */
export class JWTSubAuthorizer implements Auth {
    async authenticate(context: Record<string, any>): Promise<Session> {
        return new TokenSession(credentialsOf(context));
    }
}
