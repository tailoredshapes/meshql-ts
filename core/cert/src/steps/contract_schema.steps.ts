import { Given, When, Then } from '@cucumber/cucumber';
import assert from 'assert';
import { AuthzCaller } from '../support/worlds';
import { ContractAuthzWorld, WidgetService } from '../support/widgets';

/**
 * Bindings for `features/contract/features/schema.feature`: the widget
 * restlette enforces the JSON Schema the scenario gives it. The schema reaches
 * the restlette's own configuration, so what is certified is the validation a
 * configured restlette does, not a check of this suite's.
 *
 * The other steps of that feature (creating, listing, querying, versions) are
 * the authorization and version bindings; only the schema-specific ones are
 * here.
 */

function service(world: ContractAuthzWorld): WidgetService {
    assert.ok(world.widgets, 'the Background step must stand up a widget service first');
    return world.widgets!;
}

Given(
    'an authorizing MeshQL server whose widgets must match the JSON Schema:',
    async function (this: ContractAuthzWorld, schema: string) {
        assert.ok(this.widgetHarness, 'plugin hooks must set `this.widgetHarness` to a WidgetHarness');
        this.widgets = await this.widgetHarness.start(undefined, JSON.parse(schema));
        this.instants = {};
    },
);

When(
    '{string} tries to create a widget {string} of kind {string}',
    async function (this: ContractAuthzWorld, caller: string, name: string, kind: string) {
        this.writeStatus = await service(this).attempt(caller as AuthzCaller, 'POST', WidgetService.restPath, { name, kind });
    },
);

When(
    '{string} tries to create a widget {string} with no kind',
    async function (this: ContractAuthzWorld, caller: string, name: string) {
        this.writeStatus = await service(this).attempt(caller as AuthzCaller, 'POST', WidgetService.restPath, { name });
    },
);

When(
    '{string} tries to update widget {string} to kind {string}',
    async function (this: ContractAuthzWorld, caller: string, name: string, kind: string) {
        const path = `${WidgetService.restPath}/${service(this).idFor(name)}`;
        this.writeStatus = await service(this).attempt(caller as AuthzCaller, 'PUT', path, { name, kind });
    },
);

Then('the write should be refused as invalid', function (this: ContractAuthzWorld) {
    assert.strictEqual(this.writeStatus, 400, `the write was not refused with 400: ${this.writeStatus}`);
});
