# Storage Adapters: Plugin, Repository, Searcher, and Certification

A datastore plugs into meshobj by implementing the `Plugin` interface (`core/server/src/plugin.ts`), which produces implementations of `Repository` and `Searcher` (`core/common/src/index.ts`). Existing adapters: `repos/sqlite_repo` (smallest — best starting reference), `repos/mongo_repo`, `repos/postgres_repo`, `repos/mysql_repo`.

## The interfaces

```typescript
// core/server/src/plugin.ts
export interface Plugin {
    createRepository: (config: StorageConfig) => Promise<Repository>;
    createSearcher: (config: StorageConfig, dtoFactory: DTOFactory, auth: Auth) => Promise<Searcher>;
    cleanup: () => Promise<void>;
}

// core/common/src/index.ts
export interface Repository {
    create: (envelope: Envelope, tokens?: string[]) => Promise<Envelope>;
    read: (id: Id, tokens?: string[], createdAt?: Date) => Promise<Envelope | undefined>;
    list: (tokens?: string[]) => Promise<Envelope[]>;
    remove: (id: Id, tokens?: string[]) => Promise<boolean>;
    createMany: (payloads: Envelope[], tokens?: string[]) => Promise<Envelope[]>;
    readMany: (ids: Id[], tokens?: string[]) => Promise<Envelope[]>;
    removeMany: (ids: Id[], tokens?: string[]) => Promise<Record<Id, boolean>>;
    ready: () => Promise<boolean>;
}

export interface Searcher {
    find(queryTemplate: TemplateDelegate, args: Record<string, any>, creds?: string[], timestamp?: number): Promise<Record<string, any>>;
    findAll(queryTemplate: TemplateDelegate, args: Record<string, any>, creds?: string[], timestamp?: number): Promise<Record<string, any>[]>;
    ready: () => Promise<boolean>;
}
```

`createSearcher` also receives the graphlette's `DTOFactory` (federation resolvers) and the `Auth` in use — a `Searcher` implementation calls `dtoFactory.fillOne`/`fillMany` on its results to attach resolver fields before returning them (see `repos/mongo_repo/src/mongoSearcher.ts`).

## Semantics every adapter MUST honor

These are the contract, and are what `core/cert`'s BDD suite exercises:

1. **Append-only versioning.** `create` with an existing `id` in the payload appends a new version (newer `created_at`); it never overwrites. Reads return the latest version per id. `repos/mongo_repo/src/mongoRepo.ts`'s `create` always stamps a fresh `created_at = new Date()` and inserts — it never does an update-in-place.
2. **Temporal reads.** `read(id, tokens, at)` / `find(..., timestamp)` must return the latest version with `created_at <= at`. **Use `<=`, not `<`.** `mongo_repo`'s `Repository.read` gets this right (`created_at: { $lte: created_at }`); its `Searcher.find`/`findAll` use `{ $lt: new Date(timestamp) }`, which can miss a record created in the same millisecond as the query. Don't copy the `Searcher` version into a new adapter — match the `Repository` one.
3. **Soft delete.** `remove` marks the record deleted (Mongo: `$set: { deleted: true }`; SQL adapters: a `deleted` column) rather than deleting the row. All read paths must exclude a record whose *latest applicable version* is deleted (Mongo: `deleted: { $exists: false }` in the read/list filter). A temporal read *before* the deletion should still return the record.
4. **Token filtering on every read, using the `authorized_tokens` field name.** A record is visible iff its `authorized_tokens` is empty (public) or intersects the caller's token set. **Every write path in this codebase populates `authorized_tokens`** (`core/restlette/src/crud.ts`) — that's the field name in the `Envelope` schema (`core/common/src/index.ts`) and the one every other adapter's SQL/filter code uses (`repos/postgres_repo`, `repos/mysql_repo`, `repos/sqlite_repo`). `repos/mongo_repo/src/mongoRepo.ts` is the outlier: its `create`/`read`/`list`/`remove` filter helper (`secureRead`) sets/matches `authorized_readers`, a field nothing ever writes — meaning token-based visibility filtering on Mongo repositories is effectively inert today. If you touch `mongo_repo`, fix the field name to `authorized_tokens` rather than propagating it; if you're writing a new adapter, use `authorized_tokens` from the start.
5. **Template rendering.** Searchers render the Handlebars template with `args` into a query (JSON for Mongo, SQL text for the SQL adapters), then translate keys: `id` → envelope id column/field; anything else → payload path (Mongo: `payload.<field>`; SQL: whatever the adapter's schema uses). Always parameterize actual values — the template *structure* is admin-authored config (see SKILL.md's note on the Handlebars-triple-brace pattern not being a SQL-injection issue), but don't defeat that by splicing raw user values into a string yourself instead of going through Handlebars/parameterized queries the way the existing adapters do.
6. **Searcher returns payloads, not envelopes.** `find`/`findAll` return the payload object with `id` merged in, ready for GraphQL resolution (`result.payload.id = result.id`). Also merge in `createdAt` (ISO-8601 string, from the Envelope's `created_at`) right next to `id` — this is what lets a `.graphql` type opt into the "honesty" as-of field (`createdAt: String`) with zero resolver code, since object-type field resolution here is a plain object key lookup. Never merge in `deleted` — search results already exclude deleted/superseded versions, so there's nothing to expose.

## Adding a new adapter

1. New workspace package `repos/<store>_repo`, added to the Yarn workspaces / Lerna packages list, depending on `@tailoredshapes/meshql-common` (for `Repository`/`Searcher`/`Envelope` types) and `@tailoredshapes/meshql-graphlette` (for `DTOFactory`, needed by `createSearcher`'s signature).
2. Implement `<Store>Repository` and `<Store>Searcher` per the semantics above. `repos/sqlite_repo/src/` is the smallest complete reference.
3. Implement a `<Store>Plugin implements Plugin` that constructs them from `StorageConfig` (the HOCON `storage` block for that entity — at minimum a `type` discriminator plus whatever connection info the store needs).
4. **Certify.** Provide a Cucumber hooks file (`test/support/hooks.ts` in the new package) that sets up `TestWorld.createRepository`/`createSearcher`/`tearDown`/`templates` per `core/cert/src/support/README.md`, then run the shared feature files (`core/cert/features/integration/repository.feature`, `searcher.feature`) against it — `yarn test:bdd` in the new package, following `repos/sqlite_repo/test/{e2e,integration}/support/hooks.ts` or `repos/postgres_repo/test/support/hooks.ts` as a template. An adapter is not done until certification passes — it covers create/read/list/remove, bulk ops, temporal versioning (including the same-millisecond edge case), and (once `mongo_repo`'s `authorized_readers` issue is fixed as precedent) token visibility.
5. Register the new `Plugin` in `core/cli/src/cli.ts`'s plugin map so `meshql-cli` deployments can pick it up via `storage.type` in HOCON.

## What does NOT belong in an adapter

- Business validation, defaults, side effects → an extra Express route/middleware mounted on the app `init()` returns, or a wrapper around the `Repository`/`Searcher` outside the `repos/<store>_repo` package (see `references/adding-an-entity.md` — meshobj has no built-in `defaults`/`post_create` hook to lean on instead).
- Cross-entity joins → graphlette resolvers (federation, `references/federation.md`).
- Aggregations/read models → projection entities built by a CDC-driven worker (`references/domain-design.md`), not computed in `find`/`findAll`.

Adapters translate Envelope semantics to a store. Nothing else.
