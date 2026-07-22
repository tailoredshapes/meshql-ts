import { describe, it, expect } from 'vitest';
import express from 'express';
import { mountManifestRoute } from '../manifest';

describe('mountManifestRoute', () => {
    it('serves the given JSON string at GET /manifest', async () => {
        const app = express();
        const manifestJson = JSON.stringify({ meshql: 1, entities: {}, surfaces: {} });
        mountManifestRoute(app, manifestJson);

        const server = app.listen(0);
        await new Promise<void>((resolve) => server.once('listening', resolve));
        const port = (server.address() as { port: number }).port;

        try {
            const response = await fetch(`http://localhost:${port}/manifest`);
            const body = await response.text();

            expect(response.status).toBe(200);
            expect(body).toBe(manifestJson);
        } finally {
            server.close();
        }
    });
});
