import { Envelope } from '@tailoredshapes/meshql-common';

export type Action = 'create' | 'update' | 'delete';

export interface Auth {
    getAuthToken(context: Record<string, any>): Promise<string[]>;
    isAuthorized(credentials: string[], data: Envelope): Promise<boolean>;
    /**
     * Verb-aware authorization check. Distinct from isAuthorized (envelope-
     * token ABAC, no verb concept): this lets an Auth implementation grant
     * or deny a specific create/update/delete independent of any per-record
     * authorized_tokens. NoOp and JWTSubAuthorizer have no policy engine of
     * their own; CasbinAuth is the implementation that actually varies its
     * answer by resource+action (see core/casbin_auth).
     */
    authorizeAction(credentials: string[], action: Action, data: Envelope): Promise<boolean>;
}

export class NoOp implements Auth {
    async getAuthToken(): Promise<string[]> {
        return ['TOKEN'];
    }

    async isAuthorized(): Promise<boolean> {
        return true;
    }

    async authorizeAction(): Promise<boolean> {
        return true;
    }
}

export type ReadSecurer<T> = (creds: any, query: any) => Promise<T>;
