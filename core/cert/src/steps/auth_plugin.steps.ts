import { Given } from '@cucumber/cucumber';
import assert from 'assert';
import { CERT_AUTH_PLUGINS } from '../support/auth_plugins';
import { ContractAuthzWorld } from '../support/widgets';

/**
 * The one step `features/contract/features/auth_plugin.feature` adds. Every
 * other step it uses is shared with `authz.feature` and lives in
 * `contract_authz.steps.ts` -- which is the point: the same surfaces, driven
 * the same way, against a plugin that answers differently.
 */
Given(
    'a MeshQL server running the {string} auth plugin',
    async function (this: ContractAuthzWorld, plugin: string) {
        assert.ok(this.widgetHarness, 'plugin hooks must set `this.widgetHarness` to a WidgetHarness');

        const build = CERT_AUTH_PLUGINS[plugin];
        assert.ok(build, `No certification auth plugin named "${plugin}"`);

        // A service per scenario, over its own empty collection, exactly as the
        // token-plugin scenarios get one.
        this.widgets = await this.widgetHarness.start(build());
        this.instants = {};
    },
);
