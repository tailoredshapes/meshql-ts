import { describe, it, expect } from 'vitest';
import { NoOp } from '../src';
import { Envelope } from '@tailoredshapes/meshql-common';

describe('NoOp', () => {
    it('authorizes every action for every credential', async () => {
        const auth = new NoOp();
        const envelope: Envelope = { payload: {} };

        expect(await auth.authorizeAction([], 'create', envelope)).toBe(true);
        expect(await auth.authorizeAction(['anyone'], 'update', envelope)).toBe(true);
        expect(await auth.authorizeAction(['anyone'], 'delete', envelope)).toBe(true);
    });
});
