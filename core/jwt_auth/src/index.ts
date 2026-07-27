import { Auth } from '@tailoredshapes/meshql-auth';
import { getLogger } from 'log4js';
import { Envelope } from '@tailoredshapes/meshql-common';
import { Request } from 'express';

let logger = getLogger('meshql-ts/jwtauth');

/**
 * Reads the `sub` claim out of a bearer token **without verifying its
 * signature**, deliberately. See CLAUDE.md, "JWT Token Handling".
 *
 * The gateway authenticates; meshql authorizes. By the time a request arrives
 * the signature has already been checked by whatever terminates OIDC in front
 * of this service, and re-checking it here would be a second verification —
 * and, with a JWKS-backed issuer, a second network call — for an answer we
 * already hold. Signing secrets stay at the gateway, which is the point.
 *
 * **There is no JWT library in this file, and that is the design.** Verifying
 * is the only part of JWT handling that needs one, and this does not verify.
 * Previously `jsonwebtoken` sat here doing nothing but `decode`, which meant
 * every scanner and every reviewer saw an imported verifier that was never
 * called and reported a missing signature check — forever. Removing it removes
 * the accusation rather than answering it each time.
 *
 * It also removes a real dependency problem: `jsonwebtoken` reaches
 * `buffer-equal-constant-time`, which uses the long-removed `SlowBuffer` and
 * throws on load under current Node. This path was dead on anything newer than
 * Node 20.
 *
 * If a deployment ever needs genuine verification — no trusted gateway, tokens
 * arriving straight from clients — that is a real feature, and this is the seam
 * for it: a sibling `verifiedSubjectOf(token, key)` selected by config. It
 * would need `jose` or equivalent, an algorithm **pinned in config** rather
 * than read from the token's own `alg` header, `exp`/`aud`/`iss` checks, and it
 * must refuse to start on an unreadable key rather than quietly falling back to
 * this function. Silent fallback is how a deployment comes to believe it
 * verifies when it does not.
 *
 * Total by construction: anything malformed yields `undefined`, never a throw.
 * The previous implementation indexed the result of `jwt.decode()`, which is
 * `null` for a malformed token — so a garbage bearer token raised a TypeError
 * out of an async handler and became a 500 where a 401 was meant. That was the
 * "missing null check" CLAUDE.md already flagged as the legitimate issue here.
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

export class JWTSubAuthorizer implements Auth {
    async getAuthToken(context: Request): Promise<string[]> {
        const authHeader = context.headers?.authorization;

        if (authHeader === null || authHeader === undefined) {
            return [];
        }

        if (!authHeader.startsWith('Bearer ')) {
            logger.error('Missing Bearer Token');
            return [];
        }

        const subject = subjectOf(authHeader.substring(7));

        if (subject === undefined) {
            // No credentials rather than an error. A caller with none reaches
            // exactly the public records and no more, which is the right
            // outcome for a token we cannot read — and matches the "no
            // credentials is permitted" invariant the authz certification pins.
            logger.error('Bearer token carried no usable sub claim');
            return [];
        }

        return [subject];
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
