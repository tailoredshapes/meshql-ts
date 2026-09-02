import { When, Then } from '@cucumber/cucumber';
import assert from 'assert';
import { AuthzCaller } from '../support/worlds';
import { ContractAuthzWorld, VersionEntry, WidgetService } from '../support/widgets';

/**
 * Bindings for `features/contract/features/versions.feature`, the document
 * versions contract shared with the Java and Rust implementations. The feature
 * file is a submodule and never changes to suit a language; these steps change
 * instead.
 *
 * Every step goes over the wire, against the same widget restlette the
 * authorization contract uses, so what is certified is the REST surface a
 * caller actually gets rather than the Repository underneath it.
 */

function service(world: ContractAuthzWorld): WidgetService {
    assert.ok(world.widgets, 'the Background step must stand up a widget service first');
    return world.widgets!;
}

function versionList(world: ContractAuthzWorld): VersionEntry[] {
    assert.ok(world.versionList, 'no version list has been fetched yet');
    return world.versionList!;
}

/** The n-th entry of the version list in hand, counting from 1. */
function nth(world: ContractAuthzWorld, n: number): VersionEntry {
    const list = versionList(world);
    assert.ok(n >= 1 && n <= list.length, `no version ${n}; the list holds ${list.length}`);
    return list[n - 1];
}

function urlOf(entry: VersionEntry, n: number): string {
    assert.ok(typeof entry.url === 'string', `version ${n} carried no url: ${JSON.stringify(entry)}`);
    return entry.url!;
}

// --- Writes -----------------------------------------------------------------

When(
    '{string} updates widget {string} to kind {string}',
    async function (this: ContractAuthzWorld, caller: string, name: string, kind: string) {
        await service(this).update(caller as AuthzCaller, name, kind);
    },
);

// --- The listing ------------------------------------------------------------

// "1 entry" and "2 entries" are one step with one plural, which a Cucumber
// expression cannot say and a regular expression can.
Then(
    /^the version list for widget "([^"]*)" seen by "([^"]*)" should have (\d+) entr(?:y|ies)$/,
    async function (this: ContractAuthzWorld, name: string, caller: string, expected: string) {
        const list = await service(this).listVersions(caller as AuthzCaller, name);
        assert.strictEqual(
            list.length,
            Number(expected),
            `version list for "${name}" seen by "${caller}": ${JSON.stringify(list)}`,
        );
        this.versionList = list;
    },
);

Then('that version list should be ordered oldest first', function (this: ContractAuthzWorld) {
    const stamps = versionList(this).map((entry) => {
        assert.ok(entry.created_at, `version entry carried no created_at: ${JSON.stringify(entry)}`);
        return entry.created_at;
    });
    assert.deepStrictEqual(stamps, [...stamps].sort(), `version list is not oldest first: ${JSON.stringify(stamps)}`);
});

Then('every entry in that version list should carry a URL', function (this: ContractAuthzWorld) {
    for (const entry of versionList(this)) {
        assert.ok(typeof entry.url === 'string', `entry carried no url: ${JSON.stringify(entry)}`);
    }
});

Then('no entry in that version list should carry a URL', function (this: ContractAuthzWorld) {
    for (const entry of versionList(this)) {
        assert.ok(!('url' in entry), `entry carried a url it should not have: ${JSON.stringify(entry)}`);
        assert.strictEqual(entry.unauthorized, true, `an unreadable version must say so: ${JSON.stringify(entry)}`);
        assert.ok(entry.created_at, `an unreadable version still carries when it happened: ${JSON.stringify(entry)}`);
    }
});

Then('the last entry in that version list should be marked deleted', function (this: ContractAuthzWorld) {
    const list = versionList(this);
    const last = list[list.length - 1];
    assert.ok(last, 'version list is empty');
    assert.strictEqual(last.deleted, true, `the last version should be the deletion: ${JSON.stringify(last)}`);
});

Then(
    'listing the versions of widget {string} as {string} twice should give the same URLs',
    async function (this: ContractAuthzWorld, name: string, caller: string) {
        const first = await service(this).listVersions(caller as AuthzCaller, name);
        const second = await service(this).listVersions(caller as AuthzCaller, name);
        const urls = (list: VersionEntry[]) => list.map((entry) => entry.url ?? '');

        assert.deepStrictEqual(urls(first), urls(second), "a version's address changed between two listings");
        this.versionList = first;
    },
);

// --- Reading one version ----------------------------------------------------

Then(
    /^reading version (\d+) of widget "([^"]*)" as "([^"]*)" should return kind "([^"]*)"$/,
    async function (this: ContractAuthzWorld, n: string, name: string, caller: string, kind: string) {
        if (!this.versionList) {
            this.versionList = await service(this).listVersions(caller as AuthzCaller, name);
        }
        const version = Number(n);
        const url = urlOf(nth(this, version), version);

        const { status, body } = await service(this).fetchPath(caller as AuthzCaller, url);
        assert.strictEqual(status, 200, `reading version ${version} of "${name}": ${JSON.stringify(body)}`);
        assert.strictEqual(
            body?.kind,
            kind,
            `version ${version} of "${name}" should be the version as it was then: ${JSON.stringify(body)}`,
        );
    },
);

Then(
    'reading version token {string} of widget {string} as {string} should not be found',
    async function (this: ContractAuthzWorld, token: string, name: string, caller: string) {
        const path = service(this).versionPath(name, token);
        const { status, body } = await service(this).fetchPath(caller as AuthzCaller, path);
        assert.strictEqual(status, 404, `an unknown version token must 404: ${status} ${JSON.stringify(body)}`);
    },
);

Then(
    /^reading version (\d+) of widget "([^"]*)" as "([^"]*)" should be refused$/,
    async function (this: ContractAuthzWorld, n: string, name: string, caller: string) {
        // The URL is discovered as a caller who *can* see it, then presented by
        // one who cannot -- otherwise the listing would hand out no URL to try.
        const version = Number(n);
        this.versionList = await service(this).listVersions('alice', name);
        const url = urlOf(nth(this, version), version);

        const { status, body } = await service(this).fetchPath(caller as AuthzCaller, url);
        assert.ok(
            status === 403 || status === 404,
            `"${caller}" must not read version ${version} of "${name}", got ${status}: ${JSON.stringify(body)}`,
        );
    },
);
