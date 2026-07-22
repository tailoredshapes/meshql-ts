import * as fs from 'fs';
import * as path from 'path';

/**
 * Builds the deployment manifest (schemas/manifest.schema.json) from
 * config/graph/*.graphql and config/json/*.schema.json. Mirrors
 * meshql-rs's examples/egg-economy/src/manifest.rs: reads the config
 * directory directly (not the parsed HOCON Config object), deterministic
 * (sorted by filename), path convention by construction
 * (/{entity}/graph, /{entity}/api).
 */
export function generate(configDir: string): Record<string, any> {
    const graphDir = path.join(configDir, 'graph');
    const jsonDir = path.join(configDir, 'json');

    const graphqlFiles = fs
        .readdirSync(graphDir)
        .filter((f) => f.endsWith('.graphql'))
        .sort();

    const entities: Record<string, any> = {};

    for (const filename of graphqlFiles) {
        const entity = filename.slice(0, -'.graphql'.length);
        const graphqlText = fs.readFileSync(path.join(graphDir, filename), 'utf8');

        const surfaces: Record<string, any> = {
            graph: { kind: 'graphql', path: `/${entity}/graph`, schema: graphqlText },
        };

        const jsonSchemaPath = path.join(jsonDir, `${entity}.schema.json`);
        if (fs.existsSync(jsonSchemaPath)) {
            const jsonSchema = JSON.parse(fs.readFileSync(jsonSchemaPath, 'utf8'));
            surfaces.api = { kind: 'rest', path: `/${entity}/api`, schema: jsonSchema };
        }

        entities[entity] = { surfaces };
    }

    return { meshql: 1, entities, surfaces: {} };
}
