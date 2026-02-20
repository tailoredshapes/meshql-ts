import { Envelope } from '@tailoredshapes/meshql-common';

export interface Auth {
    getAuthToken(context: Record<string, any>): Promise<string[]>;
    isAuthorized(credentials: string[], data: Envelope): Promise<boolean>;
}

export class NoOp implements Auth {
    async getAuthToken(): Promise<string[]> {
        return ['TOKEN'];
    }

    async isAuthorized(): Promise<boolean> {
        return true;
    }
}

export type ReadSecurer<T> = (creds: any, query: any) => Promise<T>;
