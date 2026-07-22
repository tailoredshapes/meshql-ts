import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { buildRestletteAuthOverrides } from '../auth';

const configDir = path.resolve(__dirname, '../config');

describe('buildRestletteAuthOverrides', () => {
    it('returns a scoped Auth for every farm restlette path', async () => {
        const overrides = await buildRestletteAuthOverrides(configDir);

        expect(Object.keys(overrides).sort()).toEqual(
            ['/coop/api', '/farm/api', '/hen/api', '/hen_productivity/api', '/lay_report/api'].sort(),
        );
    });

    it('each override is independently resource-scoped', async () => {
        const overrides = await buildRestletteAuthOverrides(configDir);

        const farmAllowsCreate = await overrides['/farm/api'].authorizeAction([], 'create', { payload: {} });
        const layReportDeniesUpdate = await overrides['/lay_report/api'].authorizeAction([], 'update', {
            payload: {},
        });
        const productivityDeniesAnonymousCreate = await overrides['/hen_productivity/api'].authorizeAction(
            [],
            'create',
            { payload: {} },
        );

        expect(farmAllowsCreate).toBe(true);
        expect(layReportDeniesUpdate).toBe(false);
        expect(productivityDeniesAnonymousCreate).toBe(false);
    });
});
