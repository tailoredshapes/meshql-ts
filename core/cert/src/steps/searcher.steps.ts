import { Given, When, Then, DataTable } from '@cucumber/cucumber';
import { IntegrationWorld, SearcherTestTemplates } from '../support/worlds';
import assert from 'assert';
import { DTOFactory } from '@tailoredshapes/meshql-graphlette';
import { Auth, NoOp } from '@tailoredshapes/meshql-auth';

Given('a fresh repository and searcher instance', async function(this: IntegrationWorld) {
    this.repository = await this.plugin!.createRepository(this.config!);
    const dtoFactory = new DTOFactory([]);
    let auth: Auth = new NoOp();
    this.searcher = await this.plugin!.createSearcher(this.config!, dtoFactory, auth);
});

Given('I have created and saved the following test dataset:', async function(this: IntegrationWorld, dataTable: DataTable) {
    const rows = dataTable.hashes();
    const envelopes = rows.map(row => {
        // Convert numeric string values to numbers
        const payload: any = {};
        for (const [key, value] of Object.entries(row)) {
            payload[key] = isNaN(Number(value)) ? value : Number(value);
        }
        return { payload };
    });
    const saved = await this.repository!.createMany(envelopes, this.tokens);

    saved.forEach(envelope => {
        this.envelopes!.set(envelope.payload.name, envelope);
    });
});

Given('I have removed envelope {string}', async function(this: IntegrationWorld, name: string) {
    const envelope = this.envelopes!.get(name);
    if (!envelope?.id) throw new Error(`Envelope "${name}" not found`);
    await this.repository!.remove(envelope.id, this.tokens);
});

Given('I have updated envelope {string} to {string} with count {int}', async function(this: IntegrationWorld, oldName: string, newName: string, count: number) {
    const envelope = this.envelopes!.get(oldName);
    if (!envelope) throw new Error(`Envelope "${oldName}" not found`);

    const updated = await this.repository!.create({
        id: envelope.id,
        authorized_tokens: envelope.authorized_tokens,
        payload: { ...envelope.payload, name: newName, count }
    });

    this.envelopes!.delete(oldName);
    this.envelopes!.set(newName, updated);
});

When('I search using template {string} with parameters:', async function(this: IntegrationWorld, templateName: keyof SearcherTestTemplates, dataTable: DataTable) {
    const rows = dataTable.hashes();
    const params = {...rows[0]};  // Copy to allow mutations

    // Replace envelope names with actual IDs only for templates that search by ID

    if (templateName === 'findById' && params.id && this.envelopes!.has(params.id)) {
        const envelope = this.envelopes!.get(params.id);
        if (envelope?.id) {
            params.id = envelope.id;
        }
    }

    if (!(this.templates as any)?.[templateName]) {
        throw new Error(`Template "${templateName}" not found`);
    }

    this.searchResult = await this.searcher!.find(this.templates![templateName], params);
});

When('I search all using template {string} with parameters:', async function(this: IntegrationWorld, templateName: keyof SearcherTestTemplates, dataTable: DataTable) {
    const rows = dataTable.hashes();
    const params = {...rows[0]};  // Copy to allow mutations

    // Replace envelope names with actual IDs only for templates that search by ID
    if (templateName === 'findById' && params.id && this.envelopes!.has(params.id)) {
        const envelope = this.envelopes!.get(params.id);
        if (envelope?.id) {
            params.id = envelope.id;
        }
    }

    if (!this.templates?.[templateName]) {
        throw new Error(`Template "${templateName}" not found`);
    }

    this.searchResults = await this.searcher!.findAll(this.templates![templateName], params);
});

Then('the search result should be empty', function(this: IntegrationWorld) {
    assert.deepStrictEqual(this.searchResult, {});
});

Then('the search result should have name {string}', function(this: IntegrationWorld, expectedName: string) {
    assert.strictEqual(this.searchResult.name, expectedName);
});

Then('the search result should have count {int}', function(this: IntegrationWorld, expectedCount: number) {
    assert.strictEqual(this.searchResult.count, expectedCount);
});

Then('I should receive exactly {int} result(s)', function(this: IntegrationWorld, count: number) {
    assert.strictEqual(this.searchResults?.length, count);
});

Then('the results should include an envelope with name {string} and count {int}', function(this: IntegrationWorld, name: string, count: number) {
    const found = this.searchResults?.find(r => r.name === name && r.count === count);
    assert.ok(found !== undefined);
});

Then('the results should include an envelope with name {string}', function(this: IntegrationWorld, name: string) {
    const found = this.searchResults?.find(r => r.name === name);
    assert.ok(found !== undefined);
});
