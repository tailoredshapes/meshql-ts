# Farm Management System - A Modular Monolith Example

This example demonstrates how to use the meshql-ts library to build a modular monolith architecture that seamlessly integrates multiple databases while maintaining clean service boundaries. It implements a farm management system where different aspects of the farm are stored in different databases, yet work together cohesively through a unified GraphQL API.

## Architecture Overview

The system is built as a modular monolith with three main domains:

- **Farms** (MongoDB) - Manages farm entities and their relationships
- **Coops** (PostgreSQL) - Handles chicken coop management and organization
- **Hens** (MySQL) - Tracks individual hens and their egg production

Each domain maintains its own:

- Database storage
- REST API endpoints
- GraphQL schema
- Data validation rules

### Key Features

- **Polyglot Persistence**: Demonstrates how different data stores can be used for different domains based on their specific needs
- **Unified GraphQL API**: Seamlessly queries across all three domains
- **REST API Support**: Each domain exposes its own REST endpoints with Swagger documentation
- **Modular Configuration**: Uses HOCON for flexible, hierarchical configuration
- **Docker Ready**: Includes Docker and docker-compose setup for easy deployment

## Getting Started

### Prerequisites

- Docker and docker-compose
- Node.js 16+
- npm or yarn

### Running the Application

1. Start the services:

    ```bash
    docker-compose up
    ```

2. The following endpoints will be available:
    - GraphQL Endpoints:
        - Farms: http://localhost:3033/farm/graph
        - Coops: http://localhost:3033/coop/graph
        - Hens: http://localhost:3033/hen/graph
    - REST API Documentation:
        - Farms: http://localhost:3033/farm/api/api-docs
        - Coops: http://localhost:3033/coop/api/api-docs
        - Hens: http://localhost:3033/hen/api/api-docs

### Running Tests

```bash
npm test
```

## Example Queries

### Query a Farm and its Related Data

```graphql
{
    getById(id: "farm-id") {
        name
        coops {
            name
            hens {
                name
                eggs
            }
        }
    }
}
```

### Create a New Coop

```graphql
mutation {
    create(input: { name: "Red Coop", farm_id: "farm-id" }) {
        id
        name
    }
}
```

## Architecture Details

### Database Choice Rationale

- **Farms (MongoDB)**

    - Flexible schema for varying farm types
    - Document-based storage for complex hierarchical data
    - Excellent for querying nested farm structures

- **Coops (PostgreSQL)**

    - Structured data with relationships
    - Strong ACID compliance for coop management
    - Robust querying capabilities for location-based operations

- **Hens (MySQL)**
    - High-performance for frequent updates (egg counting)
    - Strong consistency for inventory tracking
    - Efficient for simple CRUD operations

### Integration Pattern

The system uses a unique approach to service integration:

1. Each domain maintains its own database and service layer
2. GraphQL resolvers handle cross-service communication
3. The configuration system (`config.conf`) defines:
    - Service endpoints
    - Database connections
    - GraphQL resolvers
    - REST API endpoints

## Development

### Project Structure

```
examples/farm/
├── config/
│   ├── graph/          # GraphQL schemas
│   ├── json/           # JSON schemas for REST APIs
│   └── config.conf     # Main configuration file
├── test/               # Integration tests
├── docker-compose.yml  # Container orchestration
└── Dockerfile         # Service container definition
```

### Adding New Features

1. Define the schema in `config/json/`
2. Add GraphQL types in `config/graph/`
3. Configure the service in `config.conf`
4. Update tests in `test/`

## Testing

The project includes a simple smoke test that:

- Spin up the entire system using testcontainers
- Verify cross-service communication
- Test data consistency across databases
- Validate GraphQL resolvers
