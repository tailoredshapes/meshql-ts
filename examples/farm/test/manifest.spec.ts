import { describe, it, expect } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import * as fs from 'fs';
import * as path from 'path';
import { generate } from '../manifest';

const configDir = path.resolve(__dirname, '../config');
const schemaPath = path.resolve(__dirname, '../../../schemas/manifest.schema.json');
const manifestPath = path.join(configDir, 'manifest.json');

describe('manifest conformance', () => {
    it('validates against the published schema', () => {
        const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

        const ajv = new Ajv2020();
        const validate = ajv.compile(schema);
        const valid = validate(manifest);

        expect(valid, JSON.stringify(validate.errors)).toBe(true);
    });

    it('matches fresh regeneration', () => {
        const committed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const generated = generate(configDir);

        expect(committed).toEqual(generated);
    });

    it('has every graph entity present with correct surfaces', () => {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const graphFiles = fs.readdirSync(path.join(configDir, 'graph')).filter((f) => f.endsWith('.graphql'));

        let seen = 0;
        for (const filename of graphFiles) {
            const entity = filename.slice(0, -'.graphql'.length);
            const e = manifest.entities[entity];

            expect(e, `entity '${entity}' missing from manifest`).toBeDefined();
            expect(e.surfaces.graph.kind).toBe('graphql');

            const hasJsonSchema = fs.existsSync(path.join(configDir, 'json', `${entity}.schema.json`));
            if (hasJsonSchema) {
                expect(e.surfaces.api?.kind).toBe('rest');
            } else {
                expect(e.surfaces.api).toBeUndefined();
            }
            seen++;
        }
        expect(seen).toBe(Object.keys(manifest.entities).length);
    });

    it('hen_productivity advertises both graph and api surfaces, same as every other entity', () => {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const productivity = manifest.entities.hen_productivity;

        expect(productivity, 'hen_productivity missing from manifest').toBeDefined();
        expect(productivity.surfaces.graph.kind).toBe('graphql');
        expect(productivity.surfaces.graph.path).toBe('/hen_productivity/graph');
        expect(productivity.surfaces.api.kind).toBe('rest');
        expect(productivity.surfaces.api.path).toBe('/hen_productivity/api');
    });
});
