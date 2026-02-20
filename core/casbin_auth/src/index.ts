import { Enforcer, newEnforcer } from 'casbin';
import { Auth } from '@tailoredshapes/meshql-auth';
import { Envelope } from '@tailoredshapes/meshql-common';

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
