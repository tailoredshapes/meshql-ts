# BDD Test Support

## Database Implementation Requirements

Each database plugin must provide its own Cucumber hooks file that sets up the `TestWorld` with required functions.

### Required Functions

Your hooks file must set these properties on the world:

```typescript
import { Before, After, AfterAll } from '@cucumber/cucumber';
import { TestWorld } from '@meshql-ts/common/test/support/world';

let container: YourDatabaseContainer;
let pools: YourConnectionPool[] = [];

Before(async function(this: TestWorld) {
    // Provide factory functions that the steps will call
    this.createRepository = async () => {
        // Your repository setup logic
        return yourRepository;
    };

    this.createSearcher = async () => {
        // Your searcher setup logic
        return { repository: yourRepo, searcher: yourSearcher };
    };

    this.tearDown = async () => {
        // Your cleanup logic
    };

    // For searcher tests
    this.templates = {
        findById: compile('id = "{{id}}"'),
        findByName: compile('name = "{{id}}"'),
        findAllByType: compile('type = "{{id}}"'),
        findByNameAndType: compile('name = "{{name}}" AND type = "{{type}}"'),
    };
});

After(async function(this: TestWorld) {
    // Per-scenario cleanup
});

AfterAll(async function() {
    // Global cleanup (e.g., stop containers)
});
```

### Example: PostgreSQL

See `packages/postgres_repo/test/support/hooks.ts` for a complete example.

### Running Tests

```bash
# In your database package
yarn test:bdd
```

The common steps are automatically loaded from `@meshql-ts/common/test/steps`.
