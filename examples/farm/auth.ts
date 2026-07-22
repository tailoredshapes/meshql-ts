import * as path from 'path';
import { CasbinAuth } from '@tailoredshapes/meshql-casbin_auth';
import { JWTSubAuthorizer } from '@tailoredshapes/meshql-jwt_auth';
import { Auth } from '@tailoredshapes/meshql-auth';

const RESTLETTE_RESOURCES: Record<string, string> = {
    '/farm/api': 'farm',
    '/coop/api': 'coop',
    '/hen/api': 'hen',
    '/lay_report/api': 'lay_report',
    '/hen_productivity/api': 'hen_productivity',
};

/**
 * Builds one CasbinAuth per farm restlette, each scoped (via withResource)
 * to that restlette's own Casbin object, all sharing a single loaded
 * model.conf/policy.csv. Keyed by restlette path for direct use as
 * meshql-server's init()'s restletteAuthOverrides argument.
 */
export async function buildRestletteAuthOverrides(configDir: string): Promise<Record<string, Auth>> {
    const modelPath = path.join(configDir, 'casbin', 'model.conf');
    const policyPath = path.join(configDir, 'casbin', 'policy.csv');

    const base = await CasbinAuth.create([modelPath, policyPath], new JWTSubAuthorizer());

    const overrides: Record<string, Auth> = {};
    for (const [restlettePath, resource] of Object.entries(RESTLETTE_RESOURCES)) {
        overrides[restlettePath] = base.withResource(resource);
    }
    return overrides;
}
