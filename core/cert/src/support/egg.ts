import { NoAuth } from '@tailoredshapes/meshql-auth';
import { init, Plugin, StorageConfig } from '@tailoredshapes/meshql-server';
import { Server } from 'node:http';
import net from 'node:net';
import { unverifiedToken } from './tokens';
import { eggConfig, EggDialect } from './egg_model';

export { EggDialect } from './egg_model';

/**
 * The harness for `egg_economy.feature`: a deployment of the fourteen entities
 * (egg_model.ts) per scenario, and, around it, the two things the feature says
 * are not meshql's business and are not under test -- a CDC and a worker.
 *
 *   restlette (lay_report) => CDC => worker => restlette (hen_productivity)
 *
 * meshql itself neither starts nor knows about either. The CDC here is the
 * quickest thing that carries committed events to a consumer without caring
 * which store holds them: a poller of the event restlette's own listing, which
 * hands each id it has not delivered yet to the worker. A deployment would put
 * Debezium and Kafka, a connector, or a trigger and a queue table there. The
 * worker is a reference hen worker: it folds a hen's lay reports into its
 * `hen_productivity`, as a function of the events, so a redelivery changes
 * nothing. It reads and writes through the HTTP surfaces with its own
 * credentials, which is all a worker is entitled to.
 */

/** The front end's identity, and the worker's. A projection accepts only the latter. */
export const FRONT_END = 'front_end';
export const HEN_WORKER = 'hen_worker';

export type EggStorageFactory = (entity: string, scenario: number) => StorageConfig;

/** How long "eventually" waits, in milliseconds: `EGG_TIMEOUT_MS`, else 10 seconds. */
export const eventually = (): number => Number(process.env.EGG_TIMEOUT_MS ?? 10_000);

async function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, () => {
            const { port } = probe.address() as net.AddressInfo;
            probe.close(() => resolve(port));
        });
    });
}

export type Reply = { status: number; body: any; location?: string };

export class EggEconomy {
    baseUrl = '';
    private server?: Server;
    private bridge?: HenWorkerBridge;

    constructor(
        private readonly storageFor: (entity: string) => StorageConfig,
        private readonly dialect: EggDialect,
        private readonly plugins: Record<string, Plugin>,
    ) {}

    async start(): Promise<void> {
        // The graphlettes reach one another by URL, so the port is chosen first.
        const port = await freePort();
        this.baseUrl = `http://localhost:${port}`;
        const conf = eggConfig(port, this.baseUrl, this.storageFor, this.dialect);
        // No authorization plugin: this feature is about the surfaces, and the
        // authorization contract is certified by its own features.
        const app = await init(conf, this.plugins, new NoAuth());
        this.server = await new Promise<Server>((resolve, reject) => {
            const server = app.listen(port);
            server.once('listening', () => resolve(server));
            server.once('error', reject);
        });
        this.bridge = new HenWorkerBridge(this);
        this.bridge.start();
    }

    async stop(): Promise<void> {
        await this.bridge?.stop();
        this.bridge = undefined;
        const server = this.server;
        this.server = undefined;
        if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    /** A request as `as` (a `sub`) would make it. A redirect is an answer, not followed. */
    async call(as: string, method: string, path: string, body?: unknown): Promise<Reply> {
        const response = await fetch(`${this.baseUrl}${path}`, {
            method,
            redirect: 'manual',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                Authorization: `Bearer ${unverifiedToken(as)}`,
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await response.text();
        let parsed: any = text;
        try {
            parsed = text === '' ? undefined : JSON.parse(text);
        } catch {
            /* not JSON: the text will do */
        }
        const location = response.headers.get('location') ?? undefined;
        return { status: response.status, body: parsed, location };
    }

    /** Create a document; the id is the last segment of where it was created. */
    async create(as: string, entity: string, doc: Record<string, unknown>): Promise<Reply & { id?: string }> {
        const reply = await this.call(as, 'POST', `/${entity}/api`, doc);
        return { ...reply, id: reply.location?.split('/').pop() };
    }

    async graph(as: string, entity: string, query: string): Promise<{ data?: any; errors?: any[] }> {
        const reply = await this.call(as, 'POST', `/${entity}/graph`, { query });
        return reply.body;
    }

    /** Every document of an entity, as the front end can read it. */
    async all(as: string, entity: string): Promise<Record<string, any>[]> {
        const list = await this.call(as, 'GET', `/${entity}/api`);
        const urls: string[] = Array.isArray(list.body) ? list.body : [];
        const docs = await Promise.all(urls.map((url) => this.call(as, 'GET', url)));
        return docs.map((d) => d.body);
    }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What "good" means to the reference worker's `quality_rate`. */
const GOOD = new Set(['grade_a', 'double_yolk']);

/**
 * The CDC and the reference hen worker, for the harness only. Delivery is at
 * least once: an event whose processing failed is delivered again.
 */
class HenWorkerBridge {
    private running = false;
    private loop?: Promise<void>;
    private readonly delivered = new Set<string>();

    constructor(private readonly economy: EggEconomy) {}

    start(): void {
        this.running = true;
        this.loop = this.run();
    }

    async stop(): Promise<void> {
        this.running = false;
        await this.loop;
    }

    private async run(): Promise<void> {
        while (this.running) {
            try {
                // The CDC: what has been committed, and not yet carried.
                const list = await this.economy.call(HEN_WORKER, 'GET', '/lay_report/api');
                const urls: string[] = Array.isArray(list.body) ? list.body : [];
                for (const url of urls) {
                    const id = url.split('/').pop()!;
                    if (this.delivered.has(id) || !this.running) continue;
                    await this.work(id);
                    this.delivered.add(id);
                }
            } catch {
                /* the next poll delivers it again */
            }
            await sleep(25);
        }
    }

    /** The worker: recompute the hen's projection from all of the hen's lay reports. */
    private async work(eventId: string): Promise<void> {
        const e = this.economy;
        const event = await e.call(HEN_WORKER, 'GET', `/lay_report/api/${eventId}`);
        const henId: string = event.body.hen_id;

        const state = await e.graph(
            HEN_WORKER,
            'hen',
            `{ getById(id: "${henId}") { lay_reports { eggs quality } coop { farm_id } } }`,
        );
        const hen = state.data?.getById;
        if (!hen?.coop?.farm_id) throw new Error(`no hen ${henId} (yet)`);

        const reports: { eggs: number; quality?: string }[] = hen.lay_reports ?? [];
        const total = reports.reduce((n, r) => n + r.eggs, 0);
        const good = reports.filter((r) => !r.quality || GOOD.has(r.quality)).reduce((n, r) => n + r.eggs, 0);
        const projection = {
            hen_id: henId,
            farm_id: hen.coop.farm_id,
            total_eggs: total,
            quality_rate: total === 0 ? 0 : good / total,
        };

        const known = await e.graph(
            HEN_WORKER,
            'hen_productivity',
            `{ getByHen(id: "${henId}") { id total_eggs quality_rate } }`,
        );
        const current = known.data?.getByHen;
        let reply: Reply;
        if (!current?.id) {
            reply = await e.call(HEN_WORKER, 'POST', '/hen_productivity/api', projection);
        } else if (current.total_eggs === projection.total_eggs && current.quality_rate === projection.quality_rate) {
            return; // already what the events say
        } else {
            reply = await e.call(HEN_WORKER, 'PUT', `/hen_productivity/api/${current.id}`, projection);
        }
        if (reply.status !== 303) throw new Error(`the worker's write answered ${reply.status}`);
    }
}

/**
 * Hands out one fresh economy per scenario, over tables of its own: "the hen
 * has produced 5 eggs" and "Emerdale" must mean this scenario's and nobody's
 * else. A plugin's hooks build this once.
 */
export class EggHarness {
    private next = 0;

    constructor(
        private readonly storageFor: EggStorageFactory,
        private readonly dialect: EggDialect,
        private readonly plugins: Record<string, Plugin>,
    ) {}

    async start(): Promise<EggEconomy> {
        const scenario = this.next++;
        const economy = new EggEconomy((entity) => this.storageFor(entity, scenario), this.dialect, this.plugins);
        await economy.start();
        return economy;
    }
}

export type EggWorld = {
    //Please provide
    eggs: EggHarness;

    //Per-scenario state
    economy?: EggEconomy;
    egg: {
        ids: Record<string, string>;
        lastPost?: Reply;
        lastLayReportId?: string;
        response?: { data?: any; errors?: any[] };
    };
    instants: Record<string, number>;
};
