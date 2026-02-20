import express, { RequestHandler, Router } from 'express';
import swaggerUi, { JsonObject } from 'swagger-ui-express';
import { Crud } from './crud.js';
import { paths } from './swagger';
import { Repository, getLogger } from '@tailoredshapes/meshql-common';

const logger = getLogger('meshql-ts/restlette');

const swaggerOptions = (apiPath: string, port: number, schema: Record<string, any>, host: string = 'localhost') => ({
    openapi: '3.0.0',
    info: {
        version: '0.1.0',
        title: `${apiPath} API`,
        description: `API for mutating ${apiPath}`,
    },
    servers: [
        {
            url: `http://${host}:${port}`,
        },
    ],
    components: {
        securitySchemes: {
            BearerAuth: {
                type: 'http',
                scheme: 'bearer',
                bearerFormat: 'JWT',
            },
        },
        schemas: {
            State: schema,
            OperationStatus: {
                type: 'object',
                properties: {
                    id: {
                        type: 'string',
                    },
                    status: {
                        type: 'string',
                    },
                    error: {
                        type: 'string',
                    },
                },
            },
        },
    },
    paths: paths(apiPath),
});

export function init(
    app: express.Application,
    crud: Crud,
    apiPath: string,
    port: number,
    jsonSchema: Record<string, any>,
): express.Application {
    logger.info(`API Docs are available at: http://localhost:${port}${apiPath}/api-docs/swagger.json`);

    const swaggerDoc: JsonObject = swaggerOptions(apiPath, port, jsonSchema);
    logger.debug("Swagger documentation generated", { swaggerDoc });
    const router = createRestletteRouter(apiPath, crud);

    app.use(apiPath, router);

    // Add error handling for swagger.json
    app.get(`${apiPath}/api-docs/swagger.json`, (req: express.Request, res: express.Response) => {
        try {
            logger.debug('Serving swagger.json', { swaggerDoc });
            res.json(swaggerDoc);
        } catch (error) {
            logger.error('Error serving swagger.json:', error);
            res.status(500).json({ error: 'Failed to serve swagger documentation' });
        }
    });

    // Add error handling for Swagger UI
    app.use(`${apiPath}/api-docs`, (req: express.Request, res: express.Response, next: express.NextFunction) => {
        logger.debug('Swagger UI request:', { path: req.path });
        next();
    }, swaggerUi.serve);

    let handler: RequestHandler = swaggerUi.setup(swaggerDoc, {
        explorer: true,
        customCss: '.swagger-ui .topbar { display: none }',
        swaggerOptions: {
            persistAuthorization: true,
        }
    });

    app.use(`${apiPath}/api-docs`, handler);

    return app;
}

function createHealthCheck(repo: Repository) {
    const health = async (_req: express.Request, res: express.Response) => {
        res.status(200).json({ status: 'ok' });
    };

    const ready = async (_req: express.Request, res: express.Response) => {
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

function createRestletteRouter(apiPath: string, crud: Crud): Router {
    const router = Router();
    const { health, ready } = createHealthCheck(crud['_repo']);

    router.get('/health', health);
    router.get('/ready', ready);
    router.post('/bulk', crud.bulk_create);
    router.get('/bulk', crud.bulk_read);
    router.post('/', crud.create);
    router.get('/', crud.list);
    router.get('/:id', crud.read);
    router.put('/:id', crud.update);
    router.delete('/:id', crud.remove);

    return router;
}

export { JSONSchemaValidator } from './validation';
export { Crud } from './crud';
export { createHealthCheck };
