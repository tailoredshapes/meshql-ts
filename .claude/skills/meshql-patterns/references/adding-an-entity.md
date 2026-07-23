# Adding an Entity

The complete checklist for adding entity `widget` (with a `parent_id` relation to `parent`). Reference implementation: `examples/farm/` (minimal, 4 entities, single Mongo backend) and `examples/farm-cqrs/` (same domain, split read-service/write-service HOCON files).

## 1. GraphQL schema — `config/graph/widget.graphql`

```graphql
scalar Date

type Query {
    getById(id: ID, at: Float): Widget
    getByName(name: String, at: Float): Widget
    getByParent(id: ID, at: Float): [Widget]
}

type Widget {
    id: ID
    name: String!
    parent: Parent
}

# Local view of the federated type: declare only the fields this
# graphlette exposes. Each graphlette owns its own schema file.
type Parent {
    id: ID
    name: String
}
```

Rules:
- **Every** query takes `at: Float` (epoch millis, point-in-time read). The graphlette layer auto-stamps `at` onto federated subgraph calls that omit it (`core/graphlette/src/graph/subgraph.ts`), so a caller only has to supply it at the top of a query — but the schema field must still declare it or the argument has nowhere to go.
- **Optional:** add `createdAt: String` to a type to opt into the "honesty" as-of field — every `Searcher.find`/`findAll` already merges it into the returned record (ISO-8601, next to `id`), so declaring the field is all that's needed; no resolver code. Omit it and it's simply not selectable. (REST gets the equivalent via `X-Meshql-Created-At`/`X-Meshql-Deleted` response headers automatically — see SKILL.md.)
- Query naming: `getById`/`getByName`/`getBy<Parent>` is the convention every real example in this repo uses (see SKILL.md's naming table) — don't invent an entity-named dialect (`getWidget`) unless you have a specific reason to diverge.
- Federated fields (`parent: Parent`) get a local type definition with just the fields you want reachable from this entity. One level of nesting is the norm.

## 2. JSON Schema — `config/json/widget.schema.json`

```json
{
    "type": "object",
    "additionalProperties": false,
    "required": ["name", "parent_id"],
    "properties": {
        "id": {
            "type": "string",
            "format": "uuid"
        },
        "name": {
            "type": "string"
        },
        "parent_id": {
            "type": "string",
            "format": "uuid"
        }
    }
}
```

This validates the REST write payload via AJV (`core/restlette/src/validation.ts`, with `ajv-formats` for `format: "uuid"` etc). It describes the **payload** only — never include `created_at`, `deleted`, or `authorized_tokens`; those are Envelope metadata managed by the framework. `id` can appear (the real examples include it) since a client may supply its own UUID on create, but it's optional. `additionalProperties: false` is the convention in every shipped example — keep it unless you have a reason to allow extra fields. A property may also carry a `"faker": "..."` keyword (e.g. `"faker": "person.firstName"`) — AJV is told to ignore it (`ajv.addKeyword('faker')`) and it's read separately by test-data generators; it's not required.

## 3. Wire it into `config.conf` (HOCON)

```hocon
{
  port = ${?PORT}

  widgetDB = {
    type = "mongo"
    uri = ${?MONGO_URI}
    db = ${?PREFIX}_${?ENV}
    collection = ${?PREFIX}-${?ENV}-widget
    options { directConnection = true }
  }

  graphlettes = [
    # ...existing entries...
    {
      path = "/widget/graph"
      storage = ${widgetDB}
      schema = include file(graph/widget.graphql)
      rootConfig {
        singletons = [
          { name = "getById", query = "{\"id\": \"{{id}}\"}" },
          { name = "getByName", query = "{\"payload.name\": \"{{name}}\"}" }
        ]
        vectors = [
          { name = "getByParent", query = "{\"payload.parent_id\": \"{{id}}\"}" }
        ]
        resolvers = [
          {
            name = "parent"
            id = "parent_id"
            queryName = "getById"
            url = "http://<host>:"${port}"/parent/graph"
          }
        ]
      }
    }
  ]

  restlettes = [
    # ...existing entries...
    {
      path = "/widget/api"
      storage = ${widgetDB}
      schema = include file(json/widget.schema.json)
    }
  ]
}
```

Notes:
- `storage` blocks are just named HOCON fragments (`${widgetDB}`) referenced from both the graphlette and restlette entries for the same entity — they usually point at the same collection/table.
- `query` strings are Handlebars text that render to a JSON query object. For Mongo (`repos/mongo_repo`), payload fields are addressed as `"payload.<field>"`; `"id"` addresses the Envelope id directly. SQL adapters (`repos/postgres_repo`, `repos/mysql_repo`, `repos/sqlite_repo`) use SQL fragments instead — check the adapter you're targeting.
- `singletons` return one object (`Widget`), `vectors` return a list (`[Widget]`) — this must match the schema's return type for that query name.
- If `widget` is the *target* of a relation (i.e. some other entity's schema needs a `widget`/`widgets` field), add the reverse query (`getByParent`-style, on `widget`'s own `rootConfig`) and a resolver entry on the *other* entity's `rootConfig`. See `references/federation.md` for the full checklist — the resolver and the query it targets live on different entities' configs, which is the most common thing to get half-wired.

## 4. What you get for free

- `POST/GET/PUT/DELETE /widget/api[/:id]`, plus `GET /widget/api/bulk` and `POST /widget/api/bulk`, with schema validation, soft delete, versioning, and Swagger docs at `/widget/api/api-docs` (`core/restlette`).
- `POST /widget/graph` GraphQL with temporal reads and federation (`core/graphlette`).
- `GET /widget/api/health` and `/widget/api/ready` liveness/readiness endpoints, plus aggregate `/health` and `/ready` at the app root (`core/server/src/health.ts`).
- Authorization filtering on every read, via the `Auth` passed through `init()`.
- `X-Meshql-Created-At`/`X-Meshql-Deleted` response headers on REST `create`/`read`/`update` — the "honesty" as-of fields, automatic, no config needed.

## 5. Validation — and the gap where Rust/Java have more

The only built-in write-time hook is JSON Schema validation (`JSONSchemaValidator`, AJV). There is **no** `defaults`-merge or `post_create` side-effect mechanism in `Crud` (`core/restlette/src/crud.ts`) today — unlike meshql-rs's `build_restlette_router_ext`. If a write needs business rules or a downstream effect:

- Mount an extra Express route/middleware on the `Application` that `init()` returns, ahead of or alongside the generated restlette router (`examples/farm/index.ts`'s `mountManifestRoute(app, ...)` is the existing pattern for "add a route after `init()`").
- Or wrap the `Repository`/`Searcher` your `Plugin` constructs to inject the behavior at the storage boundary — but keep that wrapper outside the adapter package itself (see `references/storage-adapters.md`'s "what does NOT belong in an adapter").

Don't invent a config key for this that the HOCON schema (`core/server/src/configTypes.ts`) doesn't define — `ConfigSchema`/`GraphletteSchema`/`RestletteSchema` are the source of truth for what a `.conf` file can express.

## 6. Verify

```bash
yarn build          # or: yarn qb (only changed packages)
yarn test           # or: yarn qt (only changed packages)
```

Smoke test: `POST /widget/api` a payload, then query `getById(id: "...")` and `getById(id: "...", at: <past-millis>)` on `/widget/graph` to confirm temporal behavior. `examples/farm/test/features/farm.feature` is a worked Cucumber example of this style of check.
