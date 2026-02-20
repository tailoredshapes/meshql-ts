import { Database } from './Database.js';
import { Graphlette, Restlette, Config, Singleton, Vector, Resolver } from './types.js';
import * as fs from 'fs';

export class Service {
    private _graphlettes: Graphlette[] = [];
    private _restlettes: Restlette[] = [];
    private envVars: Record<string, string> = {};

    constructor(
        public readonly name: string,
        public readonly port: number
    ) {
        this.envVars = {
            PORT: port.toString(),
            PREFIX: name,
            ENV: 'development'
        };
    }

    /**
     * Add a GraphQL endpoint
     */
    graphql(
        path: string,
        schemaPath: string,
        database: Database,
        collection: string,
        configure?: (builder: GraphQLBuilder) => void
    ): this {
        const builder = new GraphQLBuilder(path, schemaPath, database, collection);
        if (configure) {
            configure(builder);
        }
        this._graphlettes.push(builder.build());
        return this;
    }

    /**
     * Add a REST endpoint
     */
    rest(path: string, schemaPath: string, database: Database, collection: string): this {
        const schema = fs.existsSync(schemaPath)
            ? JSON.parse(fs.readFileSync(schemaPath, 'utf-8'))
            : { type: 'object' };

        this._restlettes.push({
            path,
            storage: database.forCollection(collection),
            schema
        });
        return this;
    }

    /**
     * Set environment variables
     */
    withEnv(key: string, value: string): this {
        this.envVars[key] = value;
        return this;
    }

    /**
     * Get environment variables
     */
    getEnvVars(): Record<string, string> {
        return { ...this.envVars };
    }

    /**
     * Get service URL (for docker network)
     */
    getUrl(): string {
        return `http://${this.name}:${this.port}`;
    }

    /**
     * Generate the Config object (using @tailoredshapes/meshql-server types)
     */
    generateConfig(): Config {
        return {
            port: this.port,
            graphlettes: this._graphlettes,
            restlettes: this._restlettes
        };
    }

    /**
     * Get all endpoints (for testing/validation)
     */
    getEndpoints(): Array<{ type: 'graphql' | 'rest'; path: string }> {
        return [
            ...this._graphlettes.map(g => ({ type: 'graphql' as const, path: g.path })),
            ...this._restlettes.map(r => ({ type: 'rest' as const, path: r.path }))
        ];
    }
}

/**
 * Builder for GraphQL endpoints - constructs a Graphlette
 */
class GraphQLBuilder {
    private singletons: Singleton[] = [];
    private vectors: Vector[] = [];
    private resolvers: Resolver[] = [];

    constructor(
        private path: string,
        private schemaPath: string,
        private database: Database,
        private collection: string
    ) {}

    withSingleton(name: string, query: string, id?: string): this {
        this.singletons.push({ name, query, ...(id && { id }) });
        return this;
    }

    withVector(name: string, query: string, id?: string): this {
        this.vectors.push({ name, query, ...(id && { id }) });
        return this;
    }

    withResolver(name: string, targetService: Service, targetPath: string, queryName: string, id?: string): this {
        this.resolvers.push({
            name,
            queryName,
            url: `http://${targetService.name}:${targetService.port}${targetPath}`,
            ...(id && { id })
        });
        return this;
    }

    build(): Graphlette {
        const schema = fs.existsSync(this.schemaPath)
            ? fs.readFileSync(this.schemaPath, 'utf-8')
            : `# Schema not found: ${this.schemaPath}`;

        return {
            path: this.path,
            storage: this.database.forCollection(this.collection),
            schema,
            rootConfig: {
                ...(this.singletons.length > 0 && { singletons: this.singletons }),
                ...(this.vectors.length > 0 && { vectors: this.vectors }),
                ...(this.resolvers.length > 0 && { resolvers: this.resolvers })
            }
        };
    }
}
