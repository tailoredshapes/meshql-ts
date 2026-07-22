import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { JSONSchemaValidator } from '@tailoredshapes/meshql-restlette';

const schema = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../config/json/lay_report.schema.json'), 'utf8'),
);
const validate = JSONSchemaValidator(schema);

describe('lay_report schema', () => {
    it('accepts the new {henId, eggs, timeOfDay} shape', async () => {
        const valid = await validate({
            henId: '11111111-1111-1111-1111-111111111111',
            eggs: 2,
            timeOfDay: 'morning',
        });
        expect(valid).toBe(true);
    });

    it('rejects the old {hen_id, time_of_day, eggs} shape', async () => {
        const valid = await validate({
            hen_id: '11111111-1111-1111-1111-111111111111',
            eggs: 2,
            time_of_day: 'morning',
        });
        expect(valid).toBe(false);
    });
});
