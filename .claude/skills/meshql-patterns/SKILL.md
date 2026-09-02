---
name: meshql-patterns
description: Core architecture patterns for building services with meshql-ts (meshobj). Use when adding entities, endpoints, resolvers, or storage backends; designing GraphQL/JSON schemas; wiring federation via HOCON config; or modeling domains (actors/events/projections) on meshql. Covers Repository/Searcher/Plugin interfaces, Envelope semantics, temporal queries, authorization, and CQRS conventions.
---

# meshql Architecture Patterns (TypeScript / meshobj)

meshql turns every entity into a pair of HTTP surfaces backed by the same store:

- **REST restlette** at `/<entity>/api` — CRUD writes + simple reads, JSON Schema validation (AJV)
- **GraphQL graphlette** at `/<entity>/graph` — rich queries, federation to other entities, point-in-time reads

Everything is stored as an **Envelope**: `{id, payload, created_at, deleted, auth}` (`core/common/src/index.ts`), where `auth` is the auth plugin's opaque mark. Updates append new versions (same `id`, newer `created_at`); deletes set `deleted = true`. Nothing is mutated or hard-deleted. This is what makes temporal queries (`at:` argument) and audit trails free — never break it.

**The pattern meshql is built for** (start here for any non-trivial system): model the domain as **events** (immutable facts) and **projections** (domain models derived from events by **workers**, driven by CDC — Debezium/Kafka in this stack). Front ends write events, never domain models; new domain models can be materialized by replaying history. The invariants below exist to make this sound.

**Before wiring a single entity for a new system, read `references/domain-design.md` in full — not just this summary.** It is not one optional deep-dive among several; it is the file whose own methodology section calls this "the pattern meshql is built for." Skipping it and defaulting to plain CRUD for every entity is the single most common way to misuse this framework, and it's an easy trap: nothing stops a plain-CRUD build from compiling, passing its own tests, or looking finished. If the deployment uses `merkql` anywhere (via the Rust connector+worker sidecar described in `merkql-architecture` — merkql itself is Rust-only), that's a strong signal the entity feeding it is meant to be event-sourced, not a generic swap-in datastore for ordinary mutable state; re-open `domain-design.md` before treating "I picked a storage/CDC mechanism" as a finished design decision.

**A note on `meshql-iron`'s `event-vs-domain-mesh.md`, if you also have that skill loaded:** it says the event/domain split is "a recommended pattern, not a technology requirement" and tells you not to force it onto plain-CRUD entities. That's correct advice *for a frontend consuming an already-built deployment* — you can't and shouldn't invent an event/domain split for a backend someone else already designed as plain CRUD. It is not license to skip the methodology below when *you* are the one designing the backend from scratch. If you're doing both jobs (building the backend and its frontend in the same task), `domain-design.md`'s guidance governs the design decision; `event-vs-domain-mesh.md` governs how you *read* whatever the backend ends up being once it exists.

## Build the product before the platform

**A storage decision never blocks product work.** Adapters are certified interchangeable and swapping storage is a two-line `Plugin` change (invariant 5). **Build against SQLite first.**

The order that works, with the effort to expect when the event storm already exists:

1. **Events and domain** — the entity list, the schemas, the meshes. **Minutes.**
2. **Workers** — one per projection. **Under an hour.**
3. **Config and wiring** — **about three minutes.**
4. **Storage, scale, benchmarks, adapters** — only once a real requirement names them.

**If a plan's Stage 0 is platform work, that is the smell — reorder it.** A recent rebuild spent hours on storage adapters and a contention benchmark and produced 120 KB of planning documents and zero lines of product code, because its plan front-loaded platform work in direct contradiction of the framework's own first guarantee. **Planning documents are not deliverables.** The one written artifact worth producing before code is the event storm (`references/domain-design.md`) — a domain document, not a platform one.

**Localdev default: SQLite + `merkql-connect`** (or SQLite + Debezium if the pipeline is Kafka-based). One meshobj process, one connector process, one worker process, and **no Docker on the SQLite path** — which is the difference between a pipeline you can run and one you keep meaning to. See "Getting events onto the log" below.

## The six invariants

Follow these in every change; they are what the architecture excels at:

1. **CQRS by convention.** Writes go through REST (`POST/PUT/DELETE /<entity>/api`). Reads — especially anything relational or historical — go through GraphQL (`/<entity>/graph`). Don't add write mutations to graphlettes; don't build join logic into restlettes.
2. **Envelopes are immutable versions.** A PUT creates a new Envelope version (`Repository.create` under the hood — `core/restlette/src/crud.ts`'s `update` calls `repo.create`, never an in-place update). A DELETE writes a tombstone (`deleted: true`). Reads return the latest non-deleted version at-or-before the requested time. Never write adapter code that updates a row/document in place or filters without excluding `deleted`.
3. **Temporal everywhere.** Every GraphQL `Query` field takes `at: Float` (epoch millis). The graphlette layer (`core/graphlette/src/graph/subgraph.ts`'s `addTimestampToQuery`) automatically stamps `at` onto every federated subgraph call if the caller didn't supply one, so point-in-time reads stay consistent across a whole federated chain without any per-resolver code. When adding a query, include `at: Float` in the schema and let the Searcher's version-windowing handle it.
4. **The auth plugin owns authorization, and nothing else answers.** A lette turns the request into a `Session` (`Auth.authenticate`); storage asks that session about each envelope (`Session.isAuthorized(operation, envelope)`) and asks it to mark each write (`Session.stamp`). `Envelope.auth` is **opaque** — storage persists it verbatim and never reads it. No `Repository` or `Searcher` method takes credentials, and there is no unset session: work outside a request passes `SystemSession` explicitly. Token rules — the wildcard, empty-mark-means-public, copying the caller's credentials onto a write — live in `TokenSession` (`core/jwt_auth`) and nowhere else. Reimplementing any of them outside the plugin, or adding a helper that answers visibility without asking the session, is the security bug this design exists to prevent. Spec: `core/cert/features/contract/specs/auth-plugin-owns-authorization.md`; certification: `auth_plugin.feature`.
5. **Storage is pluggable, behavior is certified — and the certification *is* the contract.** Datastores only implement the `Plugin` interface (`createRepository`, `createSearcher`, `cleanup` — `core/server/src/plugin.ts`), backed by `Repository` + `Searcher` (`core/common/src/index.ts`). All business behavior lives above these interfaces. A new adapter must pass the shared BDD certification suite (`core/cert`). Choosing a backend is a question of what you already run, what you know, and what you like — **not** of capability: there is no practical difference in behaviour between the implementations, and that is exactly what the certification suite exists to guarantee. The property this buys you is that you can swap the database engine and replay the queue into the new store without any end user noticing a difference. The consequence that matters: **never depend on a storage-engine property the certification does not guarantee.** See `references/storage-adapters.md`, "Don't reach underneath the abstraction."
6. **Pick your scale — one size does not fit all.** The same abstraction deliberately has a lightweight form and a heavier distributed form, and choosing a different implementation for dev/test than for production is *idiomatic*, not a compromise. SQLite for a fast local test; Mongo, Postgres, or MySQL for prod (`repos/sqlite_repo`, `repos/mongo_repo`, `repos/postgres_repo`, `repos/mysql_repo`). Debezium+Kafka for a distributed projection pipeline (`examples/events`); `merkql-connect` onto a merkql topic for a single-node one. The behavior contract (certification, the `Plugin`/`Repository`/`Searcher` interfaces) is identical; only the deployment weight changes. When you see two *certified* ways to run one seam, that is the design working — do not collapse them.

   **What this invariant does not say.** It is not a licence to keep a hand-rolled stand-in for a seam that has a real implementation. The CDC seam is where that went wrong in the sibling ports: the Rust skill's version of this invariant claimed "a poll-based CDC tail in-process; a native change-stream connector in prod" as two implementations of one seam, when only the poller existed and the connector was an intention written in the present tense. The connector now exists — **`merkql-connect`** — and it is a separate process, not an in-process alternative. See "Skills describe what exists".

## Skills describe what exists

This file and every reference under it describe **code that is in the repository now**. Design intent is written in a clearly-marked "not built yet" form — as `domain-design.md`'s "upstream gap" notes do — and **never in the present tense**.

The failure this prevents is cheap to commit and expensive to find. A CDC claim in the sibling skill started as an intention phrased as a description, was repeated into a second document, and by the third nothing distinguished it from working code. Readers — human and agent — then planned against a connector that did not exist. If you are documenting something you are about to build, label it, or do not write it down yet.

## Getting events onto the log: two topologies

Workers consume events from a log. There are exactly **two** valid ways to get committed writes onto that log. Choose once per event meshlette.

### 1. The log is the primary store — no bridge at all

The event mesh's `Repository` writes straight to a log, so the restlette `POST` **is** the append. **meshobj has no such adapter today**, and merkql cannot be one: merkql is an embedded Rust library with no wire protocol, so a TypeScript meshlette cannot be backed by it — see the `merkql-architecture` skill. On this runtime, topology 1 is unavailable; it is described here so you recognise it when reading a Rust deployment's architecture document.

### 2. A database is the primary store — add a connector

The event mesh keeps Postgres, Mongo or SQLite, and a **separate process** replicates each committed write onto the log — Debezium onto a Kafka topic (`examples/events`), or `merkql-connect` onto a merkql topic.

```
front end ──POST──▶ event restlette ──▶ Postgres / Mongo / SQLite
    (TS)                                       │
                                               │ CDC, post-commit
                                               ▼
                               Debezium  /  merkql-connect        ← its own process
                                               │ sole writer
                                               ▼
                                       topic (1 partition)
                                               │
                                     workers (readers)
                                               │
                                               ▼
                       ──POST──▶ projection restlettes ──▶ Postgres/Mongo/SQLite
```

In **both** topologies, projections live in a queryable store and are written **only by their own worker**.

### The rule for picking

> **Does this event meshlette need to keep a database?** No → topology 1 (not available here today). Yes → topology 2.

There is no valid third option. In particular, **never publish from application code**: a "save then emit" hook is a dual write with no shared transaction, and a crash between the commit and the publish loses the event permanently while the row survives (`references/domain-design.md`).

### `merkql-connect` is a Rust crate but not a Rust-only tool

`merkql-connect` is a **standalone deployable**, not a library: `merkql-connect <config.toml>`, run beside the database, configured with TOML. It talks to the database and to merkql and to nothing else — no restlette dependency, no shared process, no in-language API. **What wrote the row is irrelevant to it**, which is why it belongs in a TypeScript deployment's toolbox at all. It is the zero-infrastructure alternative to Debezium+Kafka: no Zookeeper, no Connect cluster, no broker. Full reference: `merkql-connect/README.md` in the `meshql-rs` repo.

It is also what makes merkql's single-writer rule survivable. merkql is single-writer per process and does not detect a second one — the log silently loses records. Because the connector is a separate process, the meshobj service writes only to the database and never touches merkql, and workers are readers. The constraint is satisfied by construction. Four separate builds hit it before the connector existed.

Backends: SQLite, MongoDB, PostgreSQL. No polling anywhere — a Postgres logical replication slot woken by a trigger-emitted `NOTIFY`, a Mongo `watch()` whose resume token is the cursor, inotify on the SQLite database's directory with an ordinary connection as the reader.

**What actually works against a meshobj deployment today** — a description of the code, not the design. **Nothing does yet**, and the reason is small: the connector decodes meshql-rs's envelope column and field names, and meshobj's differ.

| meshobj store | Connector expects | meshobj writes |
|---|---|---|
| Mongo | `createdAt` (BSON date) | `created_at` |
| SQLite | `created_at_ms` (epoch millis) | `created_at` (epoch **seconds**, via `strftime('%s')`) |
| Postgres | `created_at_ms BIGINT`, the auth mark as a JSON string | `created_at TIMESTAMPTZ`, `auth JSONB` |

The gap is a decoder — one function per backend — not a design problem, and the SQLite seconds-vs-millis difference is the one that would corrupt `source.ts_ms` silently rather than fail. **Do not plan around this as though it were done, and do not describe it as available.** Until it is closed, Debezium+Kafka is the working CDC path on this runtime.

Two operational hazards to plan for rather than discover, whichever connector you use:

- **A Postgres replication slot pins WAL** — Debezium's as much as `merkql-connect`'s. The heartbeat exists to stop an *idle* slot filling the disk, which is counterintuitive: the low-traffic deployment is the dangerous one, because the slot only advances when the connector advances it while every other table keeps generating WAL. A **stopped** connector still pins WAL — the heartbeat only runs while it is polling. Retiring a connector means `SELECT pg_drop_replication_slot(...)`, not deleting a config file.
- **SQLite's inotify edge is unavailable on some filesystems**, network mounts especially. `merkql-connect` degrades **loudly** — `NoFeed`, refuse to start — and has deliberately no timer fallback, because a connector that quietly becomes a poller has quietly stopped matching what was deployed.

## Honesty: as-of freshness

The FE should be able to tell how fresh a payload is, so it can show a "pending" state and let the user refresh instead of silently rendering stale data. Envelope metadata stays internal (invariant 2 links `created_at` to versioning, not exposure) except for two deliberate, minimal leaks:

- **REST** (`Crud` in `core/restlette/src/crud.ts`): `create`/`read`/`update` responses carry `X-Meshql-Created-At` (ISO-8601, from `envelope.created_at`) and `X-Meshql-Deleted` (`true`/`false`) headers. The JSON body stays payload-only — these are headers, not body fields. Because `create`/`update` respond with a `303` redirect to the resource URL and `fetch()` follows redirects by default, the headers end up visible on the final response either way (the `read` handler that the redirect lands on sets them too).
- **GraphQL**: every `Searcher.find`/`findAll` implementation (`repos/*/src/*Searcher.ts`) merges `createdAt` (ISO-8601 string) into the returned record right next to the existing `id` merge. graphql-js's `defaultFieldResolver` does a plain object key lookup per field (there's no per-field resolver map for object types here — only root query fields have explicit resolvers, via `DTOFactory`), so a `.graphql` type opts in just by declaring `createdAt: String` — no resolver code needed. Omit the field and it's never selectable. `deleted` is not exposed in GraphQL; search results already exclude deleted/superseded versions.

Don't widen this: no other Envelope field (`auth`, etc.) should ever leak into a REST body or an unopted GraphQL field.

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

### Query templates: the shape is per-adapter, and getting it wrong fails silently

A query template is a Handlebars template **written in the query language of the store behind that searcher** — not a portable JSON dialect. Mongo takes a JSON filter document; the three SQL adapters take a **SQL `WHERE` fragment**, spliced into the searcher's outer template at `{{{filters}}}` (`repos/postgres_repo/src/postgresSearcher.ts:17-29`, `repos/mysql_repo/src/mysqlSearcher.ts:17-39`).

The rule to remember:

> **A payload field is never addressed by its bare name. The Envelope's `id` is top-level everywhere.**

| Adapter | Payload field `name` | Envelope `id` |
|---|---|---|
| `mongo_repo` | `{"payload.name": "{{id}}"}` | `{"id": "{{id}}"}` |
| `postgres_repo` | `payload->>'name' = '{{id}}'` | `id = '{{id}}'` |
| `mysql_repo` | `JSON_UNQUOTE(JSON_EXTRACT(payload, '$.name')) = '{{id}}'` | `id = '{{id}}'` |
| `sqlite_repo` | `json_extract(payload, '$.name') = '{{id}}'` | `id = '{{id}}'` |

Note what the SQL rows actually say: it is **not** that SQL adapters "don't need the prefix" — it is that *you write the JSON extraction yourself*, in that dialect's syntax. A bare `name = '{{id}}'` against any of them is a reference to a **column that does not exist**, since the envelope table's columns are `pk`, `id`, `payload`, `created_at`, `updated_at`, `deleted`, `auth` — every domain field lives *inside* the `payload` JSONB (`repos/postgres_repo/src/postgresRepo.ts:28-36`).

**Every one of these failure modes is quiet.** On Mongo, an unprefixed key addresses a top-level document field that isn't there, so the query matches nothing and **returns an empty list with no error**. On the SQL adapters you get a database error at query time rather than an empty list — noisier, but only if that path is ever exercised.

**A by-id test passes either way**, because `id` is top-level and correct in both the right and the wrong version of a template. So: **always test a vector/list query against data you actually wrote.** A suite that only exercises `getById` will go green over a completely broken set of templates.

**Keep range questions out of templates.** meshobj's SQL adapters *can* express ranges and `OR`, but the sibling ports' event-log adapters (Rust `meshql-merkql`, Java `merksql`/`memory`) are **exact-equality-and-AND only — no ranges, no `OR`, no `ORDER BY`**. Materialising a **bucket field** at fold time — `close_period`, `occurred_on`, `size_band` — and querying it by equality is therefore the portable intersection across every adapter in the family. Treat that as good practice, not a workaround: a projection leaning on Postgres range predicates silently pins itself to Postgres and breaks invariant 5's swap-and-replay property.

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
- **Getting events onto a log (Kafka or merkql)** → "Getting events onto the log: two topologies" above, then `merkql-connect/README.md` (in the `meshql-rs` repo) if merkql is the target.
- **Modeling a domain** (the pattern meshql is built for): identify **events** first (immutable facts), derive **projections** (domain models) from them, and put a CDC-driven **worker** (a small Node/KafkaJS consumer, à la `examples/events/src/processor.ts`) between them. Front ends write events, never domain models — and new domains can be built by replaying history. Full methodology in `references/domain-design.md`. `examples/events/` is the worked reference (Debezium + Kafka CDC pipeline); `examples/farm-cqrs/` shows a read-service/write-service split; `examples/farm/` is the minimal non-event-sourced case.
- **Custom validation**: JSON Schema via AJV (`core/restlette/src/validation.ts`, `ajv-formats`) is the only built-in write-time check — there's no defaults-merge or post-create-side-effect hook in `Crud` today. If you need one, mount extra Express routes/middleware on the `Application` returned by `init()`, or wrap the `Repository` your `Plugin` constructs. Don't put business rules inside a `Plugin`'s Repository/Searcher implementation itself (see `references/storage-adapters.md`).
- **Auth beyond the default**: `JWTSubAuthorizer` (`core/jwt_auth`) decodes (does not verify — verification is expected to happen at the API gateway/ingress) a JWT's `sub` claim; wrap with `CasbinAuth.create(casbinParams)` (`core/casbin_auth`) for role-based checks. Set `casbinParams` in the HOCON config to enable it.
- **FE needs to know how fresh data is / show a "pending" state** → see "Honesty: as-of freshness" above; add `createdAt: String` to the GraphQL type, nothing else to do.

## Anti-patterns to flag

- A GraphQL query without `at: Float` — breaks temporal uniformity.
- Hard deletes, in-place updates, or reads that don't filter `deleted`.
- A Searcher or Repository read path that returns an envelope without asking `session.isAuthorized`, or a write path that persists one without asking `session.stamp` (see invariant 4).
- **A query template written for the wrong adapter** — a Mongo-shaped JSON filter handed to a SQL adapter, or a bare `{"farm_id": "{{id}}"}` against Mongo. The Mongo case fails silently with an empty result set, and a `getById` test still passes. Test a vector query against written data.
- **A range or `OR` baked into a projection's query templates.** meshobj's SQL adapters allow it, but the family's event-log adapters don't; materialise a bucket field at fold time so the projection stays portable.
- Business/aggregation logic inside a `repos/*_repo` package — it belongs in restlette-adjacent code (extra Express routes/middleware on the app `init()` returns) or in a projection entity built by a worker.
- Cross-entity joins implemented in a restlette — that's what graphlette resolvers are for.
- A new `Plugin` merged without passing the `core/cert` certification suite.
- **Depending on an engine property the certification doesn't guarantee** — a physical row id (SQLite `rowid`, Mongo's `_id` ordering), a writer-serialisation guarantee, a native sequence — especially as a CDC cursor or an ordering key. It silently couples the product to one backend and breaks swap-and-replay (invariant 5; `references/storage-adapters.md`).
- Building machinery to reconstruct a total event order before publishing — the Kafka topic's append already defines the order (`references/domain-design.md`, "The queue is the ordering authority").
- A stateful domain refusal reported as a 4xx from AJV validation or admission middleware, discarding the fact that the user tried it. Admission refuses only what's refusable without domain state; the rest is a worker-emitted rejection object (`references/domain-design.md`).
- A temporal filter using `$lt`/`<` instead of `$lte`/`<=` for "`created_at` at-or-before the requested time" — `mongo_repo`'s `Repository.read` gets this right (`$lte`); its `Searcher.find`/`findAll` use `$lt`, which is a same-millisecond race risk. Match the `$lte` behavior in new code; don't propagate the `$lt` one.
- Runtime dynamic-loading schemes for storage backends beyond passing a `Plugin` map into `init()` (see "Deployment model").
- **A second writer on a merkql topic.** merkql is single-writer per process and does not detect a collision; the log silently loses records. Exactly one process appends — the connector — and the meshobj service never touches merkql.
- **A plan whose Stage 0 is platform work** — storage adapters, contention benchmarks, an infrastructure spike — before any event, entity or worker exists. Build the product first; storage is a two-line change.
- **A skill, README or design doc describing something unbuilt in the present tense.** Label it "not built yet" or leave it out. This has already cost real work (see "Skills describe what exists").

Do **not** flag the following as vulnerabilities in this codebase — `meshobj/CLAUDE.md`'s "Security Architecture & Common Review Pitfalls" documents them as intentional for a service deployed behind an API gateway: `jwt.decode()` without signature re-verification, Handlebars query templates (admin-authored config, not user input), or wildcard CORS. The one *legitimate* item in that section worth carrying over as a real gotcha: a missing null-check on the `jwt.decode()` result in `core/jwt_auth` — defensive-programming issue, not a security hole, but real.
