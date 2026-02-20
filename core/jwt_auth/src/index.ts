import { Auth } from '@tailoredshapes/meshql-auth';
import { getLogger } from 'log4js';
const jwt = require('jsonwebtoken');
import { Envelope } from '@tailoredshapes/meshql-common';
import { Request } from 'express';

let logger = getLogger('meshql-ts/jwtauth');

export class JWTSubAuthorizer implements Auth {
    async getAuthToken(context: Request): Promise<string[]> {
        const authHeader = context.headers?.authorization;

        if (authHeader === null || authHeader === undefined) {
            return [];
        }

        if (authHeader.startsWith('Bearer ')) {
            const token = authHeader.substring(7, authHeader.length);

            const dToken: { sub: string } = jwt.decode(token);

            return [dToken['sub']];
        } else {
            logger.error('Missing Bearer Token');
            return [];
        }
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
