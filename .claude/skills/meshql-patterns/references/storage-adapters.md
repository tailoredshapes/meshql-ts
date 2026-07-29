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
5. **Template rendering.** Searchers render the Handlebars template with `args` into a query **in the store's own language** (JSON for Mongo, a SQL `WHERE` fragment for the SQL adapters) — there is no portable template dialect. `id` always addresses the envelope id column/field. Payload fields differ: Mongo uses `payload.<field>` inside the filter document, while the SQL adapters expect the template author to write the JSON extraction explicitly (`payload->>'<field>'`, `JSON_UNQUOTE(JSON_EXTRACT(payload, '$.<field>'))`, `json_extract(payload, '$.<field>')`) — the envelope table has no per-domain-field columns. A new adapter must document which shape it expects, and should prefer to fail loudly on an unrecognised key: Mongo's silent empty-result behaviour is the single most common source of "the query returns nothing and there's no error" (see SKILL.md, "Query templates: the shape is per-adapter"). Always parameterize actual values — the template *structure* is admin-authored config (see SKILL.md's note on the Handlebars-triple-brace pattern not being a SQL-injection issue), but don't defeat that by splicing raw user values into a string yourself instead of going through Handlebars/parameterized queries the way the existing adapters do.
6. **Searcher returns payloads, not envelopes.** `find`/`findAll` return the payload object with `id` merged in, ready for GraphQL resolution (`result.payload.id = result.id`). Also merge in `createdAt` (ISO-8601 string, from the Envelope's `created_at`) right next to `id` — this is what lets a `.graphql` type opt into the "honesty" as-of field (`createdAt: String`) with zero resolver code, since object-type field resolution here is a plain object key lookup. Never merge in `deleted` — search results already exclude deleted/superseded versions, so there's nothing to expose.
7. **Canonical result ordering: `created_at`, then `id`.** A result set is returned in insertion order — sorted by the *resolved* version's `created_at` (millisecond precision), tiebroken by the envelope `id` — so a `limit` truncates a meaningful prefix rather than an arbitrary subset. Adapters that happen to have a monotonic physical sequence (SQLite `rowid`, Mongo's `_id`) may use it to decide *which version* of an id resolves inside a millisecond, but never as the primary sort key: Postgres and MySQL have no equivalent to offer, and cross-adapter equivalence is worth more than sub-millisecond fidelity. **Status in this port:** `repos/*_repo` window per id with `ORDER BY created_at DESC` and don't yet pin the `id` tiebreaker, and `core/cert`'s features don't yet contain ordering scenarios — the Rust port does certify this (`meshql_core::envelope_order` plus dedicated ordering tests). If a design of yours leans on result order, add the scenarios to `core/cert` and make the adapters agree; do **not** reach under an adapter for a physical sequence instead (next section).

## Don't reach underneath the abstraction

The certification suite is not a smoke test; it is the **contract**. Choosing a storage backend is about what you already operate, what your team knows, and what you like — not about capability. There is no practical difference in behaviour between the implementations, and that is precisely what certification exists to guarantee. The property worth protecting: **you should be able to swap the database engine and replay the queue into the new store without any end user noticing a difference.**

So: **never depend on a storage-engine property the certification does not guarantee.**

A recent design picked SQLite specifically so a worker could tail `_id INTEGER PRIMARY KEY` as a CDC cursor — the reasoning being that SQLite serialises writers, so `_id` order is commit order. It works, and it is reaching *underneath* the abstraction. Nothing in `Repository`/`Searcher` exposes a physical row id; nothing in `core/cert` promises one exists, or that it is dense, or that it is monotonic with commit order; Postgres, MySQL and Mongo have no equivalent to offer. The moment that cursor exists, swap-and-replay is gone and the product is welded to one engine — for a property that was never part of the deal.

The replacements, in order of what you were actually trying to do:

- **Need a stable order over results?** Use the canonical order (semantics 7 above: `created_at`, then `id`), and certify it if this port doesn't yet.
- **Need a durable consumption position?** That's the Kafka consumer group's committed offset, not a row id — and it is checkpointed with the fold state as one artifact (see `references/domain-design.md`).
- **Need events on a log at all?** That's storage-layer CDC (Debezium watching the store), not a hand-rolled tail (same file).

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
