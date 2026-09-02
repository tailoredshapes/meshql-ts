import { DTOFactory } from './dto.js';
import HandleBars from 'handlebars';
import { Auth, RootConfig, Searcher, Session } from '@tailoredshapes/meshql-common';

import Log4js from 'log4js';

const logger = Log4js.getLogger('meshql-ts/graphlette/root');

export function context(repo: Searcher, authorizer: Auth, config: RootConfig) {
    let dtoF = new DTOFactory(config.resolvers);
    let rt = root(repo, dtoF, authorizer, config);

    return {
        dtoFactory: dtoF,
        root: rt,
    };
}

export function root(repo: Searcher, dtoFactory: DTOFactory, authorizer: Auth, { singletons, vectors }: RootConfig) {
    let base: Record<string, any> = {};

    if (singletons !== undefined) {
        for (const s of singletons) {
            base[s.name] = singleton(repo, dtoFactory, authorizer, s.query, s.name);
        }
    }

    if (vectors !== undefined) {
        for (const s of vectors) {
            base[s.name] = vector(repo, dtoFactory, authorizer, s.query, s.name);
        }
    }

    return base;
}

const getTimestamp = (args: Record<string, any>): number => {
    let atArg = 'at';
    let at;
    if (Object.hasOwnProperty.call(args, atArg)) {
        at = args['at'];
    } else {
        at = Date.now();
    }

    return at;
};

function vector(repo: Searcher, dtoFactory: DTOFactory, authorizer: Auth, queryTemplate: string, name: string) {
    let qt = HandleBars.compile(queryTemplate);
    return async (args: any, context: any): Promise<Record<string, any>[]> => {
        // The session is resolved from the request and handed to the searcher,
        // which asks it about each envelope it found. The resolver never sees
        // a credential and never decides anything itself.
        let session: Session = await authorizer.authenticate(context);
        let timestamp = getTimestamp(args);
        let results: Record<string, any>[] = await repo.findAll(qt, args, session, timestamp);

        let filledResult = dtoFactory.fillMany(results, timestamp);
        logger.trace(`${name} Results ${JSON.stringify(filledResult)} for ${queryTemplate}, ${JSON.stringify(args)}`);
        return filledResult;
    };
}

function singleton(repo: Searcher, dtoFactory: DTOFactory, authorizer: Auth, queryTemplate: string, name: string) {
    let qt = HandleBars.compile(queryTemplate);
    return async (args: any, context: any): Promise<Record<string, any>> => {
        let session: Session = await authorizer.authenticate(context);
        let timestamp = getTimestamp(args);
        let payload = await repo.find(qt, args, session, timestamp);

        logger.trace(`${name} DB Result ${JSON.stringify(payload)} for ${queryTemplate}, ${JSON.stringify(args)}`);

        let filled = dtoFactory.fillOne(payload, timestamp);

        logger.trace(`${name} Result ${JSON.stringify(filled)} for ${queryTemplate}, ${JSON.stringify(args)}`);
        return filled;
    };
}
