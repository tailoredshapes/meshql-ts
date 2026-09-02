import { Given, When, Then, After } from '@cucumber/cucumber';
import assert from 'assert';
import { Envelope } from '@tailoredshapes/meshql-common';
import { AuthzCaller, AuthzEnv } from '../support/worlds';
import { ContractAuthzWorld, WidgetService, WidgetView } from '../support/widgets';

/**
 * Bindings for `features/contract/features/authz.feature`, the authorization
 * contract shared with the Java and Rust implementations. The feature file is a
 * submodule and never changes to suit a language; these steps change instead.
 *
 * Every assertion here is about what a caller can see. Refusals are asserted
 * against storage and against the next read, not against a status code — what
 * a server returns for a refusal is the server's business, and the three
 * implementations do not agree on it.
 */

function service(world: ContractAuthzWorld): WidgetService {
    assert.ok(world.widgets, 'the Background step must stand up a widget service first');
    return world.widgets!;
}

/** Names of the widgets a caller could see, in a stable order. */
function names(views: WidgetView[]): string[] {
    return views
        .map((view) => view.name)
        .filter((name): name is string => typeof name === 'string')
        .sort();
}

function visible(view: WidgetView | null | undefined): boolean {
    return !!view && typeof view.name === 'string';
}

/**
 * The tokens on an envelope's mark, for the two steps that assert them.
 *
 * `Envelope.auth` is opaque -- storage never looks inside it and neither does
 * any lette. The certification may, because these two steps exist to check
 * what the *token* plugin stamped; a plugin that stamps something else reads
 * as carrying no tokens, which is exactly what `auth_plugin.feature` asserts.
 */
function marks(envelope: Envelope): string[] {
    return Array.isArray(envelope.auth) ? (envelope.auth as string[]) : [];
}

Given('an authorizing MeshQL server is running', async function (this: ContractAuthzWorld) {
    assert.ok(this.widgetHarness, 'plugin hooks must set `this.widgetHarness` to a WidgetHarness');
    // A service per scenario, over its own empty collection. "List all widgets"
    // means all of them, so nothing another scenario wrote can be present.
    this.widgets = await this.widgetHarness.start();
    this.instants = {};
});

After(async function (this: ContractAuthzWorld) {
    if (this.widgets) {
        await this.widgets.stop();
        this.widgets = undefined;
    }
});

// --- Writes -----------------------------------------------------------------

When(
    '{string} creates a widget {string} of kind {string}',
    async function (this: ContractAuthzWorld, caller: string, name: string, kind: string) {
        await service(this).create(caller as AuthzCaller, name, kind);
    },
);

When('{string} deletes widget {string}', async function (this: ContractAuthzWorld, caller: string, name: string) {
    this.deleteApplied = await service(this).remove(caller as AuthzCaller, name);
});

Then('the delete should be refused', async function (this: ContractAuthzWorld) {
    assert.strictEqual(this.deleteApplied, false, 'a caller with no token for the record deleted it anyway');
});

Then('the delete should succeed', async function (this: ContractAuthzWorld) {
    assert.strictEqual(this.deleteApplied, true, "the owner's own delete was refused");
});

// --- Reads by id ------------------------------------------------------------

Then(
    '{string} can read widget {string} by id',
    async function (this: ContractAuthzWorld, caller: string, name: string) {
        const view = await service(this).readById(caller as AuthzCaller, name);
        assert.ok(visible(view), `${caller} could not read "${name}", which they are entitled to`);
        assert.strictEqual(view!.name, name);
    },
);

Then(
    '{string} cannot read widget {string} by id',
    async function (this: ContractAuthzWorld, caller: string, name: string) {
        const view = await service(this).readById(caller as AuthzCaller, name);
        // The step covers both a record another caller owns and one that has
        // been deleted, so the message stays neutral about which it is.
        assert.ok(!visible(view), `${caller} read "${name}", which is not visible to them: ${JSON.stringify(view)}`);
    },
);

// --- Queries ----------------------------------------------------------------

When(
    '{string} queries widgets of kind {string}',
    async function (this: ContractAuthzWorld, caller: string, kind: string) {
        this.result = names(await service(this).readByKind(caller as AuthzCaller, kind));
    },
);

When('{string} lists all widgets', async function (this: ContractAuthzWorld, caller: string) {
    this.result = (await service(this).list(caller as AuthzCaller)).sort();
});

Then('the result should be exactly {string}', function (this: ContractAuthzWorld, expected: string) {
    const wanted = expected
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
        .sort();

    assert.deepStrictEqual(this.result ?? [], wanted);
});

// --- What reached storage ---------------------------------------------------

Then(
    'the stored envelope for widget {string} should carry no tokens',
    async function (this: ContractAuthzWorld, name: string) {
        const envelope = await service(this).storedEnvelope(name);
        assert.ok(envelope, `no envelope stored for "${name}"`);
        // "No tokens" covers both a token plugin that resolved none and a
        // plugin that marks records with something other than tokens, or with
        // nothing at all. The mark is the plugin's; this only asserts it is
        // carrying no tokens.
        assert.deepStrictEqual(marks(envelope!), [], 'a write with no credentials must stay public');
    },
);

Then(
    'the stored envelope for widget {string} should carry the tokens {string} resolves to',
    async function (this: ContractAuthzWorld, name: string, caller: string) {
        const envelope = await service(this).storedEnvelope(name);
        assert.ok(envelope, `no envelope stored for "${name}"`);

        const expected = AuthzEnv.credentials[caller as AuthzCaller];
        assert.ok(expected, `Unknown caller "${caller}"`);

        assert.deepStrictEqual(
            [...marks(envelope!)].sort(),
            [...expected].sort(),
            'the tokens Auth resolved for the caller must be the tokens that were persisted',
        );
    },
);

// --- Temporal ---------------------------------------------------------------

When('the current instant is captured as {string}', async function (this: ContractAuthzWorld, label: string) {
    this.instants[label] = Date.now();
    // Everything written after this step has to be strictly later than the
    // captured instant, and `created_at` is only accurate to the millisecond.
    // Without the pause a write in the same millisecond is visible "before" it.
    await new Promise((resolve) => setTimeout(resolve, 10));
});

function instant(world: ContractAuthzWorld, label: string): number {
    const at = world.instants[label];
    if (at === undefined) throw new Error(`No instant was captured as "${label}"`);
    return at;
}

When(
    '{string} reads widget {string} by id as of {string}',
    async function (this: ContractAuthzWorld, caller: string, name: string, label: string) {
        this.singleton = await service(this).readById(caller as AuthzCaller, name, instant(this, label));
    },
);

Then('the temporal read should find it', function (this: ContractAuthzWorld) {
    assert.ok(visible(this.singleton), `the record was invisible as of the captured instant`);
});

Then('the temporal read should find nothing', function (this: ContractAuthzWorld) {
    assert.ok(
        !visible(this.singleton),
        `rewinding the clock exposed a record the caller holds no token for: ${JSON.stringify(this.singleton)}`,
    );
});

When(
    '{string} queries widgets of kind {string} as of {string}',
    async function (this: ContractAuthzWorld, caller: string, kind: string, label: string) {
        this.result = names(await service(this).readByKind(caller as AuthzCaller, kind, instant(this, label)));
    },
);
