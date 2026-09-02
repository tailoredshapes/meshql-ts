import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express, { Application } from 'express';
import { NoAuth, SystemSession } from '@tailoredshapes/meshql-auth';
import { Auth, Envelope, Repository, Session, Validator } from '@tailoredshapes/meshql-common';
import { InMemory } from '../../common/test/memory_repo';
import { init, Crud } from '../src';

/**
 * The version surface, over HTTP.
 *
 * `versions.feature` certifies the same surface against every real adapter;
 * these cases pin the parts a Gherkin scenario cannot say out loud -- the exact
 * body shape, and the difference between a version that is absent and one that
 * is refused.
 */

const henSchema = {
    type: 'object',
    properties: {
        name: { type: 'string' },
        eggs: { type: 'integer' },
    },
};

const permitAll: Validator = async () => true;

type VersionEntry = {
    url?: string;
    created_at: string;
    deleted: boolean;
    unauthorized?: boolean;
};

describe('Version listings', () => {
    let app: Application;
    let server: any;
    let hen: Envelope;

    const port = 40600;
    const context = '/hens';

    beforeAll(async () => {
        const repo: Repository = new InMemory();
        // Seeding storage happens outside any request, so it says so.
        hen = await repo.create({ payload: { name: 'chuck', eggs: 6 } }, SystemSession);
        await repo.create({ id: hen.id, payload: { name: 'chuck', eggs: 9 } }, SystemSession);
        await repo.remove(hen.id!, SystemSession);

        app = express();
        app.use(express.json());
        init(app, new Crud(new NoAuth(), repo, permitAll, context), context, port, henSchema);
        server = app.listen(port);
    });

    afterAll(() => server.close());

    async function versions(): Promise<{ id: string; versions: VersionEntry[] }> {
        const response = await fetch(`http://localhost:${port}${context}/${hen.id}/versions`);
        expect(response.status).toBe(200);
        return response.json();
    }

    it('names the document it belongs to', async () => {
        expect((await versions()).id).toBe(hen.id);
    });

    it('reports every write, oldest first, with the deletion last', async () => {
        const { versions: list } = await versions();

        expect(list.length).toBe(3);
        expect(list.map((entry) => entry.deleted)).toEqual([false, false, true]);
        expect([...list].sort((a, b) => a.created_at.localeCompare(b.created_at))).toEqual(list);
    });

    it('addresses each version with a path, not a URL of its own devising', async () => {
        for (const entry of (await versions()).versions) {
            expect(entry.url).toMatch(new RegExp(`^${context}/${hen.id}/versions/[0-9a-f]{64}$`));
        }
    });

    it('resolves a version URL to that version, not to the latest', async () => {
        const [first] = (await versions()).versions;
        const response = await fetch(`http://localhost:${port}${first.url}`);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ name: 'chuck', eggs: 6 });
        expect(response.headers.get('X-Meshql-Deleted')).toBe('false');
    });

    it('hands out the same address every time', async () => {
        const first = (await versions()).versions.map((entry) => entry.url);
        const second = (await versions()).versions.map((entry) => entry.url);
        expect(first).toEqual(second);
    });

    it('does not find an unknown token', async () => {
        const response = await fetch(`http://localhost:${port}${context}/${hen.id}/versions/nosuchversion`);
        expect(response.status).toBe(404);
    });

    it('has no versions for a document that was never written', async () => {
        const response = await fetch(`http://localhost:${port}${context}/no-such-hen/versions`);
        expect(response.status).toBe(200);
        expect((await response.json()).versions).toEqual([]);
    });
});

describe('A version the caller may not read', () => {
    let app: Application;
    let server: any;
    let hen: Envelope;

    const port = 40700;
    const context = '/hens';

    beforeAll(async () => {
        // A plugin whose whole rule is "the credential must be the string
        // `token`". The restlette cannot second-guess it: all it can do is ask.
        const auth: Auth = {
            async authenticate(requestContext: Record<string, any>): Promise<Session> {
                const credential = requestContext.headers?.authorization;
                return {
                    async stamp(envelope) {
                        return envelope;
                    },
                    async isAuthorized() {
                        return credential === 'token';
                    },
                };
            },
        };

        const repo: Repository = new InMemory();
        hen = await repo.create({ payload: { name: 'chuck', eggs: 6 } }, SystemSession);

        app = express();
        app.use(express.json());
        init(app, new Crud(auth, repo, permitAll, context), context, port, henSchema);
        server = app.listen(port);
    });

    afterAll(() => server.close());

    it('is still listed, saying when it happened and nothing else', async () => {
        const response = await fetch(`http://localhost:${port}${context}/${hen.id}/versions`);
        const { versions } = await response.json();

        expect(versions.length).toBe(1);
        // Absent, not null: the entry says it exists and refuses to address it.
        expect('url' in versions[0]).toBe(false);
        expect(versions[0].unauthorized).toBe(true);
        expect(versions[0].created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(versions[0].deleted).toBe(false);
    });

    /**
     * Refused, not absent. The listing already told the caller this version
     * exists, and answering "no such version" would contradict it.
     */
    it('is refused rather than reported missing', async () => {
        const listed = await fetch(`http://localhost:${port}${context}/${hen.id}/versions`, {
            headers: { Authorization: 'token' },
        });
        const { versions } = await listed.json();

        const refused = await fetch(`http://localhost:${port}${versions[0].url}`);
        expect(refused.status).toBe(403);

        const permitted = await fetch(`http://localhost:${port}${versions[0].url}`, {
            headers: { Authorization: 'token' },
        });
        expect(permitted.status).toBe(200);
        expect(await permitted.json()).toEqual({ name: 'chuck', eggs: 6 });
    });
});
