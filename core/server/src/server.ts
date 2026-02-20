import express, { Application } from 'express';
import { DTOFactory, root, init as graph_init } from '@tailoredshapes/meshql-graphlette';
import { init as rest_init } from '@tailoredshapes/meshql-restlette';
import { Config, Graphlette, Restlette, StorageConfig } from './configTypes';
import { Repository, Searcher, Validator, getLogger } from '@tailoredshapes/meshql-common';
import { Crud } from '@tailoredshapes/meshql-restlette';
import { JSONSchemaValidator } from '@tailoredshapes/meshql-restlette';
import { JWTSubAuthorizer } from '@tailoredshapes/meshql-jwt_auth';
import { Auth } from '@tailoredshapes/meshql-auth';
import { CasbinAuth } from '@tailoredshapes/meshql-casbin_auth';
import cors from 'cors';
import { Plugin } from './plugin';
import { checkAllServicesHealth, checkAllServicesReady } from './health';

const logger = getLogger('meshql-ts/server');

async function processGraphlette(
    graphlette: Graphlette,
    auth: Auth,
    app: Application,
    plugins: Record<string, Plugin>,
) {
    const { schema, storage, path, rootConfig } = graphlette;

    const dtoFactory = new DTOFactory(rootConfig.resolvers);
    let searcher: Searcher;

    if (plugins[storage.type]) {
        searcher = await plugins[storage.type].createSearcher(storage, dtoFactory, auth);
    } else {
        throw new Error(`Plugin for ${storage.type} not found`);
    }

    const rt = root(searcher, dtoFactory, auth, rootConfig);
    graph_init(app, schema, path, rt, searcher);
}

async function buildRepository(storage: StorageConfig, plugins: Record<string, Plugin>): Promise<Repository> {
    if (plugins[storage.type]) {
        return plugins[storage.type].createRepository(storage);
    } else {
        throw new Error(`Plugin for ${storage.type} not found`);
    }
}

async function processRestlette(
    restlette: Restlette,
    auth: Auth,
    app: Application,
    port: number,
    plugins: Record<string, Plugin>,
) {
    const validator: Validator = JSONSchemaValidator(restlette.schema);
    const repo: Repository = await buildRepository(restlette.storage, plugins);
    const crud = new Crud(auth, repo, validator, restlette.path, restlette.tokens);
    rest_init(app, crud, restlette.path, port, restlette.schema);
}

async function processAuth(config: Config): Promise<Auth> {
    const jwtSubAuthorizer: Auth = new JWTSubAuthorizer();
    if (config.casbinParams) {
        return CasbinAuth.create(config.casbinParams, jwtSubAuthorizer);
    } else {
        return jwtSubAuthorizer;
    }
}

export async function init(config: Config, plugins: Record<string, Plugin>): Promise<Application> {
    const auth: Auth = await processAuth(config);

    const app: Application = express();
    app.use(express.json());

    // Use CORS middleware
    app.use(
        cors({
            origin: '*', // Allow all origins. Adjust as needed for security.
            methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization'],
        }),
    );

    // Add health check endpoint
    app.get('/health', async (req, res) => {
        const status = await checkAllServicesHealth(config);
        res.json(status);
    });

    // Add ready check endpoint
    app.get('/ready', async (req, res) => {
        const status = await checkAllServicesReady(config);
        res.status(status.status === 'ok' ? 200 : 503).json(status);
    });

    // Process graphlettes
    for (const graphlette of config.graphlettes) {
        await processGraphlette(graphlette, auth, app, plugins);
    }

    // Process restlettes
    for (const restlette of config.restlettes) {
        await processRestlette(restlette, auth, app, config.port, plugins);
    }

    return app;
}

export async function cleanServer(plugins: Record<string, Plugin>) {
    logger.info('Cleaning server');
    for (const plugin of Object.values(plugins)) {
        await plugin.cleanup();
    }
}
