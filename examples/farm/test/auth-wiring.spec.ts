import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import jwt from 'jsonwebtoken';
import { init, Config, Restlette } from '@tailoredshapes/meshql-server';
import { SQLitePlugin, SQLConfig } from '@tailoredshapes/meshql-sqlite_repo';
import { buildRestletteAuthOverrides } from '../auth';

const configDir = path.resolve(__dirname, '../config');
const port = 40520;

const layReportSchema = JSON.parse(fs.readFileSync(path.join(configDir, 'json/lay_report.schema.json'), 'utf8'));
const productivitySchema = JSON.parse(
    fs.readFileSync(path.join(configDir, 'json/hen_productivity.schema.json'), 'utf8'),
);

const storage = (collection: string): SQLConfig => ({ type: 'sqlite', uri: ':memory:', collection });

const workerToken = jwt.sign({ sub: 'farm-worker-service' }, 'unused-in-decode-only-mode');

describe('farm write authorization (in-process, sqlite-backed)', () => {
    let app: any;
    let server: any;
    let layReportId: string;

    beforeAll(async () => {
        const layReport: Restlette = { path: '/lay_report/api', storage: storage('lay_report'), schema: layReportSchema };
        const productivity: Restlette = {
            path: '/hen_productivity/api',
            storage: storage('hen_productivity'),
            schema: productivitySchema,
        };

        const config: Config = { port, graphlettes: [], restlettes: [layReport, productivity] };
        const overrides = await buildRestletteAuthOverrides(configDir);

        app = await init(config, { sqlite: new SQLitePlugin() }, overrides);
        server = app.listen(port);

        const created = await fetch(`http://localhost:${port}/lay_report/api`, {
            method: 'POST',
            body: JSON.stringify({ henId: '11111111-1111-1111-1111-111111111111', eggs: 1, timeOfDay: 'morning' }),
            headers: { 'Content-Type': 'application/json' },
        });
        layReportId = new URL(created.url).pathname.split('/').pop()!;
    });

    afterAll(() => {
        server.close();
    });

    it('anonymous can create a lay_report', async () => {
        const response = await fetch(`http://localhost:${port}/lay_report/api`, {
            method: 'POST',
            body: JSON.stringify({ henId: '22222222-2222-2222-2222-222222222222', eggs: 2, timeOfDay: 'evening' }),
            headers: { 'Content-Type': 'application/json' },
        });

        expect(response.status).toBe(200); // 303 redirect followed to read, which returns 200
    });

    it('anonymous cannot update a lay_report', async () => {
        const response = await fetch(`http://localhost:${port}/lay_report/api/${layReportId}`, {
            method: 'PUT',
            body: JSON.stringify({ henId: '11111111-1111-1111-1111-111111111111', eggs: 3, timeOfDay: 'afternoon' }),
            headers: { 'Content-Type': 'application/json' },
        });

        expect(response.status).toBe(403);
    });

    it('anonymous cannot delete a lay_report', async () => {
        const response = await fetch(`http://localhost:${port}/lay_report/api/${layReportId}`, {
            method: 'DELETE',
        });

        expect(response.status).toBe(403);
    });

    it('anonymous cannot create hen_productivity', async () => {
        const response = await fetch(`http://localhost:${port}/hen_productivity/api`, {
            method: 'POST',
            body: JSON.stringify({
                henId: '11111111-1111-1111-1111-111111111111',
                totalEggs: 1,
                lastLaidAt: '2026-07-22T08:00:00.000Z',
            }),
            headers: { 'Content-Type': 'application/json' },
        });

        expect(response.status).toBe(403);
    });

    it('the worker role can create and update hen_productivity', async () => {
        const createResponse = await fetch(`http://localhost:${port}/hen_productivity/api`, {
            method: 'POST',
            body: JSON.stringify({
                henId: '11111111-1111-1111-1111-111111111111',
                totalEggs: 1,
                lastLaidAt: '2026-07-22T08:00:00.000Z',
            }),
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${workerToken}` },
        });
        expect(createResponse.status).toBe(200);

        const id = new URL(createResponse.url).pathname.split('/').pop()!;

        const updateResponse = await fetch(`http://localhost:${port}/hen_productivity/api/${id}`, {
            method: 'PUT',
            body: JSON.stringify({
                henId: '11111111-1111-1111-1111-111111111111',
                totalEggs: 2,
                lastLaidAt: '2026-07-22T09:00:00.000Z',
            }),
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${workerToken}` },
        });
        expect(updateResponse.status).toBe(200);
    });
});
