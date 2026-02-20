import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { Searcher } from '@tailoredshapes/meshql-common';
import { init } from '../src/index';

describe('Health Check Endpoints', () => {
    let app: express.Application;
    let mockRepo: Searcher;
    let server: any;
    const port = 40501;
    const path = '/graphql';

    beforeEach(() => {
        app = express();
        mockRepo = {
            find: vi.fn(),
            findAll: vi.fn(),
            ready: vi.fn(),
        } as unknown as Searcher;

        const schema = `
            type Query {
                hello: String
            }
        `;
        const rootValue = {
            hello: () => 'Hello World!',
        };

        init(app, schema, path, rootValue, mockRepo);
        server = app.listen(port);
    });

    afterEach(() => {
        server.close();
    });

    describe('GET /graphql/health', () => {
        it('should return 200 OK with status ok', async () => {
            const response = await fetch(`http://localhost:${port}${path}/health`);

            expect(response.status).toBe(200);
            const body = await response.json();
            expect(body).toEqual({ status: 'ok' });
        });
    });

    describe('GET /graphql/ready', () => {
        it('should return 200 OK when database is connected', async () => {
            vi.mocked(mockRepo.ready).mockResolvedValueOnce(true);

            const response = await fetch(`http://localhost:${port}${path}/ready`);

            expect(response.status).toBe(200);
            const body = await response.json();
            expect(body).toEqual({ status: 'ok' });
            expect(mockRepo.ready).toHaveBeenCalledTimes(1);
        });

        it('should return 503 when database is not ready', async () => {
            vi.mocked(mockRepo.ready).mockResolvedValueOnce(false);

            const response = await fetch(`http://localhost:${port}${path}/ready`);

            expect(response.status).toBe(503);
            const body = await response.json();
            expect(body).toEqual({
                status: 'error',
                message: 'Database not ready'
            });
            expect(mockRepo.ready).toHaveBeenCalledTimes(1);
        });

        it('should return 503 when database connection fails', async () => {
            vi.mocked(mockRepo.ready).mockRejectedValueOnce(new Error('Database connection failed'));

            const response = await fetch(`http://localhost:${port}${path}/ready`);

            expect(response.status).toBe(503);
            const body = await response.json();
            expect(body).toEqual({
                status: 'error',
                message: 'Database connection failed'
            });
            expect(mockRepo.ready).toHaveBeenCalledTimes(1);
        });
    });
}); 