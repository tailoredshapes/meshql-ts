import { Given, When, Then, DataTable } from '@cucumber/cucumber';
import { SystemSession } from '@tailoredshapes/meshql-auth';
import { IntegrationWorld } from '../support/worlds';
import assert from 'assert';

Given('a fresh repository instance', async function(this: IntegrationWorld) {
    if (!this.plugin!.createRepository) {
        throw new Error('createRepository function not provided to test');
    }
    //console.log("Collection: " + JSON.stringify(this.config));
    this.repository = await this.plugin!.createRepository(this.config!);
});

Given('I have created envelopes:', async function(this: IntegrationWorld, dataTable: DataTable) {
    const rows = dataTable.hashes();
    for (const row of rows) {
        const { name, ...rest } = row;
        const payload = name ? { name, ...rest } : rest;  // Keep name in payload
        const envelope = await this.repository!.create({ payload }, SystemSession);
        this.envelopes!.set(name || payload.name, envelope);
    }
});

Given('I create envelopes:', async function(this: IntegrationWorld, dataTable: DataTable) {
    const rows = dataTable.hashes();
    for (const row of rows) {
        const { name, ...rest } = row;
        const payload = name ? { name, ...rest } : rest;  // Keep name in payload
        const envelope = await this.repository!.create({ payload }, SystemSession);
        this.envelopes!.set(name || payload.name, envelope);
    }
});

When('I create many envelopes:', async function(this: IntegrationWorld, dataTable: DataTable) {
    const rows = dataTable.hashes();
    const envelopes = rows.map((row) => {
        const { name, ...rest } = row;
        const payload = name ? { name, ...rest } : rest;  // Keep name in payload
        return { payload };
    });

    const created = await this.repository!.createMany(envelopes, SystemSession);

    for (const envelope of created) {
        this.envelopes!.set(envelope.payload.name, envelope);
    }
});

When('I create a new version of envelope {string}:', async function(this: IntegrationWorld, name: string, dataTable: DataTable) {
    const existingEnvelope = this.envelopes!.get(name);
    if (!existingEnvelope) {
        throw new Error(`Envelope "${name}" not found`);
    }

    const row = dataTable.hashes()[0];
    const payload = { ...row };

    const newVersion = await this.repository!.create(
        {
            id: existingEnvelope.id,
            auth: existingEnvelope.auth,
            payload,
        },
        SystemSession,
    );

    this.envelopes!.set(name, newVersion);
});

When(/^I read envelopes (\[.*\]) by their IDs$/, async function(this: IntegrationWorld, namesJson: string) {
    const names = JSON.parse(namesJson);
    const ids = names.map((name: string) => {
        const envelope = this.envelopes!.get(name);
        if (!envelope?.id) throw new Error(`Envelope "${name}" not found or has no ID`);
        return envelope.id;
    });

    if (ids.length === 1) {
        this.searchResult = await this.repository!.read(ids[0], SystemSession);
        this.searchResults = this.searchResult ? [this.searchResult] : [];
    } else {
        this.searchResults = await this.repository!.readMany(ids, SystemSession);
    }
});

When('I remove envelope {string}', async function(this: IntegrationWorld, name: string) {
    const envelope = this.envelopes!.get(name);
    if (!envelope?.id) throw new Error(`Envelope "${name}" not found or has no ID`);
    this.removeResult = await this.repository!.remove(envelope.id, SystemSession);
});

When(/^I remove envelopes (\[.*\]) by their IDs$/, async function(this: IntegrationWorld, namesJson: string) {
    const names = JSON.parse(namesJson);
    const ids = names.map((name: string) => {
        const envelope = this.envelopes!.get(name);
        if (!envelope?.id) throw new Error(`Envelope "${name}" not found or has no ID`);
        return envelope.id;
    });

    this.removeResults = await this.repository!.removeMany(ids, SystemSession);
});

When('I list all envelopes', async function(this: IntegrationWorld) {
    this.searchResults = await this.repository!.list(SystemSession);
});

Then('reading envelope {string} at timestamp {string} should return version {string}', async function(this: IntegrationWorld, name: string, timestampLabel: string, expectedVersion: string) {
    const envelope = this.envelopes!.get(name);
    if (!envelope?.id) throw new Error(`Envelope "${name}" not found`);

    const timestamp = this.timestamps!.get(timestampLabel);
    if (!timestamp) throw new Error(`Timestamp "${timestampLabel}" not found`);

    const result = await this.repository!.read(envelope.id, SystemSession, new Date(timestamp));
    assert.strictEqual(result?.payload.version, expectedVersion);
});

Then(/^reading envelopes (\[.*\]) by their IDs should return nothing$/, async function(this: IntegrationWorld, namesJson: string) {
    const names = JSON.parse(namesJson);
    const ids = names.map((name: string) => {
        const envelope = this.envelopes!.get(name);
        if (!envelope?.id) throw new Error(`Envelope "${name}" not found or has no ID`);
        return envelope.id;
    });

    if (ids.length === 1) {
        const result = await this.repository!.read(ids[0], SystemSession);
        assert.ok(result === undefined);
    } else {
        const results = await this.repository!.readMany(ids, SystemSession);
        assert.deepStrictEqual(results, []);
    }
});

Then('the envelopes should have generated IDs', function(this: IntegrationWorld) {
    for (const envelope of this.envelopes!.values()) {
        assert.ok(envelope.id !== undefined);
        assert.strictEqual(typeof envelope.id, 'string');
    }
});

Then('the envelopes created_at should be greater than or equal to the test start time', function(this: IntegrationWorld) {
    for (const envelope of this.envelopes!.values()) {
        assert.ok(envelope.created_at!.getTime() >= this.testStartTime!);
    }
});

Then('the envelopes deleted flag should be disabled', function(this: IntegrationWorld) {
    for (const envelope of this.envelopes!.values()) {
        assert.ok(!envelope.deleted);
    }
});

Then('I should receive {int} envelope(s)', function(this: IntegrationWorld, count: number) {
    assert.strictEqual(this.searchResults?.length, count);
});

Then('I should receive exactly {int} envelope(s)', function(this: IntegrationWorld, count: number) {
    assert.strictEqual(this.searchResults?.length, count);
});

Then('the payload {string} should be {string}', function(this: IntegrationWorld, key: string, value: string) {
    const result = this.searchResult || this.searchResults?.[0];
    assert.strictEqual(result?.payload[key], value);
});

Then('the remove operations should return true', function(this: IntegrationWorld) {
    for(let r of Object.values(this.removeResults!)) {
        assert.strictEqual(r, true);
    }
});

Then('the remove operation should return true', function(this: IntegrationWorld) {
    assert.strictEqual(this.removeResult, true);
});

Then('listing all envelopes should show exactly {int} envelope(s)', async function(this: IntegrationWorld, count: number) {
    const results = await this.repository!.list(SystemSession);
    assert.strictEqual(results.length, count);
});
