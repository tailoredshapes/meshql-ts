import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { init } from '../src/server';
import { Config, Restlette } from '../src/configTypes';
import { SQLitePlugin, SQLConfig } from '@tailoredshapes/meshql-sqlite_repo';
import { Auth } from '@tailoredshapes/meshql-auth';

const allowAll: Auth = {
    async getAuthToken() {
        return ['anyone'];
    },
    async isAuthorized() {
        return true;
    },
    async authorizeAction() {
        return true;
    },
};

const denyAll: Auth = {
    async getAuthToken() {
        return ['anyone'];
    },
    async isAuthorized() {
        return true;
    },
    async authorizeAction() {
        return false;
    },
};

describe('per-restlette Auth override', () => {
    let app: any;
    let server: any;
    const port = 40510;

    const schema = { type: 'object', additionalProperties: false, required: ['name'], properties: { id: { type: 'string' }, name: { type: 'string' } } };

    const storage = (collection: string): SQLConfig => ({ type: 'sqlite', uri: ':memory:', collection });

    beforeAll(async () => {
        const open: Restlette = { path: '/open/api', storage: storage('open'), schema };
        const locked: Restlette = { path: '/locked/api', storage: storage('locked'), schema };

        const config: Config = { port, graphlettes: [], restlettes: [open, locked] };

        app = await init(config, { sqlite: new SQLitePlugin() }, { '/locked/api': denyAll });
        server = app.listen(port);
    });

    afterAll(() => {
        server.close();
    });

    it('uses the default auth for restlettes with no override', async () => {
        const response = await fetch(`http://localhost:${port}/open/api`, {
            method: 'POST',
            body: JSON.stringify({ name: 'ok' }),
            headers: { 'Content-Type': 'application/json' },
        });

        expect(response.status).toBe(200);
    });

    it('uses the overridden auth for the restlette named in restletteAuthOverrides', async () => {
        const response = await fetch(`http://localhost:${port}/locked/api`, {
            method: 'POST',
            body: JSON.stringify({ name: 'blocked' }),
            headers: { 'Content-Type': 'application/json' },
        });

        expect(response.status).toBe(403);
    });
});
