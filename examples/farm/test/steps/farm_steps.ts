import { Given, When, Then, DataTable } from '@cucumber/cucumber';
import { FarmWorld } from '../support/world';
import { callSubgraph } from '@tailoredshapes/meshql-graphlette';
import { expect } from 'chai';

Given('the farm service is running in Docker', async function(this: FarmWorld) {
    // Environment is already started in BeforeAll hook
    expect(this.environment).to.exist;
});

Given('I have created the REST API clients', async function(this: FarmWorld) {
    // APIs are already initialized in BeforeAll hook
    expect(this.hen_api).to.exist;
    expect(this.coop_api).to.exist;
    expect(this.farm_api).to.exist;
});

Given('I have populated the farm data', async function(this: FarmWorld) {
    // Create farm
    const farm = await this.farm_api!.create(undefined, { name: 'Emerdale' });
    this.farm_id = (farm as any).request.path.slice(-36);

    // Create coops
    const coop1 = await this.coop_api!.create(undefined, { name: 'red', farm_id: this.farm_id });
    this.coop1_id = (coop1 as any).request.path.slice(-36);

    const coop2 = await this.coop_api!.create(undefined, { name: 'yellow', farm_id: this.farm_id });
    this.coop2_id = (coop2 as any).request.path.slice(-36);

    await this.coop_api!.create(undefined, { name: 'pink', farm_id: this.farm_id });

    // Update first coop
    await this.coop_api!.update({ id: this.coop1_id } as any, { name: 'purple', farm_id: this.farm_id });

    // Create hens
    const hens = [
        { name: 'chuck', eggs: 2, coop_id: this.coop1_id },
        { name: 'duck', eggs: 0, coop_id: this.coop1_id },
        { name: 'euck', eggs: 1, coop_id: this.coop2_id },
        { name: 'fuck', eggs: 2, coop_id: this.coop2_id },
    ];

    await Promise.all(hens.map((hen) => this.hen_api!.create(undefined, hen)));
});

When('I query the farm graph with:', async function(this: FarmWorld, docString: string) {
    // Replace ${farm_id} with actual farm_id
    const query = docString.replace(/\$\{farm_id\}/g, this.farm_id!);

    this.graphqlResult = await callSubgraph(
        new URL(`http://localhost:3033/farm/graph`),
        query,
        'getById',
        null
    );
});

Then('the farm name should be {string}', function(this: FarmWorld, expectedName: string) {
    expect(this.graphqlResult.name).to.equal(expectedName);
});

Then('there should be {int} coops', function(this: FarmWorld, expectedCount: number) {
    expect(this.graphqlResult.coops).to.have.length(expectedCount);
});