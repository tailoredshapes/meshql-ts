import { World } from '@cucumber/cucumber';
import { Repository, Envelope, Searcher } from '@tailoredshapes/meshql-common';
import { TemplateDelegate } from 'handlebars';
import { init, Plugin, StorageConfig, Config as MeshQLConfig } from '@tailoredshapes/meshql-server';
import { Server } from 'node:http';
import path from 'path';
import { unverifiedToken } from './tokens';

export type SearcherTestTemplates = {
    findById: TemplateDelegate<{ id: string }>;
    findByName: TemplateDelegate<{ name: string }>;
    findAllByType: TemplateDelegate<{ type: string }>;
    findByNameAndType: TemplateDelegate<{ name: string; type: string }>;
};

export class IntegrationWorld extends World {
    //required from repository
    config?: StorageConfig;
    plugin?: Plugin;
    templates?: SearcherTestTemplates;

    //Used by steps
    repository?: Repository;
    searcher?: Searcher;
    envelopes?: Map<string, Envelope>;
    timestamps?: Map<string, number>;
    testStartTime?: number;
    searchResult?: any;
    searchResults?: any[];
    removeResult?: boolean;
    removeResults?: Record<string, boolean>;
}

/**
 * ---------------------------------------------------------------------------
 * Authorization certification
 * ---------------------------------------------------------------------------
 *
 * The farm certification proves the wiring works. It cannot prove the wiring
 * is *safe*, because it drives every request as a single caller. Against one
 * caller a working authorization filter and a completely inert one look
 * identical.
 *
 * This environment stands up the same real HTTP surfaces — writes through the
 * restlette, reads through the graphlette — but with several distinct callers
 * whose credentials do NOT overlap:
 *
 *   alice   -> ["tenant_a"]
 *   bob     -> ["tenant_b"]
 *   root    -> ["tenant_a", "tenant_b"]   (entitled to everything)
 *   nobody  -> []                          (writes public records)
 *   <none>  -> []                          (anonymous; permitted, by design)
 *
 * The credential sets come from `@tailoredshapes/meshql-casbin_auth`: the JWT
 * `sub` is mapped to roles by the casbin policy in `config/casbin`. Casbin is
 * the only mechanism in this codebase that can give one caller more than one
 * credential, which is what a "sees everything" caller requires.
 */
export interface AuthzQueries {
    /** Singleton template matching on the envelope id, e.g. `id = '{{id}}'` */
    byId: string;
    /** Vector template matching on the payload's `name`, e.g. `payload->>'name' = '{{name}}'` */
    byName: string;
}

export type AuthzCaller = 'alice' | 'bob' | 'root' | 'nobody' | 'anonymous';

const AUTHZ_GRAPH_SCHEMA = `
scalar Date

type Query {
  getById(id: ID, at: Float): Hen
  getByName(name: String, at: Float): [Hen]
}

type Hen {
  id: ID
  name: String
  eggs: Int
  createdAt: String
}
`;

const AUTHZ_JSON_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['name'],
    properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        eggs: { type: 'integer', minimum: 0, maximum: 10 },
    },
};

export type AuthzCreated = {
    caller: AuthzCaller;
    name: string;
    id: string;
};

export class AuthzEnv {
    readonly conf: MeshQLConfig;
    readonly port: number;
    readonly baseUrl: string;
    readonly storage: StorageConfig;

    static readonly restPath = '/authz/api';
    static readonly graphPath = '/authz/graph';

    /** JWT `sub` claims per caller. `anonymous` deliberately sends no header. */
    static readonly subjects: Record<Exclude<AuthzCaller, 'anonymous'>, string> = {
        alice: 'alice',
        bob: 'bob',
        root: 'root',
        nobody: 'nobody',
    };

    /** The credentials each caller's JWT resolves to, per the casbin policy. */
    static readonly credentials: Record<AuthzCaller, string[]> = {
        alice: ['tenant_a'],
        bob: ['tenant_b'],
        root: ['tenant_a', 'tenant_b'],
        nobody: [],
        anonymous: [],
    };

    private plugins: Record<string, Plugin> = {};
    private repo?: Repository;

    /** `${caller}/${name}` -> envelope id, so two callers can share a name. */
    ids: Record<string, string> = {};

    constructor(storage: StorageConfig, queries: AuthzQueries, port: number) {
        this.storage = storage;
        this.port = port;
        this.baseUrl = `http://localhost:${port}`;

        const casbinDir = path.resolve(__dirname, '..', '..', 'config', 'casbin');

        this.conf = {
            port,
            casbinParams: [path.join(casbinDir, 'model.conf'), path.join(casbinDir, 'policy.csv')],
            graphlettes: [
                {
                    path: AuthzEnv.graphPath,
                    storage,
                    schema: AUTHZ_GRAPH_SCHEMA,
                    rootConfig: {
                        singletons: [{ name: 'getById', query: queries.byId }],
                        vectors: [{ name: 'getByName', query: queries.byName }],
                        resolvers: [],
                    },
                },
            ],
            restlettes: [
                {
                    path: AuthzEnv.restPath,
                    storage,
                    schema: AUTHZ_JSON_SCHEMA,
                },
            ],
        };
    }

    async buildService(plugins: Record<string, Plugin>): Promise<Server> {
        this.plugins = plugins;
        const app = await init(this.conf, plugins);
        // Resolve only once the socket is actually accepting, so a bind
        // failure surfaces here instead of as an opaque "fetch failed".
        return await new Promise<Server>((resolve, reject) => {
            const server = app.listen(this.port);
            server.once('listening', () => resolve(server));
            server.once('error', reject);
        });
    }

    /**
     * A handle on the storage layer, so the certification can assert what was
     * actually persisted rather than only what the API chose to show it.
     */
    async repository(): Promise<Repository> {
        if (!this.repo) {
            this.repo = await this.plugins[this.storage.type].createRepository(this.storage);
        }
        return this.repo;
    }

    /**
     * A JWT for a caller. Unsigned-in-practice: `JWTSubAuthorizer` decodes
     * without verifying because signature validation belongs at the gateway.
     *
     * Static, because the contract certification mints tokens for the same
     * callers against a different service and both need one source for the
     * caller-to-subject mapping.
     */
    static bearerFor(caller: AuthzCaller): string | undefined {
        if (caller === 'anonymous') return undefined;
        const sub = AuthzEnv.subjects[caller];
        if (!sub) throw new Error(`Unknown caller "${caller}"`);
        return unverifiedToken(sub);
    }

    tokenFor(caller: AuthzCaller): string | undefined {
        return AuthzEnv.bearerFor(caller);
    }

    private headers(caller: AuthzCaller): Record<string, string> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            Accept: 'application/json',
        };
        const token = this.tokenFor(caller);
        if (token) headers.Authorization = `Bearer ${token}`;
        return headers;
    }

    /** Write through the restlette, exactly as a real client would. */
    async create(caller: AuthzCaller, payload: Record<string, any>): Promise<AuthzCreated> {
        const response = await fetch(`${this.baseUrl}${AuthzEnv.restPath}`, {
            method: 'POST',
            headers: this.headers(caller),
            body: JSON.stringify(payload),
            redirect: 'manual',
        });

        if (response.status !== 303) {
            throw new Error(`Create failed for ${caller}: ${response.status} ${await response.text()}`);
        }

        const location = response.headers.get('location');
        if (!location) throw new Error('Create returned no Location header');

        const id = location.substring(location.lastIndexOf('/') + 1);
        const created = { caller, name: payload.name, id };
        this.ids[`${caller}/${payload.name}`] = id;
        return created;
    }

    idFor(caller: AuthzCaller, name: string): string {
        const id = this.ids[`${caller}/${name}`];
        if (!id) throw new Error(`No record created by "${caller}" named "${name}"`);
        return id;
    }

    async readRest(caller: AuthzCaller, id: string): Promise<number> {
        const response = await fetch(`${this.baseUrl}${AuthzEnv.restPath}/${id}`, {
            method: 'GET',
            headers: this.headers(caller),
        });
        return response.status;
    }

    async removeRest(caller: AuthzCaller, id: string): Promise<number> {
        const response = await fetch(`${this.baseUrl}${AuthzEnv.restPath}/${id}`, {
            method: 'DELETE',
            headers: this.headers(caller),
        });
        return response.status;
    }

    /** Read through the graphlette, exactly as a real client would. */
    async query(caller: AuthzCaller, query: string): Promise<Record<string, any>> {
        const response = await fetch(`${this.baseUrl}${AuthzEnv.graphPath}`, {
            method: 'POST',
            headers: this.headers(caller),
            body: JSON.stringify({ query }),
        });

        const json = await response.json();
        if (json.errors) {
            throw new Error(`GraphQL error: ${JSON.stringify(json.errors)}`);
        }
        return json.data;
    }
}

export type AuthzTestWorld = {
    //Please provide
    authz: AuthzEnv;

    //Per-scenario state
    lastCreated?: AuthzCreated;
    lastQueryName?: string;
    singletonResult?: Record<string, any> | null;
    vectorResult?: Record<string, any>[];
    storedEnvelope?: Envelope;
    responseStatus?: number;
    capturedTime?: number;
};
