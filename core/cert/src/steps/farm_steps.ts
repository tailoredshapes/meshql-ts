import { Given, When, Then, DataTable } from '@cucumber/cucumber';
import { expect } from 'chai';
import { callSubgraph } from '@tailoredshapes/meshql-graphlette';
import Handlebars from 'handlebars';
import { FarmTestWorld } from '../support/worlds';


Given('a MeshQL server is running with the plugin', async function(this: FarmTestWorld) {
    // Runtime (token, apis) is initialized in BeforeAll hook
    // This step exists for clarity in the feature file
});

Given('I have captured the first timestamp', function(this: FarmTestWorld) {
    this.env.first_stamp = Date.now();
});

When('I query the {string} graph:', async function(this: FarmTestWorld, graphName: string, docString: string) {
    const queryTemplate = Handlebars.compile(docString);
    this.now = String(Date.now());

    const query = queryTemplate({ ids: this.env.ids, first_stamp: this.env.first_stamp, now: this.now });
    const queryName= docString.match(/(get\w*)/)![1];

    this.queryResult = await callSubgraph(
        new URL(`http://localhost:${this.env.port}/${graphName}/graph`),
        query,
        queryName,
        `Bearer ${this.env.token}`
    );
});

Then('the farm name should be {string}', function(this: FarmTestWorld, expectedName: string) {
    expect(this.queryResult.name).to.equal(expectedName);
});

Then('there should be {int} {string}', function(this: FarmTestWorld, expectedCount: number, thing: string) {
    expect(this.queryResult[thing]).to.have.length(expectedCount);
});

Then('the result should contain {string} {string}', function(this: FarmTestWorld, key: string, value: string) {
    expect(this.queryResult).to.be.an('array');
    expect(this.queryResult[0][key]).to.equal(value);
});

Then('the {string} ID should match the saved {string} ID', function(this: FarmTestWorld, thing: string, henName: string) {
    expect(this.queryResult.id).to.equal(this.env.ids[thing][henName]);
});

Then('the {int} {string} ID should match the saved {string} ID', function(this: FarmTestWorld, index: number , thing: string, henName: string) {
    expect(this.queryResult[index].id).to.equal(this.env.ids[thing][henName]);
});

Then('there should be {int} results', function(this: FarmTestWorld, expectedCount: number) {
    expect(this.queryResult).to.have.length(expectedCount);
});

Then('the hens should include {string} and {string}', function(this: FarmTestWorld, name1: string, name2: string) {
    const names = this.queryResult.map((hen: any) => hen.name);
    expect(names).to.include(name1);
    expect(names).to.include(name2);
});

Then('the coop name should be {string}', function(this: FarmTestWorld, expectedName: string) {
    if (Array.isArray(this.queryResult)) {
        expect(this.queryResult[0].coop.name).to.equal(expectedName);
    } else {
        expect(this.queryResult.name).to.equal(expectedName);
    }
});

Then('the results should not include {string}', function(this: FarmTestWorld, name: string) {
    const names = this.queryResult.coops.map((c: any) => c.name);
    expect(names).to.not.include(name);
});

Then('the results should include {string}', function(this: FarmTestWorld, name: string) {
    const names = this.queryResult.coops.map((c: any) => c.name);
    expect(names).to.include(name);
});

Given("I have created {string}:", async function(this: FarmTestWorld, thing: string, dataTable: DataTable) {
    let api = this.env.apis[thing];
    if (!this.env.ids[thing]) {
        this.env.ids[thing] = {};
    }
    for (const newThing of dataTable.hashes()) {
        const template = Handlebars.compile(newThing.data);
        const dataStr = template({ ids: this.env.ids });
        const data = eval(`(${dataStr})`);
        const result = await api.create(null, data);
        this.env.ids[thing][newThing.name] = result.request.path.slice(-36);
    }
});

Given("I have updated {string}:", async function(this: FarmTestWorld, thing: string, dataTable: DataTable) {
    let api = this.env.apis[thing];
    for (const updateThing of dataTable.hashes()) {
        const template = Handlebars.compile(updateThing.data);
        const dataStr = template({ ids: this.env.ids });
        const data = eval(`(${dataStr})`);
        await api.update({ id: this.env.ids[thing][updateThing.name] }, data);
    }
});

Given('I take a timestamp', async function(this: FarmTestWorld) {
    this.env.first_stamp = Date.now();
})