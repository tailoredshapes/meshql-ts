# Storage Adapters: Plugin, Repository, Searcher, and Certification

A datastore plugs into meshobj by implementing the `Plugin` interface (`core/server/src/plugin.ts`), which produces implementations of `Repository` and `Searcher` (`core/common/src/index.ts`). Existing adapters: `repos/sqlite_repo` (smallest — best starting reference), `repos/mongo_repo`, `repos/postgres_repo`, `repos/mysql_repo`.

## The interfaces

```typescript
// core/server/src/plugin.ts
export interface Plugin {
    createRepository: (config: StorageConfig) => Promise<Repository>;
    createSearcher: (config: StorageConfig, dtoFactory: DTOFactory) => Promise<Searcher>;
    cleanup: () => Promise<void>;
}

// core/common/src/index.ts
export interface Repository {
    create: (envelope: Envelope, session: Session) => Promise<Envelope>;
    read: (id: Id, session: Session, createdAt?: Date) => Promise<Envelope | undefined>;
    list: (session: Session) => Promise<Envelope[]>;
    remove: (id: Id, session: Session) => Promise<boolean>;
    createMany: (payloads: Envelope[], session: Session) => Promise<Envelope[]>;
    readMany: (ids: Id[], session: Session) => Promise<Envelope[]>;
    removeMany: (ids: Id[], session: Session) => Promise<Record<Id, boolean>>;
    ready: () => Promise<boolean>;
}

export interface Searcher {
    find(queryTemplate: TemplateDelegate, args: Record<string, any>, session: Session, timestamp?: number): Promise<Record<string, any>>;
    findAll(queryTemplate: TemplateDelegate, args: Record<string, any>, session: Session, timestamp?: number): Promise<Record<string, any>[]>;
    ready: () => Promise<boolean>;
}
```

Note what an adapter is **not** handed: an `Auth`, or a credential of any kind. It gets the caller's `Session` per call and can ask it about an envelope; it cannot work out who is asking, and it has no rule of its own to apply.

`createSearcher` also receives the graphlette's `DTOFactory` (federation resolvers) — a `Searcher` implementation calls `dtoFactory.fillOne`/`fillMany` on its results to attach resolver fields before returning them (see `repos/mongo_repo/src/mongoSearcher.ts`).

## Semantics every adapter MUST honor

These are the contract, and are what `core/cert`'s BDD suite exercises:

1. **Append-only versioning.** `create` with an existing `id` in the payload appends a new version (newer `created_at`); it never overwrites. Reads return the latest version per id. `repos/mongo_repo/src/mongoRepo.ts`'s `create` always stamps a fresh `created_at = new Date()` and inserts — it never does an update-in-place.
2. **Temporal reads.** `read(id, session, at)` / `find(..., timestamp)` must return the latest version with `created_at <= at`. **Use `<=`, not `<`.** `mongo_repo`'s `Repository.read` gets this right (`created_at: { $lte: created_at }`); its `Searcher.find`/`findAll` use `{ $lt: new Date(timestamp) }`, which can miss a record created in the same millisecond as the query. Don't copy the `Searcher` version into a new adapter — match the `Repository` one.
3. **Soft delete.** `remove` marks the record deleted (Mongo: `$set: { deleted: true }`; SQL adapters: a `deleted` column) rather than deleting the row. All read paths must exclude a record whose *latest applicable version* is deleted (Mongo: `deleted: { $exists: false }` in the read/list filter). A temporal read *before* the deletion should still return the record.
4. **Ask the session on every read; stamp it on every write.** An adapter does not decide visibility — it fetches, then calls `session.isAuthorized('read', envelope)` and drops what comes back false (`authorized()` in `core/common` resolves the decisions before filtering, which is the only safe way to filter on an async predicate). On a write it calls `session.stamp(envelope)` and persists `envelope.auth` **verbatim, in the same statement as the payload** — authorization must never become a dual write, or a crash can leave a record present with its mark missing.

    `Envelope.auth` is `unknown` and it is the plugin's, not yours. Do not read it, do not filter on it in SQL, do not assume it is a list of strings: a token plugin stamps one, and a plugin that authorizes on a payload field stamps nothing at all. This is why the column is JSON/JSONB rather than `TEXT[]`.

    Pushing the filter into the query is an **optional** optimization the spec allows only through a plugin-supplied hint (`specs/auth-plugin-owns-authorization.md`), and no adapter implements it today. Inventing your own `WHERE` clause over `auth` is how eleven adapters came to answer one question eleven different ways.

    `auth_plugin.feature` is what holds you to this: it runs the same surfaces against a plugin that refuses every read and one that authorizes on a payload field, and an adapter that answers for itself fails both.
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
