import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { JSONSchemaValidator } from '@tailoredshapes/meshql-restlette';

const schemaPath = path.resolve(__dirname, '../config/json/hen_productivity.schema.json');

describe('hen_productivity schema', () => {
    it('exists on disk', () => {
        expect(fs.existsSync(schemaPath)).toBe(true);
    });

    it('accepts {henId, totalEggs, lastLaidAt}', async () => {
        const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
        const validate = JSONSchemaValidator(schema);

        const valid = await validate({
            henId: '11111111-1111-1111-1111-111111111111',
            totalEggs: 42,
            lastLaidAt: '2026-07-22T08:00:00.000Z',
        });

        expect(valid).toBe(true);
    });

    it('rejects a payload missing totalEggs', async () => {
        const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
        const validate = JSONSchemaValidator(schema);

        const valid = await validate({
            henId: '11111111-1111-1111-1111-111111111111',
            lastLaidAt: '2026-07-22T08:00:00.000Z',
        });

        expect(valid).toBe(false);
    });
});

describe('hen_productivity.graphql', () => {
    it('exists on disk', () => {
        const graphPath = path.resolve(__dirname, '../config/graph/hen_productivity.graphql');
        expect(fs.existsSync(graphPath)).toBe(true);
    });
});
