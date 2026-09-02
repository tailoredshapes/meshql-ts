import { Auth, Envelope, Session } from '@tailoredshapes/meshql-common';

/**
 * The auth contract itself lives in `meshql-common`, because `Repository` and
 * `Searcher` name it and storage adapters must not import a package whose job
 * is authorization. It is re-exported here so that "the auth surface" still
 * has one obvious home.
 */
export type { Auth, Operation, Session } from '@tailoredshapes/meshql-common';

/**
 * The session for work that happens outside a request: a worker, a migration,
 * the certification reaching past the API to assert what was persisted.
 *
 * It is explicit on purpose. There is no unset session anywhere in meshql --
 * "no session means allow" is the bypass this design exists to remove -- so
 * code with no caller says so, in one word, at the call site.
 *
 * It stamps nothing, because a system write carries no identity to mark with.
 */
export const SystemSession: Session = {
    async stamp(envelope: Envelope): Promise<Envelope> {
        return envelope;
    },
    async isAuthorized(): Promise<boolean> {
        return true;
    },
};

/**
 * The plugin for a deployment that does no authorization.
 *
 * It says `true`, which is what a plugin named No Auth should say. It used to
 * hand out a fixed token and then let the framework's token arithmetic decide,
 * which meant "no auth" quietly meant "the token rule, with one token".
 */
export class NoAuth implements Auth {
    async authenticate(): Promise<Session> {
        return SystemSession;
    }
}
