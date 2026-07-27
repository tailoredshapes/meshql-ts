import { Given, When, Then } from '@cucumber/cucumber';
import assert from 'assert';
import { AuthzCaller, AuthzTestWorld } from '../support/worlds';

const HEN_SELECTION = 'id name eggs';

/**
 * Names are unique per scenario, but two callers may legitimately create a
 * record with the same name (that is exactly what the list scenario needs), so
 * an unqualified lookup must be unambiguous or it is a bug in the feature.
 */
function idByName(world: AuthzTestWorld, name: string): string {
    const matches = Object.entries(world.authz.ids).filter(([key]) => key.endsWith(`/${name}`));
    if (matches.length === 0) throw new Error(`No record named "${name}" has been created`);
    if (matches.length > 1) {
        throw new Error(`"${name}" is ambiguous — ${matches.length} callers created one; name the owner`);
    }
    return matches[0][1];
}

Given('an authorization-enabled MeshQL server is running with the plugin', function (this: AuthzTestWorld) {
    // The server is started in the plugin's BeforeAll hook; this step documents
    // the precondition and fails loudly if a plugin forgot to wire it up.
    assert.ok(this.authz, 'plugin hooks must set `this.authz` to an AuthzEnv');
});

async function createHen(world: AuthzTestWorld, caller: string, name: string) {
    world.lastCreated = await world.authz.create(caller as AuthzCaller, { name, eggs: 1 });
}

Given('{string} has created a hen named {string}', async function (this: AuthzTestWorld, caller: string, name: string) {
    await createHen(this, caller, name);
});

When('{string} creates a hen named {string}', async function (this: AuthzTestWorld, caller: string, name: string) {
    await createHen(this, caller, name);
});

// --- Defect A: do the tokens Auth resolved actually reach storage? ---------

Then('the stored envelope should have authorized tokens {string}', async function (this: AuthzTestWorld, expected: string) {
    const created = this.lastCreated!;
    const repo = await this.authz.repository();
    const envelope = await repo.read(created.id);

    assert.ok(envelope, `no envelope stored for ${created.name}`);

    const expectedTokens = expected
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

    assert.deepStrictEqual(
        [...(envelope!.authorized_tokens ?? [])].sort(),
        [...expectedTokens].sort(),
        'the tokens Auth resolved for the caller must be the tokens that were persisted',
    );
});

Then('the stored envelope should have no authorized tokens', async function (this: AuthzTestWorld) {
    const created = this.lastCreated!;
    const repo = await this.authz.repository();
    const envelope = await repo.read(created.id);

    assert.ok(envelope, `no envelope stored for ${created.name}`);
    assert.deepStrictEqual(envelope!.authorized_tokens ?? [], [], 'an uncredentialed write must stay public');
});

// --- Reads through the graphlette ------------------------------------------

When('{string} queries the graph by id for {string}', async function (this: AuthzTestWorld, caller: string, name: string) {
    const id = idByName(this, name);
    const data = await this.authz.query(caller as AuthzCaller, `{ getById(id: "${id}") { ${HEN_SELECTION} } }`);
    this.singletonResult = data.getById;
});

When(
    '{string} queries the graph by id for {string} as of the captured time',
    async function (this: AuthzTestWorld, caller: string, name: string) {
        const id = idByName(this, name);
        const data = await this.authz.query(
            caller as AuthzCaller,
            `{ getById(id: "${id}", at: ${this.capturedTime}) { ${HEN_SELECTION} } }`,
        );
        this.singletonResult = data.getById;
    },
);

When('{string} queries the graph by name {string}', async function (this: AuthzTestWorld, caller: string, name: string) {
    const data = await this.authz.query(
        caller as AuthzCaller,
        `{ getByName(name: "${name}") { ${HEN_SELECTION} } }`,
    );
    this.vectorResult = data.getByName ?? [];
    this.lastQueryName = name;
});

Then('the singleton result should be the hen {string}', function (this: AuthzTestWorld, name: string) {
    assert.ok(this.singletonResult, `expected to read "${name}", got nothing`);
    assert.strictEqual(this.singletonResult!.name, name);
});

Then('the singleton result should be empty', function (this: AuthzTestWorld) {
    const result = this.singletonResult;
    const visible = result !== null && result !== undefined && result.name !== null && result.name !== undefined;
    assert.ok(!visible, `an unauthorized caller read a record they have no token for: ${JSON.stringify(result)}`);
});

Then('the vector result should contain exactly {int} hen(s)', function (this: AuthzTestWorld, count: number) {
    assert.strictEqual(
        this.vectorResult?.length,
        count,
        `expected ${count} result(s), got ${JSON.stringify(this.vectorResult)}`,
    );
});

Then('the vector result should be owned by {string}', function (this: AuthzTestWorld, caller: string) {
    const expectedId = this.authz.idFor(caller as AuthzCaller, this.lastQueryName!);
    const ids = (this.vectorResult ?? []).map((r) => r.id);
    assert.deepStrictEqual(ids, [expectedId], `${caller} must only see their own record`);
});

// --- Writes and deletes through the restlette ------------------------------

When(
    '{string} deletes the hen {string} created by {string}',
    async function (this: AuthzTestWorld, caller: string, name: string, owner: string) {
        const id = this.authz.idFor(owner as AuthzCaller, name);
        this.responseStatus = await this.authz.removeRest(caller as AuthzCaller, id);
    },
);

Then('the response status should be {int}', function (this: AuthzTestWorld, expected: number) {
    assert.strictEqual(this.responseStatus, expected);
});

Then(
    '{string} should still be able to read the hen {string}',
    async function (this: AuthzTestWorld, caller: string, name: string) {
        const id = idByName(this, name);
        const status = await this.authz.readRest(caller as AuthzCaller, id);
        assert.strictEqual(status, 200, `${caller}'s record was destroyed by a caller with no token for it`);
    },
);

// --- Temporal ---------------------------------------------------------------

Given('I capture the current time', function (this: AuthzTestWorld) {
    this.capturedTime = Date.now();
});
