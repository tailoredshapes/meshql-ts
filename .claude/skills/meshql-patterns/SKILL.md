---
name: meshql-patterns
description: Core architecture patterns for building services with meshql-ts (meshobj). Use when adding entities, endpoints, resolvers, or storage backends; designing GraphQL/JSON schemas; wiring federation via HOCON config; or modeling domains (actors/events/projections) on meshql. Covers Repository/Searcher/Plugin interfaces, Envelope semantics, temporal queries, authorization, and CQRS conventions.
---

# meshql Architecture Patterns (TypeScript / meshobj)

meshql turns every entity into a pair of HTTP surfaces backed by the same store:

- **REST restlette** at `/<entity>/api` — CRUD writes + simple reads, JSON Schema validation (AJV)
- **GraphQL graphlette** at `/<entity>/graph` — rich queries, federation to other entities, point-in-time reads

Everything is stored as an **Envelope**: `{id, payload, created_at, deleted, authorized_tokens}` (`core/common/src/index.ts`). Updates append new versions (same `id`, newer `created_at`); deletes set `deleted = true`. Nothing is mutated or hard-deleted. This is what makes temporal queries (`at:` argument) and audit trails free — never break it.

**The pattern meshql is built for** (start here for any non-trivial system): model the domain as **events** (immutable facts) and **projections** (domain models derived from events by **workers**, driven by CDC — Debezium/Kafka in this stack). Front ends write events, never domain models; new domain models can be materialized by replaying history. The invariants below exist to make this sound. See `references/domain-design.md`.

## The six invariants

Follow these in every change; they are what the architecture excels at:

1. **CQRS by convention.** Writes go through REST (`POST/PUT/DELETE /<entity>/api`). Reads — especially anything relational or historical — go through GraphQL (`/<entity>/graph`). Don't add write mutations to graphlettes; don't build join logic into restlettes.
2. **Envelopes are immutable versions.** A PUT creates a new Envelope version (`Repository.create` under the hood — `core/restlette/src/crud.ts`'s `update` calls `repo.create`, never an in-place update). A DELETE writes a tombstone (`deleted: true`). Reads return the latest non-deleted version at-or-before the requested time. Never write adapter code that updates a row/document in place or filters without excluding `deleted`.
3. **Temporal everywhere.** Every GraphQL `Query` field takes `at: Float` (epoch millis). The graphlette layer (`core/graphlette/src/graph/subgraph.ts`'s `addTimestampToQuery`) automatically stamps `at` onto every federated subgraph call if the caller didn't supply one, so point-in-time reads stay consistent across a whole federated chain without any per-resolver code. When adding a query, include `at: Float` in the schema and let the Searcher's version-windowing handle it.
4. **Authorization rides the Envelope.** `authorized_tokens` on each Envelope is matched against caller credentials extracted by the `Auth` interface (`core/auth`, `core/jwt_auth`, `core/casbin_auth`). Visibility: empty tokens = public, otherwise the caller's tokens must intersect. Repositories and Searchers must filter by tokens on *every* read path — adding a query that skips token filtering is a security bug. (Watch the field name: `mongo_repo`'s `read`/`list` filter on `authorized_readers`, which nothing ever writes — the Envelope field and every other adapter use `authorized_tokens`. Don't copy that name into a new adapter.)
5. **Storage is pluggable, behavior is certified.** Datastores only implement the `Plugin` interface (`createRepository`, `createSearcher`, `cleanup` — `core/server/src/plugin.ts`), backed by `Repository` + `Searcher` (`core/common/src/index.ts`). All business behavior lives above these interfaces. A new adapter must pass the shared BDD certification suite (`core/cert`).
6. **Pick your scale — one size does not fit all.** The same abstraction deliberately has a lightweight form and a heavier distributed form, and choosing a different implementation for dev/test than for production is *idiomatic*, not a compromise. SQLite for a fast local test; Mongo, Postgres, or MySQL for prod (`repos/sqlite_repo`, `repos/mongo_repo`, `repos/postgres_repo`, `repos/mysql_repo`). CDC via Debezium+Kafka for a real projection pipeline (`examples/events`); a single-process modular monolith for something smaller (`examples/farm`). The behavior contract (certification, the `Plugin`/`Repository`/`Searcher` interfaces) is identical; only the deployment weight changes. When you see two ways to run one seam, that is the design working — do not collapse them.

## Honesty: as-of freshness

The FE should be able to tell how fresh a payload is, so it can show a "pending" state and let the user refresh instead of silently rendering stale data. Envelope metadata stays internal (invariant 2 links `created_at` to versioning, not exposure) except for two deliberate, minimal leaks:

- **REST** (`Crud` in `core/restlette/src/crud.ts`): `create`/`read`/`update` responses carry `X-Meshql-Created-At` (ISO-8601, from `envelope.created_at`) and `X-Meshql-Deleted` (`true`/`false`) headers. The JSON body stays payload-only — these are headers, not body fields. Because `create`/`update` respond with a `303` redirect to the resource URL and `fetch()` follows redirects by default, the headers end up visible on the final response either way (the `read` handler that the redirect lands on sets them too).
- **GraphQL**: every `Searcher.find`/`findAll` implementation (`repos/*/src/*Searcher.ts`) merges `createdAt` (ISO-8601 string) into the returned record right next to the existing `id` merge. graphql-js's `defaultFieldResolver` does a plain object key lookup per field (there's no per-field resolver map for object types here — only root query fields have explicit resolvers, via `DTOFactory`), so a `.graphql` type opts in just by declaring `createdAt: String` — no resolver code needed. Omit the field and it's never selectable. `deleted` is not exposed in GraphQL; search results already exclude deleted/superseded versions.

Don't widen this: no other Envelope field (`authorized_tokens`, etc.) should ever leak into a REST body or an unopted GraphQL field.

## Naming and layout conventions

| Thing | Convention | Example (from `examples/farm/`) |
|---|---|---|
| Graphlette path | `/<entity>/graph` (snake_case entity) | `/lay_report/graph` |
| Restlette path | `/<entity>/api` | `/lay_report/api` |
| Collection/table name | singular, kebab-cased with a prefix/env | `${PREFIX}-${ENV}-hen` |
| Foreign key in payload | snake_case `<parent>_id` | `farm_id`, `coop_id`, `hen_id` |
| GraphQL schema file | `config/graph/<entity>.graphql` | `config/graph/hen.graphql` |
| JSON Schema file | `config/json/<entity>.schema.json` | `config/json/hen.schema.json` |
| Query names | generic dialect by default | `getById`, `getByName`, `getBy<Parent>` |

Unlike the Rust/Java ports, meshobj's real examples don't split an "entity-named" vs "generic" query dialect — `getById`/`getByName`/`getBy<Parent>` (e.g. `getByFarm`, `getByCoop`, `getByHen`) is simply what the codebase already uses everywhere. Stay consistent with it unless you have a specific reason not to.

JSON Schemas may carry a `faker` keyword on properties (e.g. `"faker": "person.firstName"`) — `ajv.addKeyword('faker')` (`core/restlette/src/validation.ts`) makes AJV ignore it for validation; it's read separately by test-data generators. It's a convention for this repo's example/test data, not a framework requirement.

## Minimal entity wiring: HOCON, not a code builder

**Structural note:** unlike meshql-rs (a `main.rs` you compile) or meshql-java (a `Main.java` builder), a meshobj deployment is **configured, not composed in code**. The unit of wiring is a HOCON `.conf` file parsed at startup by `@pushcorn/hocon-parser`; there is no fluent builder API to call. From `examples/farm/config/config.conf` (trimmed):

```hocon
{
  port = ${?PORT}

  farmDB = {
    type = "mongo"
    uri = ${?MONGO_URI}
    db = ${?PREFIX}_${?ENV}
    collection = ${?PREFIX}-${?ENV}-farm
    options { directConnection = true }
  }

  graphlettes = [
    {
      path = "/farm/graph"
      storage = ${farmDB}
      schema = include file(graph/farm.graphql)
      rootConfig {
        singletons = [
          { name = "getById", query = "{\"id\": \"{{id}}\"}" }
        ]
        vectors = []
        resolvers = [
          { name = "coops", queryName = "getByFarm", url = "http://farm:"${port}"/coop/graph" }
        ]
      }
    }
  ]

  restlettes = [
    {
      path = "/farm/api"
      storage = ${farmDB}
      schema = include file(json/farm.schema.json)
    }
  ]
}
```

The Node entry point (`examples/farm/index.ts`) just parses this file and hands it to the framework:

```typescript
const config: Config = await parser.parse({ url: configFile });
const app = await init(config, { mongo: new MongoPlugin() });
await app.listen(config.port);
```

`init()` (`core/server/src/server.ts`) walks `config.graphlettes` and `config.restlettes`, looks up each entry's `storage.type` in the `plugins` map passed in, and builds the graphlette/restlette routes on a returned Express `Application`. **Composition happens by which `Plugin`s you pass into `init()`** (the `{ mongo: new MongoPlugin() }` map), not by which crates you `import`/`Cargo.toml`-depend-on — closer to registering drivers than to Rust's crate-level composition. Because `init()` returns a plain `Application`, the caller can still mount extra routes on it before calling `.listen()` (`examples/farm/index.ts` does this to add `/manifest`) — that's the escape hatch for anything the HOCON shape doesn't cover.

Query templates are **Handlebars producing a JSON query**: `{"payload.farm_id": "{{id}}"}` for Mongo (`repos/mongo_repo`), a SQL fragment for SQL adapters. Top-level payload paths are adapter-specific (Mongo prefixes with `payload.`; SQL adapters typically don't); the special key `id` always addresses the Envelope id.

## Deployment model: Lerna/Yarn monorepo + Plugin composition

- **Lerna + Yarn workspaces**, three top-level directories (`meshobj/CLAUDE.md`'s "Monorepo Structure"): `core/` (framework: server, cli, graphlette, restlette, cert, auth variants), `repos/` (storage plugins: `sqlite_repo`, `mongo_repo`, `postgres_repo`, `mysql_repo`), `examples/` (deployable apps: `farm`, `farm-bun`, `farm-cqrs`, `twofarms`, `events`).
- **A datastore is a package implementing `Plugin`** (`createRepository`, `createSearcher`, `cleanup` — `core/server/src/plugin.ts`), published as its own `repos/<name>_repo` workspace package. Adding DynamoDB/CouchDB/Redis support means a new `repos/<name>_repo` package, not a change to core.
- **The CLI (`@tailoredshapes/meshql-cli`) is the reference composition point**: `core/cli/src/cli.ts` imports every known `Plugin` and passes a `{ sql, mongo, mysql, postgres }` map into `init(config, plugins)`; the HOCON's `storage.type` string picks which one a given graphlette/restlette uses. An app doesn't need the CLI — `examples/farm/index.ts` calls `init()` directly with just the plugin(s) it needs (`{ mongo: new MongoPlugin() }`) — but either way, "what backends this deployment can use" is decided by which `Plugin` instances you hand to `init()`.
- **`yarn build`/`yarn qb`, `yarn test`/`yarn qt`** at the repo root build/test all workspaces (or only what changed since `main`). Each package also has its own `package.json` scripts.
- **Do not propose a runtime plugin-loading scheme beyond this.** The `Plugin` map handed to `init()` already *is* the extension point; there's no need for dynamic `require()`/dlopen-style loading on top of it.

## Decision guide

- **Adding/changing an entity or query** → read `references/adding-an-entity.md`
- **Relating entities (1:1, 1:N), cross-service resolvers** → read `references/federation.md`
- **New datastore Plugin, or touching Repository/Searcher internals** → read `references/storage-adapters.md`
- **Modeling a domain** (the pattern meshql is built for): identify **events** first (immutable facts), derive **projections** (domain models) from them, and put a CDC-driven **worker** (a small Node/KafkaJS consumer, à la `examples/events/src/processor.ts`) between them. Front ends write events, never domain models — and new domains can be built by replaying history. Full methodology in `references/domain-design.md`. `examples/events/` is the worked reference (Debezium + Kafka CDC pipeline); `examples/farm-cqrs/` shows a read-service/write-service split; `examples/farm/` is the minimal non-event-sourced case.
- **Custom validation**: JSON Schema via AJV (`core/restlette/src/validation.ts`, `ajv-formats`) is the only built-in write-time check — there's no defaults-merge or post-create-side-effect hook in `Crud` today. If you need one, mount extra Express routes/middleware on the `Application` returned by `init()`, or wrap the `Repository` your `Plugin` constructs. Don't put business rules inside a `Plugin`'s Repository/Searcher implementation itself (see `references/storage-adapters.md`).
- **Auth beyond the default**: `JWTSubAuthorizer` (`core/jwt_auth`) decodes (does not verify — verification is expected to happen at the API gateway/ingress) a JWT's `sub` claim; wrap with `CasbinAuth.create(casbinParams, jwtSubAuthorizer)` (`core/casbin_auth`) for role-based checks. Set `casbinParams` in the HOCON config to enable it.
- **FE needs to know how fresh data is / show a "pending" state** → see "Honesty: as-of freshness" above; add `createdAt: String` to the GraphQL type, nothing else to do.

## Anti-patterns to flag

- A GraphQL query without `at: Float` — breaks temporal uniformity.
- Hard deletes, in-place updates, or reads that don't filter `deleted`.
- A Searcher or Repository query path that skips `authorized_tokens` filtering — and specifically, filtering on any field name other than `authorized_tokens` (see the `mongo_repo`/`authorized_readers` gotcha under invariant 4).
- Business/aggregation logic inside a `repos/*_repo` package — it belongs in restlette-adjacent code (extra Express routes/middleware on the app `init()` returns) or in a projection entity built by a worker.
- Cross-entity joins implemented in a restlette — that's what graphlette resolvers are for.
- A new `Plugin` merged without passing the `core/cert` certification suite.
- A temporal filter using `$lt`/`<` instead of `$lte`/`<=` for "`created_at` at-or-before the requested time" — `mongo_repo`'s `Repository.read` gets this right (`$lte`); its `Searcher.find`/`findAll` use `$lt`, which is a same-millisecond race risk. Match the `$lte` behavior in new code; don't propagate the `$lt` one.
- Runtime dynamic-loading schemes for storage backends beyond passing a `Plugin` map into `init()` (see "Deployment model").

Do **not** flag the following as vulnerabilities in this codebase — `meshobj/CLAUDE.md`'s "Security Architecture & Common Review Pitfalls" documents them as intentional for a service deployed behind an API gateway: `jwt.decode()` without signature re-verification, Handlebars query templates (admin-authored config, not user input), or wildcard CORS. The one *legitimate* item in that section worth carrying over as a real gotcha: a missing null-check on the `jwt.decode()` result in `core/jwt_auth` — defensive-programming issue, not a security hole, but real.
