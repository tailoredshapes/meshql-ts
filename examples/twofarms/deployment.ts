import { Service, Database, Deployment } from '@tailoredshapes/meshql-deploy';
import * as path from 'path';

// Define the shared MongoDB database
const db = Database.MongoDB('${?MONGO_URI}', '${?PREFIX}_${?ENV}');

// Create services first (without cross-references)
const farm = new Service('farm', 5055)
    .withEnv('PLATFORM_URL', 'http://farm:5055');

const equipment = new Service('equipment', 6066)
    .withEnv('PLATFORM_URL', 'http://equipment:6066')
    .withEnv('FARM_PORT', '5055');

// Now configure endpoints with cross-references
farm
    .graphql(
        '/farm/graph',
        path.join(__dirname, 'schemas/graph/farm.graphql'),
        db,
        'farm',
        (endpoint) => {
            endpoint
                .withSingleton('getById', '{"id": "{{id}}"}')
                .withResolver('coops', equipment, '/coop/graph', 'getByFarm');
        }
    )
    .rest(
        '/farm/api',
        path.join(__dirname, 'schemas/json/farm.schema.json'),
        db,
        'farm'
    );

equipment
    .graphql(
        '/coop/graph',
        path.join(__dirname, 'schemas/graph/coop.graphql'),
        db,
        'coop',
        (endpoint) => {
            endpoint
                .withSingleton('getById', '{"id": "{{id}}"}')
                .withSingleton('getByName', '{"payload.name": "{{id}}"}', 'name')
                .withVector('getByFarm', '{"payload.farm_id": "{{id}}"}')
                .withResolver('farm', farm, '/farm/graph', 'getById', 'farm_id')
                .withResolver('hens', equipment, '/hen/graph', 'getByCoop');
        }
    )
    .rest(
        '/coop/api',
        path.join(__dirname, 'schemas/json/coop.schema.json'),
        db,
        'coop'
    )
    .graphql(
        '/hen/graph',
        path.join(__dirname, 'schemas/graph/hen.graphql'),
        db,
        'hen',
        (endpoint) => {
            endpoint
                .withSingleton('getById', '{"id": "{{id}}"}')
                .withVector('getByName', '{"payload.name": "{{name}}"}')
                .withVector('getByCoop', '{"payload.coop_id": "{{id}}"}')
                .withResolver('coop', equipment, '/coop/graph', 'getById', 'coop_id');
        }
    )
    .rest(
        '/hen/api',
        path.join(__dirname, 'schemas/json/hen.schema.json'),
        db,
        'hen'
    );

// Create the deployment
const deployment = new Deployment([farm, equipment], {
    outputDir: path.join(__dirname, 'generated'),
    dockerContext: '../..',  // From examples/twofarms to repo root
    dockerfile: 'examples/farm/Dockerfile'
})
.withDatabase(db);

// Generate all configuration files
deployment.generate().catch(console.error);
