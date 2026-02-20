# MeshQL: Domain-Driven Service Mesh

MeshQL is a service mesh that auto-generates REST and GraphQL endpoints based on a structured domain model. It supports multiple storage backends and integrates with event-driven architectures.

## Component Overview

```mermaid
graph TD;
    subgraph Client
        Web
        Mobile
        Service
    end

    subgraph PAAS
    subgraph Farm
    RestletteA[RestletteA: Farm API]
    GraphletteA[GraphletteA: Farm Graph]
    end
    subgraph Coop
    RestletteB[RestletteB: Coop API]
    GraphletteB[GraphletteB: Coop Graph]
    end
    subgraph Hen
    RestletteC[RestletteC: Hen API]
    GraphletteC[GraphletteC: Hen Graph]
    end
    end

    subgraph Datastore
    Postgres[PostgreSQL]
    Mongo[MongoDB]
    SQLite[SQLite]
    MySQL[MySQL]
    end

    RestletteA & RestletteB & RestletteC -->|Reads/Writes| Datastore
    Client -->|Requests| Farm & Coop & Hen
```

## Core Packages

MeshQL is composed of several key packages, each serving a specific purpose:

### Main Packages

- [@meshql-ts/cli](packages/cli/README.md) - Command-line interface for running and configuring MeshQL servers
- [@meshql-ts/server](packages/server/README.md) - Core server implementation with GraphQL and REST support
- [@meshql-ts/merminator](packages/merminator/README.md) - Configuration generator from Mermaid diagrams

### Database Plugins

- [@meshql-ts/mongo_repo](packages/mongo_repo/README.md) - MongoDB integration
- [@meshql-ts/postgres_repo](packages/postgres_repo/README.md) - PostgreSQL integration
- [@meshql-ts/mysql_repo](packages/mysql_repo/README.md) - MySQL integration
- [@meshql-ts/sqlite_repo](packages/sqlite_repo/README.md) - SQLite integration

### API Components

- [@meshql-ts/graphlette](packages/graphlette/README.md) - GraphQL endpoint generator and resolver
- [@meshql-ts/restlette](packages/restlette/README.md) - REST API endpoint generator

### Authentication & Authorization

- [@meshql-ts/jwt_auth](packages/jwt_auth/README.md) - JWT-based authentication
- [@meshql-ts/casbin_auth](packages/casbin_auth/README.md) - CASBIN-based authorization

## Basic Operation Flow

```mermaid
sequenceDiagram
    participant Client
    participant RestletteA
    participant Datastore

    Client->>+RestletteA: JSON CRUD Request
    RestletteA->>+Datastore: SQL Query
    Datastore-->>-RestletteA: Query Response
    RestletteA-->>-Client: JSON Response
```

## Core Features

- **Multiple Storage Backends**:
    - MongoDB: Document-based storage with native JSON support
    - PostgreSQL: ACID-compliant relational database with JSON capabilities
    - MySQL: High-performance relational database with JSON support
    - SQLite: Lightweight embedded database for development/testing
- **Temporal Querying**: Query data at specific points in time using timestamps
- **Authentication & Authorization**:
    - JWT-based authentication with subject extraction
    - Fine-grained access control via authorized_tokens
    - CASBIN support for role-based access control (RBAC)
- **GraphQL Features**:
    - Automatic relationship resolution
    - Temporal queries via timestamp arguments
    - Subgraph federation

## Security Architecture

MeshQL is designed to operate as an **internal microservice behind an API gateway** in a Kubernetes or similar container orchestration environment. Understanding this architecture is critical to evaluating its security model.

### Deployment Model

```mermaid
graph LR
    Client[External Client]
    Gateway[API Gateway<br/>Istio/Kong/NGINX]
    MeshQL[MeshQL Services]
    DB[(Databases)]

    Client -->|HTTPS + JWT| Gateway
    Gateway -->|JWT Validation| Gateway
    Gateway -->|Authenticated Request| MeshQL
    MeshQL -->|Authorization Check| MeshQL
    MeshQL -->|Query| DB

    style Gateway fill:#f9f,stroke:#333,stroke-width:4px
```

### Security Boundaries

#### 1. Authentication (API Gateway)
**Responsibility:** The API gateway is the **authentication boundary**
- Validates JWT signatures using public keys/secrets
- Checks token expiration, issuer, and audience
- Rejects invalid or expired tokens
- Only authenticated requests reach MeshQL

#### 2. Authorization (MeshQL)
**Responsibility:** MeshQL services perform **authorization decisions**
- Extract claims from pre-validated JWT tokens (using `jwt.decode()`)
- Check `authorized_tokens` in data envelopes
- Enforce fine-grained access control per resource

### Common Security Questions

#### "Why does JWT auth use `decode()` instead of `verify()`?"

**Answer:** This is correct for the intended architecture.

- **Gateway validates** token signatures - this is the authentication step
- **MeshQL extracts claims** from already-validated tokens - this is the authorization step
- **Benefits:**
  - No redundant cryptographic operations
  - JWT signing secrets stay at the gateway (reduced attack surface)
  - Services don't need key distribution/rotation
  - Better performance across multiple services

**When this matters:** If you deploy MeshQL as a standalone service without a gateway, you should implement JWT verification at the service level or use a proper API gateway.

#### "Are the Handlebars query templates vulnerable to SQL injection?"

**Answer:** No, this is not a SQL injection vulnerability.

- **Query templates** are defined in configuration files by administrators
- **User input** only fills template placeholders (e.g., `{{id}}`)
- Users **cannot control** the template structure itself

**Example:**
```hocon
# Configuration (admin-controlled)
query = "id = '{{id}}'"

# User provides: id = "abc123"
# Result: id = 'abc123' ✅ Safe

# User provides: id = "'; DROP TABLE users; --"
# Result: id = ''; DROP TABLE users; --' ✅ Still safe - treated as literal string
```

**Responsibility:** Administrators must write safe templates (e.g., include proper quotes). This is a configuration responsibility, not a code vulnerability - similar to writing safe Nginx configurations.

#### "Why is CORS set to `origin: '*'`?"

**Answer:** CORS is typically handled at the gateway/ingress level in production.

- The CORS configuration in MeshQL is for development convenience
- In production Kubernetes deployments, the ingress controller or service mesh handles CORS
- If deploying standalone, configure CORS appropriately for your environment

### Trust Model

MeshQL operates on a **zero-trust internal network** model:

1. **External Perimeter:** API Gateway validates all requests
2. **Internal Services:** MeshQL services trust gateway-validated tokens but make independent authorization decisions
3. **Data Layer:** Fine-grained access control via `authorized_tokens` on each resource

### Production Deployment Checklist

- [ ] Deploy behind an API gateway (Istio, Kong, NGINX Ingress, etc.)
- [ ] Configure gateway to validate JWT signatures
- [ ] Configure CORS at the gateway/ingress level
- [ ] Use environment-specific configuration (don't commit secrets)
- [ ] Enable audit logging for access decisions
- [ ] Implement monitoring for authorization failures
- [ ] Review `authorized_tokens` strategy for your data model

## Configuration

### 1. Domain Model

Define your domain using Mermaid class diagrams:

```mermaid
erDiagram
    Farm ||--o{ Coop : contains
    Coop ||--o{ Hen : houses
    Farm {
        string name
        string id
    }
    Coop {
        string name
        string id
        string farm_id
    }
    Hen {
        string name
        string id
        string coop_id
        int eggs
        date dob
    }
```

### 2. Storage Configuration

Configure your preferred storage backend:

```hocon
storage = {
  type = "postgres"  // or "mysql", "mongo", "sql"
  uri = "connection_string"
  collection = "collection_name"
}
```

For detailed configuration options, see the respective database plugin READMEs.

### 3. API Configuration

For detailed API configuration examples, see the [@meshql-ts/server documentation](packages/server/README.md).

## Development

### Prerequisites

- Node.js 18+
- Yarn
- Docker (for running tests)

### Setup

```bash
# Install dependencies
yarn install

# Copy example config
cp config/config.example.conf config/config.conf

# Build all packages
yarn build

# Run tests
yarn test
```

### Testing

MeshQL uses container-based testing for database integrations:

- PostgreSQL tests via testcontainers
- MySQL tests with containerized MySQL 8.0
- MongoDB tests with mongodb-memory-server
- SQLite tests with in-memory database

## API Documentation

Auto-generated OpenAPI documentation is available at `/docs` when running the server.

For detailed GraphQL documentation, visit the GraphQL playground at `/graphql`.

## License

MIT

## Author

Tom Marsh
