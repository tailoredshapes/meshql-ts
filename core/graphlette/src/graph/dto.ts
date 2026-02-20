import { processContext, callSubgraph } from './subgraph.js';
import Log4js from 'log4js';
import { GraphQLArgs } from 'graphql/graphql';
import { Resolver } from '@tailoredshapes/meshql-common';
import { createSubgraphDataLoader } from './dataLoaderFactory.js';
import DataLoader from 'dataloader';

let logger = Log4js.getLogger('gridql/DTOFactory');

// Extend GraphQL context to include DataLoader map
export interface GraphQLContextWithDataLoaders extends GraphQLArgs {
    dataLoaders?: Map<string, DataLoader<string, Record<string, any>>>;
}

export class DTOFactory {
    resolvers: { [key: string]: any } = {};

    constructor(config?: Resolver[]) {
        if (config !== undefined) {
            for (const c of config) {
                try {
                    let url: URL = new URL(c.url);
                    this.resolvers[c.name] = assignResolver(c.id, c.queryName, url);
                } catch (e) {
                    logger.error(`Invalid URL: ${c.url}`);
                    throw `Invalid URL: ${c.url}`;
                }
            }
        }
    }

    fillOne(data: Record<string, any>, timestamp: number): Record<string, any> {
        let copy: { [key: string]: any } = { _timestamp: timestamp };

        for (const f in this.resolvers) {
            if (typeof this.resolvers[f] === 'function') {
                copy[f] = this.resolvers[f];
            }
        }

        assignProperties(copy, data);
        return copy;
    }

    fillMany(data: Record<string, any>, timestamp: number): Record<string, any>[] {
        return data.map((d: Record<string, any>) => this.fillOne(d, timestamp));
    }
}

const assignProperties = (target: { [key: string]: any }, source: { [key: string]: any }): void => {
    Object.keys(source).forEach((key): void => {
        target[key] = source[key];
    });
};

const assignResolver = (id: string = 'id', queryName: string, url: URL): Record<string, any> => {
    logger.debug(`Assigning resolver for: ${id}, ${queryName}, ${url}`);
    return async function (
        this: { [key: string]: any },
        args: any,
        contextValue: any,
        info: any,
    ): Promise<Record<string, any>> {
        let self = this as { [key: string]: any };
        let foreignKey: any = self[id];

        // Try to extract auth header from request (args might be IncomingMessage in some cases)
        let header = args && args.headers && args.headers.authorization ? args.headers.authorization : null;

        // Use DataLoader for batching if available in contextValue
        if (contextValue && contextValue.dataLoaders) {
            const dataLoaderKey = `${url.toString()}:${queryName}`;
            let dataLoader = contextValue.dataLoaders.get(dataLoaderKey);

            // Create DataLoader if it doesn't exist for this (url, queryName) combination
            if (!dataLoader) {
                logger.debug(`Creating DataLoader for ${dataLoaderKey}`);
                dataLoader = createSubgraphDataLoader(url, queryName, info, self._timestamp, header);
                contextValue.dataLoaders.set(dataLoaderKey, dataLoader);
            }

            // Use DataLoader to batch the request
            return await dataLoader.load(foreignKey);
        }

        // Fallback to direct call if DataLoader not available (backward compatibility)
        logger.debug('DataLoader not available, falling back to direct callSubgraph');
        const query: string = processContext(foreignKey, info, queryName, self._timestamp);
        return await callSubgraph(url, query, queryName, header);
    };
};
