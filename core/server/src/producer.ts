import { Auth, Envelope, Operation, Session } from '@tailoredshapes/meshql-common';
import { credentialsOf } from '@tailoredshapes/meshql-jwt_auth';

/**
 * Closes writes to everyone but a projection's worker(s).
 *
 * A decoration of whichever auth plugin the deployment runs, not a second
 * plugin: reads, and the mark a write is stamped with, are the plugin's
 * unchanged. Only a write (`create`, `remove`) is further conditioned on who
 * is calling, and "who" is the bearer's `sub` -- the identity, not the
 * credentials the plugin resolves it to, so a front end may be given the right
 * to *read* what the worker marks without gaining the right to write it.
 *
 * This is the one place the server decides a write on its own. It is about
 * the entity (a projection has exactly one writer), where the plugin's
 * questions are about the record.
 */
export function producedBy(auth: Auth, producers: string[]): Auth {
    return {
        async authenticate(context: Record<string, any>): Promise<Session> {
            const session = await auth.authenticate(context);
            const isProducer = credentialsOf(context).some((sub) => producers.includes(sub));
            return {
                stamp: (envelope: Envelope) => session.stamp(envelope),
                isAuthorized: async (operation: Operation, envelope: Envelope) =>
                    (operation === 'read' || isProducer) && (await session.isAuthorized(operation, envelope)),
            };
        },
    };
}
