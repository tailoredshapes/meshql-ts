import { Auth, Envelope, Operation, Session } from '@tailoredshapes/meshql-common';
import { subjectOf } from '@tailoredshapes/meshql-jwt_auth';

/**
 * ---------------------------------------------------------------------------
 * The plugins with teeth
 * ---------------------------------------------------------------------------
 *
 * `features/contract/features/authz.feature` certifies the *default* plugin,
 * which marks records with tokens. Against a token plugin, a storage adapter
 * that reimplements the token rule correctly and one that delegates return
 * exactly the same rows -- so nothing in that suite detects an adapter
 * answering for itself.
 *
 * These two answer in ways no adapter can guess.
 */

/** The caller's name, as the certification's unsigned bearer tokens carry it. */
function callerOf(context: Record<string, any>): string | undefined {
    const header = context?.headers?.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined;
    return subjectOf(header.substring(7));
}

/**
 * Refuses every read, on every surface, whatever the record says.
 *
 * Writes go through normally and are marked with the caller, so the records
 * really are there -- an adapter that returns them has decided for itself that
 * a caller whose token matches may read, which is the defect this plugin
 * exists to catch. Today an adapter that ignored the plugin entirely would
 * pass its certification; against this one it cannot.
 */
class RefuseReadsSession implements Session {
    private readonly credentials: string[];

    constructor(credentials: string[]) {
        this.credentials = credentials;
    }

    async stamp(envelope: Envelope): Promise<Envelope> {
        return { ...envelope, auth: [...this.credentials] };
    }

    async isAuthorized(operation: Operation): Promise<boolean> {
        return operation !== 'read';
    }
}

export class RefuseReadsAuth implements Auth {
    async authenticate(context: Record<string, any>): Promise<Session> {
        const caller = callerOf(context);
        return new RefuseReadsSession(caller ? [caller] : []);
    }
}

/**
 * Authorizes on a payload field and holds no tokens at all.
 *
 * This is the join case in miniature: the mark on the envelope stays empty,
 * and the answer comes from the record's own `owner`. It proves the framework
 * never assumes the token shape.
 *
 * `stamp` writes the owner into the payload rather than into `auth`, because
 * the contract's write step supplies a name and a kind and nothing else -- the
 * plugin is the only thing in the request that knows who is asking. The
 * envelope's mark is left untouched, which is what the scenario's "should
 * carry no tokens" asserts.
 */
class OwnerSession implements Session {
    private readonly caller: string | undefined;

    constructor(caller: string | undefined) {
        this.caller = caller;
    }

    async stamp(envelope: Envelope): Promise<Envelope> {
        return { ...envelope, payload: { ...envelope.payload, owner: this.caller ?? null } };
    }

    async isAuthorized(operation: Operation, envelope: Envelope): Promise<boolean> {
        if (operation === 'create') return true;
        return this.caller !== undefined && envelope.payload?.owner === this.caller;
    }
}

export class OwnerAuth implements Auth {
    async authenticate(context: Record<string, any>): Promise<Session> {
        return new OwnerSession(callerOf(context));
    }
}

/** The plugins `auth_plugin.feature` names, by the names it uses. */
export const CERT_AUTH_PLUGINS: Record<string, () => Auth> = {
    'refuse-reads': () => new RefuseReadsAuth(),
    owner: () => new OwnerAuth(),
};
