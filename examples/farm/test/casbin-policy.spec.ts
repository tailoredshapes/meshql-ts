import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { newEnforcer } from 'casbin';

const modelPath = path.resolve(__dirname, '../config/casbin/model.conf');
const policyPath = path.resolve(__dirname, '../config/casbin/policy.csv');

describe('farm casbin policy', () => {
    it('lets anonymous create farm/coop/hen/lay_report', async () => {
        const enforcer = await newEnforcer(modelPath, policyPath);

        for (const resource of ['farm', 'coop', 'hen', 'lay_report']) {
            expect(await enforcer.enforce('anonymous', resource, 'create')).toBe(true);
        }
    });

    it('lets anonymous update/delete farm/coop/hen but not lay_report', async () => {
        const enforcer = await newEnforcer(modelPath, policyPath);

        for (const resource of ['farm', 'coop', 'hen']) {
            expect(await enforcer.enforce('anonymous', resource, 'update')).toBe(true);
            expect(await enforcer.enforce('anonymous', resource, 'delete')).toBe(true);
        }

        expect(await enforcer.enforce('anonymous', 'lay_report', 'update')).toBe(false);
        expect(await enforcer.enforce('anonymous', 'lay_report', 'delete')).toBe(false);
    });

    it('denies anonymous every verb on hen_productivity', async () => {
        const enforcer = await newEnforcer(modelPath, policyPath);

        for (const action of ['create', 'update', 'delete']) {
            expect(await enforcer.enforce('anonymous', 'hen_productivity', action)).toBe(false);
        }
    });

    it('lets the worker role create and update hen_productivity, but not delete', async () => {
        const enforcer = await newEnforcer(modelPath, policyPath);

        expect(await enforcer.enforce('worker', 'hen_productivity', 'create')).toBe(true);
        expect(await enforcer.enforce('worker', 'hen_productivity', 'update')).toBe(true);
        expect(await enforcer.enforce('worker', 'hen_productivity', 'delete')).toBe(false);
    });

    it('resolves the farm-worker-service subject to the worker role via g', async () => {
        const enforcer = await newEnforcer(modelPath, policyPath);
        const roles = await enforcer.getRolesForUser('farm-worker-service');

        expect(roles).toContain('worker');
    });
});
