# @meshql-ts/server

The core server implementation for meshql-ts, providing a flexible and configurable Express-based server that combines GraphQL and REST APIs with multiple database backends.

## Features

- Unified GraphQL and REST API server
- Multiple database backend support through plugins
- Configurable authentication and authorization
- CORS support
- Automatic schema validation
- Flexible routing
- Query resolution across API boundaries

## Installation

```bash
npm install @meshql-ts/server
# or
yarn add @meshql-ts/server
```

## Usage

### Basic Setup

```typescript
import { init } from '@meshql-ts/server';
import { SQLitePlugin } from '@meshql-ts/sqlite_repo';
import { MongoPlugin } from '@meshql-ts/mongo_repo';
import { MySQLPlugin } from '@meshql-ts/mysql_repo';
import { PostgresPlugin } from '@meshql-ts/postgres_repo';

const config = {
  port: 4044,
  graphlettes: [...],
  restlettes: [...]
};

const plugins = {
  sql: new SQLitePlugin(),
  mongo: new MongoPlugin(),
  mysql: new MySQLPlugin(),
  postgres: new PostgresPlugin()
};

const app = await init(config, plugins);
app.listen(config.port);
```

## Configuration

The server accepts a configuration object that defines both GraphQL and REST endpoints:

```typescript
interface Config {
  port: number;
  url?: string;
  casbinParams?: string[];
  graphlettes: Graphlette[];
  restlettes: Restlette[];
}
```

### GraphQL Endpoints (Graphlettes)

Each GraphQL endpoint is configured with:

```typescript
interface Graphlette {
  path: string;           // API endpoint path
  storage: StorageConfig; // Database configuration
  schema: string;         // GraphQL schema
  rootConfig: {
    singletons: Array<{   // Single-result queries
      name: string;
      query: string;
    }>;
    vectors: Array<{      // Multi-result queries
      name: string;
      query: string;
    }>;
    resolvers: Array<{    // Cross-service resolvers
      name: string;
      queryName: string;
      url: string;
    }>;
  };
}
```

### REST Endpoints (Restlettes)

REST endpoints are configured with:

```typescript
interface Restlette {
  path: string;           // API endpoint path
  storage: StorageConfig; // Database configuration
  schema: object;         // JSON Schema for validation
  tokens?: string[];      // Optional auth tokens
}
```

### Storage Configuration

Database connections are configured through the storage config:

```typescript
interface StorageConfig {
  type: string;      // Database type (sql, mongo, mysql, postgres)
  uri: string;       // Connection URI
  collection: string; // Collection/table name
}
```

## Plugins

The server uses a plugin system for database support. Each plugin must implement:

```typescript
interface Plugin {
  createRepository: (config: StorageConfig) => Promise<Repository>;
  createSearcher: (config: StorageConfig, dtoFactory: DTOFactory, auth: Auth) => Promise<Searcher>;
  cleanup: () => Promise<void>;
}
```

## Authentication & Authorization

The server supports:
- JWT-based authentication
- Casbin-based authorization
- Custom auth plugins

Configure authentication through the config object and appropriate middleware.

## CORS

CORS is enabled by default with the following configuration:
- All origins allowed (`*`)
- Methods: GET, POST, PUT, DELETE, OPTIONS
- Headers: Content-Type, Authorization

Customize CORS settings by modifying the server initialization.

## Example Configuration

```hocon
{
  "port": 4044,
  "graphlettes": [
    {
      "path": "/api/graph",
      "storage": {
        "type": "sql",
        "uri": "connection_string",
        "collection": "collection_name"
      },
      "schema": "./schema.graphql",
      "rootConfig": {
        "singletons": [
          {
            "name": "getById",
            "query": "{\"id\": \"{{id}}\"}"
          }
        ],
        "vectors": [],
        "resolvers": []
      }
    }
  ],
  "restlettes": [
    {
      "path": "/api/rest",
      "storage": {
        "type": "sql",
        "uri": "connection_string",
        "collection": "collection_name"
      },
      "schema": {
        // JSON Schema definition
      }
    }
  ]
}
```

## License

MIT

## Author

Tom Marsh 