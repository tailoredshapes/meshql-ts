import { Application, Request, Response } from 'express';
import { graphqlHTTP } from 'express-graphql';
import { buildSchema } from 'graphql';
import { Searcher } from '@tailoredshapes/meshql-common';
import Log4js from 'log4js';
import DataLoader from 'dataloader';

const logger = Log4js.getLogger('meshql-ts/graphlette');

function createHealthCheck(repo: Searcher) {
    const health = async (_req: Request, res: Response) => {
        res.status(200).json({ status: 'ok' });
    };

    const ready = async (_req: Request, res: Response) => {
        try {
            const ok = await repo.ready();
            if (ok) {
                res.status(200).json({ status: 'ok' });
            } else {
                res.status(503).json({ status: 'error', message: 'Database not ready' });
            }
        } catch (error) {
            logger.error('Readiness check failed:', error);
            res.status(503).json({ status: 'error', message: 'Database connection failed' });
        }
    };

    return { health, ready };
}

export function init(app: Application, schema: string, path: string, rootValue: Record<string, any>, repo: Searcher): Application {
    const graphqlSchema = buildSchema(schema);
    const { health, ready } = createHealthCheck(repo);

    // Add health check endpoints
    app.get(`${path}/health`, health);
    app.get(`${path}/ready`, ready);

    app.use(
        path,
        graphqlHTTP(() => ({
            schema: graphqlSchema,
            rootValue,
            graphiql: true,
            // Create fresh DataLoader map for each request to prevent cache leaks
            context: {
                dataLoaders: new Map<string, DataLoader<string, Record<string, any>>>(),
            },
            customFormatErrorFn: (error) => ({
                message: error.message,
                locations: error.locations,
                path: error.path,
            }),
        })),
    );

    return app;
}

export { DTOFactory } from './graph/dto.js';
export { context, root } from './graph/root.js';
export { callSubgraph } from './graph/subgraph.js';
