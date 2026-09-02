import { Given, When, Then, DataTable } from '@cucumber/cucumber';
import { IntegrationWorld, SearcherTestTemplates } from '../support/worlds';
import assert from 'assert';
import { DTOFactory } from '@tailoredshapes/meshql-graphlette';
import { SystemSession } from '@tailoredshapes/meshql-auth';

Given('a fresh repository and searcher instance', async function (this: IntegrationWorld) {
    this.repository = await this.plugin!.createRepository(this.config!);
    const dtoFactory = new DTOFactory([]);
    this.searcher = await this.plugin!.createSearcher(this.config!, dtoFactory);
});

Given(
    'I have created and saved the following test dataset:',
    async function (this: IntegrationWorld, dataTable: DataTable) {
        const rows = dataTable.hashes();
        const envelopes = rows.map((row) => {
            // Convert numeric string values to numbers
            const payload: any = {};
            for (const [key, value] of Object.entries(row)) {
                payload[key] = isNaN(Number(value)) ? value : Number(value);
            }
            return { payload };
        });
        const saved = await this.repository!.createMany(envelopes, SystemSession);

        saved.forEach((envelope) => {
            this.envelopes!.set(envelope.payload.name, envelope);
        });
    },
);

Given('I have removed envelope {string}', async function (this: IntegrationWorld, name: string) {
    const envelope = this.envelopes!.get(name);
    if (!envelope?.id) throw new Error(`Envelope "${name}" not found`);
    await this.repository!.remove(envelope.id, SystemSession);
});

Given(
    'I have updated envelope {string} to {string} with count {int}',
    async function (this: IntegrationWorld, oldName: string, newName: string, count: number) {
        const envelope = this.envelopes!.get(oldName);
        if (!envelope) throw new Error(`Envelope "${oldName}" not found`);

        const updated = await this.repository!.create(
            {
                id: envelope.id,
                auth: envelope.auth,
                payload: { ...envelope.payload, name: newName, count },
            },
            SystemSession,
        );

        this.envelopes!.delete(oldName);
        this.envelopes!.set(newName, updated);
    },
);

/**
 * The parameters a search step passes to the searcher. Envelope names in the
 * data table stand in for ids the test cannot know ahead of time, so resolve
 * them to the real ids before the template sees them.
 */
function queryParams(
    world: IntegrationWorld,
    templateName: keyof SearcherTestTemplates,
    dataTable: DataTable,
): Record<string, any> {
    const rows = dataTable.hashes();
    const params: Record<string, any> = { ...rows[0] }; // Copy to allow mutations

    // Replace envelope names with actual IDs only for templates that search by ID
    if (templateName === 'findById' && params.id && world.envelopes!.has(params.id)) {
        const envelope = world.envelopes!.get(params.id);
        if (envelope?.id) {
            params.id = envelope.id;
        }
    }

    if (!world.templates?.[templateName]) {
        throw new Error(`Template "${templateName}" not found`);
    }

    return params;
}

When(
    'I search using template {string} with parameters:',
    async function (this: IntegrationWorld, templateName: keyof SearcherTestTemplates, dataTable: DataTable) {
        const params = queryParams(this, templateName, dataTable);

        this.searchResult = await this.searcher!.find(this.templates![templateName], params, SystemSession);
    },
);

When(
    'I search all using template {string} with parameters:',
    async function (this: IntegrationWorld, templateName: keyof SearcherTestTemplates, dataTable: DataTable) {
        const params = queryParams(this, templateName, dataTable);

        this.searchResults = await this.searcher!.findAll(this.templates![templateName], params, SystemSession);
    },
);

When(
    'I search all using template {string} with a limit of {int} and parameters:',
    async function (
        this: IntegrationWorld,
        templateName: keyof SearcherTestTemplates,
        limit: number,
        dataTable: DataTable,
    ) {
        // The limit reaches the searcher as an ordinary query argument, the
        // same route every other parameter takes.
        const params = { ...queryParams(this, templateName, dataTable), limit };

        this.searchResults = await this.searcher!.findAll(this.templates![templateName], params, SystemSession);
    },
);

Then('the search result should be empty', function (this: IntegrationWorld) {
    assert.deepStrictEqual(this.searchResult, {});
});

Then('the search result should have name {string}', function (this: IntegrationWorld, expectedName: string) {
    assert.strictEqual(this.searchResult.name, expectedName);
});

Then('the search result should have count {int}', function (this: IntegrationWorld, expectedCount: number) {
    assert.strictEqual(this.searchResult.count, expectedCount);
});

Then('I should receive exactly {int} result(s)', function (this: IntegrationWorld, count: number) {
    assert.strictEqual(this.searchResults?.length, count);
});

Then(
    'the results should include an envelope with name {string} and count {int}',
    function (this: IntegrationWorld, name: string, count: number) {
        const found = this.searchResults?.find((r) => r.name === name && r.count === count);
        assert.ok(found !== undefined);
    },
);

Then('the results should include an envelope with name {string}', function (this: IntegrationWorld, name: string) {
    const found = this.searchResults?.find((r) => r.name === name);
    assert.ok(found !== undefined);
});

// "Honesty" as-of field: opt-in via GraphQL schema, mirroring how "id"
// already works. find/findAll must merge createdAt (ISO-8601 string) into
// the returned record so a .graphql type can declare `createdAt: String`
// and get it resolved for free.
Then('the search result should have a valid createdAt', function (this: IntegrationWorld) {
    assert.ok(this.searchResult.createdAt, 'search result must include createdAt');
    assert.doesNotThrow(() => {
        const parsed = new Date(this.searchResult.createdAt);
        if (isNaN(parsed.getTime())) throw new Error('not a valid date');
    }, 'createdAt must be a valid ISO-8601 date string');
});

Then('every result should have a valid createdAt', function (this: IntegrationWorld) {
    assert.ok(this.searchResults && this.searchResults.length > 0);
    for (const result of this.searchResults!) {
        assert.ok(result.createdAt, 'every result must include createdAt');
        const parsed = new Date(result.createdAt);
        assert.ok(!isNaN(parsed.getTime()), 'createdAt must be a valid ISO-8601 date string');
    }
});
