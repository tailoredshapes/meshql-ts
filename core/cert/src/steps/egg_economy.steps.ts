import { After, Given, Then, When } from '@cucumber/cucumber';
import assert from 'assert';
import { EggEconomy, EggWorld, eventually, FRONT_END } from '../support/egg';

/**
 * Bindings for `features/contract/features/proposed/egg-economy/egg_economy.feature`.
 * Everything here is a client of the HTTP surfaces: the front end writes
 * through the restlettes and reads through the graphlettes, as a browser would.
 * The CDC and the worker that run behind them are the harness's (support/egg.ts)
 * and are never asserted on directly, only through what they leave in the
 * projection.
 */

function economy(world: EggWorld): EggEconomy {
    assert.ok(world.economy, 'the Background step must stand up an egg economy first');
    return world.economy!;
}

/** Polled until true, or the harness's timeout. */
async function eventuallyTrue(what: () => string, ok: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + eventually();
    for (;;) {
        if (await ok()) return;
        if (Date.now() > deadline) assert.fail(`never became true: ${what()}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

const idOf = (world: EggWorld, key: string): string => {
    const id = world.egg.ids[key];
    assert.ok(id, `nothing named ${key} was made`);
    return id;
};

// Creating a table per entity per scenario is slow on a real database server.
Given('an egg economy deployment is running', { timeout: 120_000 }, async function (this: EggWorld) {
    assert.ok(this.eggs, 'plugin hooks must set `this.eggs` to an EggHarness');
    this.economy = await this.eggs.start();
    this.egg = { ids: {} };
    this.instants = {};
});

After(async function (this: EggWorld) {
    if (this.economy) {
        await this.economy.stop();
        this.economy = undefined;
    }
});

async function made(world: EggWorld, entity: string, key: string, doc: Record<string, unknown>): Promise<string> {
    const reply = await economy(world).create(FRONT_END, entity, doc);
    assert.strictEqual(reply.status, 303, `POST ${entity} answered ${reply.status}: ${JSON.stringify(reply.body)}`);
    assert.ok(reply.id, `POST ${entity} named no new document`);
    world.egg.ids[`${entity}:${key}`] = reply.id!;
    return reply.id!;
}

Given(
    'a farm {string} with a coop {string} and a hen {string}',
    async function (this: EggWorld, farm: string, coop: string, hen: string) {
        const farmId = await made(this, 'farm', farm, { name: farm, farm_type: 'family', zone: 'north' });
        const coopId = await made(this, 'coop', coop, {
            name: coop,
            farm_id: farmId,
            capacity: 10,
            coop_type: 'barn',
        });
        await made(this, 'hen', hen, { name: hen, coop_id: coopId, breed: 'leghorn' });
        this.egg.ids[`farm-of:${hen}`] = farmId;
        this.egg.ids[`coop-of:${hen}`] = coopId;
    },
);

When(
    'the hen {string} lays {int} eggs of quality {string} at {string}',
    async function (this: EggWorld, hen: string, eggs: number, quality: string, timestamp: string) {
        const reply = await economy(this).create(FRONT_END, 'lay_report', {
            hen_id: idOf(this, `hen:${hen}`),
            coop_id: idOf(this, `coop-of:${hen}`),
            farm_id: idOf(this, `farm-of:${hen}`),
            eggs,
            quality,
            timestamp,
        });
        this.egg.lastPost = reply;
        this.egg.lastLayReportId = reply.id;
    },
);

When('the front end writes a hen_productivity of {int} total eggs', async function (this: EggWorld, total: number) {
    // Any hen will do: the write is refused because of who writes, not what.
    const henKey = Object.keys(this.egg.ids).find((k) => k.startsWith('hen:'))!;
    this.egg.lastPost = await economy(this).create(FRONT_END, 'hen_productivity', {
        hen_id: idOf(this, henKey),
        farm_id: idOf(this, `farm-of:${henKey.slice('hen:'.length)}`),
        total_eggs: total,
        quality_rate: 1,
    });
});

// This implementation answers a create with 303 See Other and the new
// document's address; the feature's "201" is the same fact, accepted, spelled
// by a server that answers differently. A refusal is neither.
Then('the posting was accepted', function (this: EggWorld) {
    const status = this.egg.lastPost?.status;
    assert.ok(status === 201 || status === 303, `the last POST answered ${status}`);
});

const layReportPath = (world: EggWorld): string => {
    assert.ok(world.egg.lastLayReportId, 'no lay report was laid');
    return `/lay_report/api/${world.egg.lastLayReportId}`;
};

Then('a lay report of the hen {string} can be read by its id', async function (this: EggWorld, hen: string) {
    const reply = await economy(this).call(FRONT_END, 'GET', layReportPath(this));
    assert.strictEqual(reply.status, 200);
    assert.strictEqual(reply.body.hen_id, idOf(this, `hen:${hen}`));
});

// Refused is asserted twice over: by the status, and by the report being what
// it was. A server that answered 405 and changed it anyway would not pass.
async function unchanged(world: EggWorld, before: unknown): Promise<void> {
    const reply = await economy(world).call(FRONT_END, 'GET', layReportPath(world));
    assert.strictEqual(reply.status, 200, 'the lay report is gone');
    assert.deepStrictEqual(reply.body, before, 'the lay report changed');
}

Then('replacing that lay report is refused', async function (this: EggWorld) {
    const current = (await economy(this).call(FRONT_END, 'GET', layReportPath(this))).body;
    const reply = await economy(this).call(FRONT_END, 'PUT', layReportPath(this), { ...current, eggs: 99 });
    assert.strictEqual(reply.status, 405, `a PUT answered ${reply.status}`);
    await unchanged(this, current);
});

Then('deleting that lay report is refused', async function (this: EggWorld) {
    const before = (await economy(this).call(FRONT_END, 'GET', layReportPath(this))).body;
    const reply = await economy(this).call(FRONT_END, 'DELETE', layReportPath(this));
    assert.strictEqual(reply.status, 405, `a DELETE answered ${reply.status}`);
    await unchanged(this, before);
});

// Cucumber's own step timeout (5 s) must not undercut the harness's.
Then(
    'the hen {string} has produced {int} eggs eventually',
    { timeout: eventually() + 5_000 },
    async function (this: EggWorld, hen: string, eggs: number) {
        const id = idOf(this, `hen:${hen}`);
        let seen: unknown;
        await eventuallyTrue(
            () => `hen ${hen} produced ${eggs} (last seen ${JSON.stringify(seen)})`,
            async () => {
                const result = await economy(this).graph(
                    FRONT_END,
                    'hen',
                    `{ getById(id: "${id}") { productivity { total_eggs } } }`,
                );
                seen = result.data?.getById?.productivity;
                return result.data?.getById?.productivity?.total_eggs === eggs;
            },
        );
    },
);

Then('no hen_productivity of {int} total eggs exists', async function (this: EggWorld, total: number) {
    const all = await economy(this).all(FRONT_END, 'hen_productivity');
    const found = all.filter((p) => p.total_eggs === total);
    assert.strictEqual(found.length, 0, `a front end wrote a projection: ${JSON.stringify(found)}`);
});

/** Puts the captured instant into the first query field as `at`. */
function withAt(query: string, at: number): string {
    const open = query.indexOf('(');
    assert.ok(open >= 0, `no argument list to put an instant in: ${query}`);
    return `${query.slice(0, open + 1)}at: ${at}, ${query.slice(open + 1)}`;
}

async function ask(world: EggWorld, entity: string, query: string): Promise<void> {
    world.egg.response = await economy(world).graph(FRONT_END, entity, query);
}

When(/^I query the "([^"]*)" graph with: (.+)$/, async function (this: EggWorld, entity: string, query: string) {
    await ask(this, entity, query);
});

When(
    /^I query the "([^"]*)" graph as of "([^"]*)" with: (.+)$/,
    async function (this: EggWorld, entity: string, label: string, query: string) {
        const at = this.instants[label];
        assert.ok(at !== undefined, `No instant was captured as "${label}"`);
        await ask(this, entity, withAt(query, at));
    },
);

Then('there should be no GraphQL errors', function (this: EggWorld) {
    const response = this.egg.response;
    assert.ok(response, 'no query was made');
    assert.ok(!response!.errors, `GraphQL errors: ${JSON.stringify(response!.errors)}`);
});

/** The values at a path of object keys; arrays are fanned out along the way. */
function valuesAt(value: unknown, path: string[]): unknown[] {
    if (Array.isArray(value)) return value.flatMap((v) => valuesAt(v, path));
    if (path.length === 0) return [value];
    if (value === null || typeof value !== 'object') return [];
    return valuesAt((value as Record<string, unknown>)[path[0]], path.slice(1));
}

Then('the response at {string} should contain the number {int}', function (this: EggWorld, path: string, n: number) {
    const found = valuesAt(this.egg.response, path.split('.'));
    assert.ok(found.includes(n), `no ${n} at '${path}': ${JSON.stringify(this.egg.response)}`);
});
