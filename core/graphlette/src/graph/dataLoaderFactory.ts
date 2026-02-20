import DataLoader from 'dataloader';
import Log4js from 'log4js';
import { processSelectionSet, addTimestampToQuery } from './subgraph.js';
import { FieldNode, GraphQLSchema } from 'graphql';

let logger = Log4js.getLogger('meshql-ts/dataLoaderFactory');

type HeadersType = {
    'Content-Type': string;
    Accept: string;
    Authorization?: string;
};

// GraphQL execution context type (runtime structure)
type GraphQLExecutionContext = {
    fieldNodes?: FieldNode[];
    schema: GraphQLSchema;
};

/**
 * Creates a batch loading function for a specific GraphQL endpoint and query.
 * Uses GraphQL aliases to batch multiple single-ID queries into one HTTP request.
 *
 * @param url - The GraphQL endpoint URL
 * @param queryName - The query name (e.g., "getById")
 * @param context - GraphQL execution context containing field selection info
 * @param timestamp - Timestamp for temporal queries
 * @param authHeader - Authorization header to forward
 * @returns Batch function for DataLoader
 */
const createBatchLoadFn = (
    url: URL,
    queryName: string,
    context: GraphQLExecutionContext,
    timestamp: number,
    authHeader: string | null,
) => {
    return async (ids: readonly string[]): Promise<Array<Record<string, any> | Error>> => {
        if (ids.length === 0) {
            return [];
        }

        logger.debug(`Batching ${ids.length} queries for ${queryName} at ${url}`);

        // Extract the selection set from the context
        const firstNode: FieldNode | undefined = context.fieldNodes?.[0];
        if (!firstNode?.selectionSet) {
            return ids.map(() => new Error('Context is malformed - no selection set'));
        }

        const selectionSetString = processSelectionSet(firstNode.selectionSet);

        // Build a single query with aliases for each ID
        // Example: { item_0: getById(id: "123") { ... }, item_1: getById(id: "456") { ... } }
        const aliasedQueries = ids
            .map((id, index) => {
                return `item_${index}: ${queryName}(id: "${id}") {
                    ${selectionSetString}
                }`;
            })
            .join('\n');

        let query = `{ ${aliasedQueries} }`;

        // Add timestamp if needed
        query = addTimestampToQuery(query, context.schema, queryName, timestamp);

        // Make the HTTP request
        const body = JSON.stringify({ query }, null, 2);
        logger.trace('Batched Subgraph Call:', url.pathname, query);

        let headers: HeadersType = {
            'Content-Type': 'application/json',
            Accept: 'application/json',
        };

        if (authHeader !== null) {
            headers.Authorization = authHeader;
        }

        let response: Response | void = await fetch(url.toString(), {
            method: 'POST',
            headers,
            body,
        }).catch((err) => {
            logger.error('Batch fetch error:', err);
            return undefined;
        });

        if (!response) {
            return ids.map(() => new Error('Failed to fetch from subgraph'));
        }

        const text = await response.text();
        let json;
        try {
            json = JSON.parse(text);
        } catch (err) {
            logger.error(`Failed to parse JSON: ${text}`);
            return ids.map(() => new Error('Invalid JSON response from subgraph'));
        }

        if (json.errors) {
            logger.error('GraphQL errors:', json.errors);
            const error = new Error(json.errors[0]?.message || 'GraphQL query failed');
            return ids.map(() => error);
        }

        // Extract results in the same order as input IDs
        const results: Array<Record<string, any> | Error> = ids.map((id, index) => {
            const aliasKey = `item_${index}`;
            const result = json.data?.[aliasKey];

            if (result === null || result === undefined) {
                // Not found is not an error, return empty object
                return {};
            }

            return result;
        });

        return results;
    };
};

/**
 * Creates a DataLoader for batching subgraph calls.
 * The DataLoader is specific to a particular endpoint, query, and request context.
 *
 * @param url - The GraphQL endpoint URL
 * @param queryName - The query name (e.g., "getById", "getByFarm")
 * @param context - GraphQL execution context
 * @param timestamp - Timestamp for temporal queries
 * @param authHeader - Authorization header to forward
 * @returns DataLoader instance
 */
export const createSubgraphDataLoader = (
    url: URL,
    queryName: string,
    context: GraphQLExecutionContext,
    timestamp: number,
    authHeader: string | null,
): DataLoader<string, Record<string, any>> => {
    const batchLoadFn = createBatchLoadFn(url, queryName, context, timestamp, authHeader);

    return new DataLoader<string, Record<string, any>>(batchLoadFn, {
        // Batch multiple loads within the same tick
        batch: true,
        // Don't cache across requests (context is request-scoped)
        cache: true,
        // Maximum batch size (optional, can tune for performance)
        maxBatchSize: 100,
    });
};
