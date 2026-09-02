import { Auth, Envelope, Repository } from '@tailoredshapes/meshql-common';
import { SystemSession } from '@tailoredshapes/meshql-auth';
import { init, Plugin, StorageConfig, Config as MeshQLConfig } from '@tailoredshapes/meshql-server';
import { Server } from 'node:http';
import path from 'path';
import { AuthzCaller, AuthzEnv } from './worlds';

/**
 * ---------------------------------------------------------------------------
 * The shared authorization contract
 * ---------------------------------------------------------------------------
 *
 * `features/contract/features/authz.feature` and
 * `features/contract/features/auth_plugin.feature` come from the
 * `meshql-contract` submodule and run unchanged in TypeScript, Java, and Rust.
 * They speak of widgets, kinds, and callers, and they assert what each caller
 * can see -- never what status code a refusal carries, because the status is
 * the server's business and the visibility is the contract's.
 *
 * The environment below is the widget-shaped twin of `AuthzEnv`. It shares the
 * credential machinery -- the same casbin policy, the same unsigned bearer
 * tokens, the same caller-to-credential table -- and differs only in the
 * document it stores and the queries it exposes.
 *
 * ## Why a service per scenario
 *
 * The contract lists all widgets and asserts the result exactly. "All" has to
 * mean all, so a scenario cannot inherit rows another scenario wrote. Each
 * scenario therefore stands up its own service over its own empty collection,
 * which is what the Background step does.
 *
 * ## Why a service can be handed an auth plugin
 *
 * `auth_plugin.feature` runs these same surfaces against plugins no adapter
 * can second-guess: one that refuses every read, one that authorizes on a
 * payload field and stores no tokens at all. Selecting the plugin is the only
 * difference between those scenarios and the token-plugin ones.
 */

export interface WidgetQueries {
    /** Singleton template matching on the envelope id, for example `id = '{{id}}'`. */
    byId: string;
    /** Vector template matching the payload's `kind`, for example `payload->>'kind' = '{{kind}}'`. */
    byKind: string;
}

/** Builds a storage config for the n-th scenario's private collection. */
export type WidgetStorageFactory = (index: number) => StorageConfig;

const WIDGET_GRAPH_SCHEMA = `
scalar Date

type Query {
  getById(id: ID, at: Float): Widget
  getByKind(kind: String, at: Float): [Widget]
}

type Widget {
  id: ID
  name: String
  kind: String
  createdAt: String
}
`;

const WIDGET_JSON_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'kind'],
    properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        kind: { type: 'string' },
    },
};

/** A widget as the contract sees it: a name and a kind, and nothing else. */
export type WidgetView = {
    id?: string | null;
    name?: string | null;
    kind?: string | null;
};

/**
 * One scenario's service: a restlette to write through, a graphlette to read
 * through, and a private collection underneath both.
 */
export class WidgetService {
    static readonly restPath = '/widget/api';
    static readonly graphPath = '/widget/graph';

    readonly conf: MeshQLConfig;
    readonly baseUrl: string;

    private readonly storage: StorageConfig;
    private readonly plugins: Record<string, Plugin>;
    private readonly auth?: Auth;
    private server?: Server;
    private repo?: Repository;

    /** Widget name to envelope id. Names are unique within a scenario. */
    private readonly ids: Record<string, string> = {};

    constructor(
        storage: StorageConfig,
        queries: WidgetQueries,
        port: number,
        plugins: Record<string, Plugin>,
        auth?: Auth,
    ) {
        this.storage = storage;
        this.plugins = plugins;
        this.auth = auth;
        this.baseUrl = `http://localhost:${port}`;

        const casbinDir = path.resolve(__dirname, '..', '..', 'config', 'casbin');

        this.conf = {
            port,
            casbinParams: [path.join(casbinDir, 'model.conf'), path.join(casbinDir, 'policy.csv')],
            graphlettes: [
                {
                    path: WidgetService.graphPath,
                    storage,
                    schema: WIDGET_GRAPH_SCHEMA,
                    rootConfig: {
                        singletons: [{ name: 'getById', query: queries.byId }],
                        vectors: [{ name: 'getByKind', query: queries.byKind }],
                        resolvers: [],
                    },
                },
            ],
            restlettes: [
                {
                    path: WidgetService.restPath,
                    storage,
                    schema: WIDGET_JSON_SCHEMA,
                },
            ],
        };
    }

    async start(): Promise<void> {
        const app = await init(this.conf, this.plugins, this.auth);
        // Resolve only once the socket is accepting, so a bind failure surfaces
        // here instead of as an opaque "fetch failed" three steps later.
        this.server = await new Promise<Server>((resolve, reject) => {
            const server = app.listen(this.conf.port);
            server.once('listening', () => resolve(server));
            server.once('error', reject);
        });
    }

    async stop(): Promise<void> {
        if (!this.server) return;
        const server = this.server;
        this.server = undefined;
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    /**
     * A handle on the storage layer, so the certification can assert what was
     * persisted rather than only what the API chose to show it.
     */
    async repository(): Promise<Repository> {
        if (!this.repo) {
            this.repo = await this.plugins[this.storage.type].createRepository(this.storage);
        }
        return this.repo;
    }

    private headers(caller: AuthzCaller): Record<string, string> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            Accept: 'application/json',
        };
        const token = AuthzEnv.bearerFor(caller);
        if (token) headers.Authorization = `Bearer ${token}`;
        return headers;
    }

    idFor(name: string): string {
        const id = this.ids[name];
        if (!id) throw new Error(`No widget named "${name}" has been created`);
        return id;
    }

    /** Reverse of `idFor`, for turning a list of ids back into widget names. */
    nameFor(id: string): string {
        const match = Object.entries(this.ids).find(([, known]) => known === id);
        if (!match) throw new Error(`No widget was created with id "${id}"`);
        return match[0];
    }

    /** Write through the restlette, exactly as a real client would. */
    async create(caller: AuthzCaller, name: string, kind: string): Promise<string> {
        const response = await fetch(`${this.baseUrl}${WidgetService.restPath}`, {
            method: 'POST',
            headers: this.headers(caller),
            body: JSON.stringify({ name, kind }),
            redirect: 'manual',
        });

        if (response.status !== 303) {
            throw new Error(`Create failed for ${caller}: ${response.status} ${await response.text()}`);
        }

        const location = response.headers.get('location');
        if (!location) throw new Error('Create returned no Location header');

        const id = location.substring(location.lastIndexOf('/') + 1);
        this.ids[name] = id;
        return id;
    }

    /** Delete through the restlette. Reports whether the delete was applied. */
    async remove(caller: AuthzCaller, name: string): Promise<boolean> {
        const response = await fetch(`${this.baseUrl}${WidgetService.restPath}/${this.idFor(name)}`, {
            method: 'DELETE',
            headers: this.headers(caller),
        });
        return response.ok;
    }

    /**
     * List through the restlette, which is the only surface over
     * `Repository.list` -- the one read path that takes no predicate at all.
     */
    async list(caller: AuthzCaller): Promise<string[]> {
        const response = await fetch(`${this.baseUrl}${WidgetService.restPath}`, {
            method: 'GET',
            headers: this.headers(caller),
        });

        if (!response.ok) {
            throw new Error(`List failed for ${caller}: ${response.status} ${await response.text()}`);
        }

        const links: string[] = await response.json();
        return links.map((link) => this.nameFor(link.substring(link.lastIndexOf('/') + 1)));
    }

    /** Read through the graphlette, exactly as a real client would. */
    private async query(caller: AuthzCaller, query: string): Promise<Record<string, any>> {
        const response = await fetch(`${this.baseUrl}${WidgetService.graphPath}`, {
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

    async readById(caller: AuthzCaller, name: string, at?: number): Promise<WidgetView | null> {
        const asOf = at === undefined ? '' : `, at: ${at}`;
        const data = await this.query(caller, `{ getById(id: "${this.idFor(name)}"${asOf}) { id name kind } }`);
        return data.getById ?? null;
    }

    async readByKind(caller: AuthzCaller, kind: string, at?: number): Promise<WidgetView[]> {
        const asOf = at === undefined ? '' : `, at: ${at}`;
        const data = await this.query(caller, `{ getByKind(kind: "${kind}"${asOf}) { id name kind } }`);
        return data.getByKind ?? [];
    }

    /**
     * The envelope as storage holds it, mark and all.
     *
     * Read with the system session: this is the certification reaching past
     * the API to see what was persisted, which is work outside any request,
     * and work outside a request says so explicitly rather than passing
     * nothing.
     */
    async storedEnvelope(name: string): Promise<Envelope | undefined> {
        const repo = await this.repository();
        return repo.read(this.idFor(name), SystemSession);
    }
}

/**
 * Hands out one fresh service per scenario. A plugin's hooks build this once;
 * the Background step calls `start` for every scenario.
 */
export class WidgetHarness {
    private next = 0;

    constructor(
        private readonly storageFor: WidgetStorageFactory,
        private readonly queries: WidgetQueries,
        private readonly plugins: Record<string, Plugin>,
        private readonly basePort: number,
    ) {}

    /**
     * @param auth the auth plugin this scenario runs against. Omitted, the
     *   service's own config picks one, which is the token plugin.
     */
    async start(auth?: Auth): Promise<WidgetService> {
        const index = this.next++;
        const service = new WidgetService(
            this.storageFor(index),
            this.queries,
            this.basePort + index,
            this.plugins,
            auth,
        );
        await service.start();
        return service;
    }
}

export type ContractAuthzWorld = {
    //Please provide
    widgetHarness: WidgetHarness;

    //Per-scenario state
    widgets?: WidgetService;
    singleton?: WidgetView | null;
    result?: string[];
    instants: Record<string, number>;
    deleteApplied?: boolean;
};
