import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { JSONSchemaValidator } from '@tailoredshapes/meshql-restlette';

const schema = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../config/json/hen.schema.json'), 'utf8'));
const validate = JSONSchemaValidator(schema);

describe('hen schema', () => {
    it('has no eggs property', () => {
        expect(schema.properties.eggs).toBeUndefined();
    });

    it('rejects a payload carrying the legacy eggs field', async () => {
        const valid = await validate({ name: 'chuck', eggs: 6 });
        expect(valid).toBe(false);
    });

    it('still accepts a hen payload without eggs', async () => {
        const valid = await validate({ name: 'chuck', coop_id: '11111111-1111-1111-1111-111111111111' });
        expect(valid).toBe(true);
    });
});
