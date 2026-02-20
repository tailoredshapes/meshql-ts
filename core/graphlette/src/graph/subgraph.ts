import Log4js from 'log4js';

import {
    DocumentNode,
    FieldNode,
    GraphQLSchema,
    parse,
    print,
    SelectionSetNode,
    TypeInfo,
    visit,
    visitWithTypeInfo,
} from 'graphql';

let logger = Log4js.getLogger('meshql-ts/subgraph');

type HeadersType = {
    'Content-Type': string;
    Accept: string;
    Authorization?: string;
};

async function callSibling(query: string, url: URL, authHeader: string | null) {
    const body: string = JSON.stringify({ query: query }, null, 2);

    logger.trace('Subgraph Call: ', url.pathname, JSON.stringify(query, null, 2));

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
        logger.error(err);
    });
    return response;
}

async function processResponse(response: Response | void, queryName: string) {
    if (response instanceof Response) {
        const text: string = await response.text();
        let json;
        try {
            json = JSON.parse(text);
        } catch (err) {
            logger.error(`This isn't json: ${text}`);
            logger.error(`Error parsing json from response: ${err}`);
            json = { errors: [{ message: text }] };
        }

        if (Object.hasOwnProperty.call(json, 'errors')) {
            logger.error(json);
            throw new Error(json['errors'][0]['message']);
        }
        return json['data'][queryName];
    }
    return {};
}

export const callSubgraph = async (
    url: URL,
    query: string,
    queryName: string,
    authHeader: string | null,
): Promise<Record<string, any>> => {
    let response = await callSibling(query, url, authHeader);
    return await processResponse(response, queryName);
};

export const processSelectionSet = (selectionSet: SelectionSetNode): string => {
    return selectionSet.selections
        .filter((n): n is FieldNode => n.kind === 'Field')
        .reduce((previousValue: string, field: FieldNode) => previousValue + processFieldNode(field), '');
};

export const processFieldNode = (field: FieldNode): string => {
    if (field.selectionSet !== undefined) {
        return `${field.name.value} {
                ${processSelectionSet(field.selectionSet)}
            }\n`;
    } else {
        return field.name.value + '\n';
    }
};

export const addTimestampToQuery = (
    query: string,
    schema: GraphQLSchema,
    queryName: string,
    timestamp: number,
): string => {
    let ast: DocumentNode = parse(query);
    const typeInfo: TypeInfo = new TypeInfo(schema);
    ast = visit(
        ast,
        visitWithTypeInfo(typeInfo, {
            Field(node) {
                if (node.name.value === queryName) {
                    if (!node.arguments?.some((arg) => arg.name.value === 'at')) {
                        return {
                            ...node,
                            arguments: node.arguments
                                ? [
                                      ...node.arguments,
                                      {
                                          kind: 'Argument',
                                          name: { kind: 'Name', value: 'at' },
                                          value: { kind: 'IntValue', value: timestamp.toString() },
                                      },
                                  ]
                                : [
                                      {
                                          kind: 'Argument',
                                          name: { kind: 'Name', value: 'at' },
                                          value: { kind: 'IntValue', value: timestamp.toString() },
                                      },
                                  ],
                        };
                    }
                }
            },
        }),
    );

    return print(ast);
};

export const processContext = (id: any, context: any, queryName: string, timestamp: number): string => {
    if (context.fieldNodes.length > 0) {
        const firstNode: FieldNode = context.fieldNodes[0];
        if (firstNode.selectionSet !== undefined) {
            const selectionSet: SelectionSetNode = firstNode.selectionSet;
            const sss: string = processSelectionSet(selectionSet);
            let query: string = `{${queryName}(id: "${id}"){
                ${sss} 
               }}`;
            return addTimestampToQuery(query, context.schema, queryName, timestamp);
        }
    }
    throw Error('Context is malformed');
};
