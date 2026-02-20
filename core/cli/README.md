# @meshql-ts/cli

The configurable server frontend for meshql, providing a command-line interface to run and configure meshql servers with support for multiple database backends and API types.

## Installation

```bash
npm install @meshql-ts/cli
# or
yarn add @meshql-ts/cli
```

## Features

- Multiple database backend support:
  - SQLite
  - MongoDB
  - MySQL
  - PostgreSQL
- GraphQL API endpoints
- REST API endpoints
- HOCON configuration format
- Configurable logging
- Command-line port override

## Usage

### Basic Usage

```bash
npx @meshql-ts/cli --config path/to/config.conf
```

### Command Line Options

- `--config`: Path to the configuration file (default: `config/config.conf`)
- `--port`: Override the port specified in the config file
- `--help`: Show help information

## Configuration

The CLI uses HOCON format for configuration files. Here's a basic structure:

```hocon
{
  "port": 4044,
  "url": ${?PLATFORM_URL},
  "graphlettes": [
    {
      "path": "/example/graph",
      "storage": {
        "type": "sql",  // or "mongo", "mysql", "postgres"
        "uri": "connection_string",
        "collection": ${?PREFIX}${?ENV}collection_name,
      },
      "schema": "path/to/schema.graphql"
    }
  ],
  "restlettes": [
    {
      "path": "/example/api",
      "storage": {
        "type": "sql",
        "uri": "connection_string",
        "collection": ${?PREFIX}${?ENV}collection_name,
      },
      "schema": "path/to/schema.json"
    }
  ]
}
```

## Environment Variables

The following environment variables can be used in the configuration:

- `PLATFORM_URL`: Base URL for the platform
- `PREFIX`: Prefix for collection names
- `ENV`: Environment name for collection names

## Programmatic Usage

You can also use the CLI programmatically in your Node.js applications:

```typescript
import startServer from '@meshql-ts/cli';

// Start the server with a specific config file
const app = await startServer('path/to/config.conf');
```

## Logging

The CLI uses Log4js for logging with the following default configuration:
- Output: stdout
- Default level: debug

## License

MIT

## Author

Tom Marsh 