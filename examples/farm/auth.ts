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
 *
 * KNOWN LIMITATION, found during code review and not yet fixed: writes
 * through these overrides store `envelope.authorized_tokens` from
 * `CasbinAuth.getAuthToken()`, which returns resolved Casbin ROLES (e.g.
 * "worker", or "anonymous"/[] for an unmapped subject) -- not the raw JWT
 * `sub`. Reads go through a graphlette's plain `JWTSubAuthorizer` (the
 * server's shared default `auth`, unaffected by this override map), which
 * resolves credentials as the raw `sub`. The two never overlap, so an
 * authenticated writer can never read their own record back via GraphQL
 * (their role never matches their own sub), while an anonymous reader
 * bypasses the check entirely (empty authorized_tokens = open to
 * everyone) -- backwards from intent. Separately, any authenticated
 * caller whose sub isn't mapped to a Casbin role gets authorized_tokens
 * = [] on write (getRolesForUser returns [] for an unmapped subject),
 * which silently widens that record's visibility to "open to everyone"
 * instead of self-scoped to that caller, contradicting how this behaved
 * before Casbin was wired in. A real fix needs CasbinAuth to separate
 * RBAC role resolution (used only by authorizeAction's internal
 * enforce() call) from the raw identity value used for
 * authorized_tokens/ABAC ownership -- that's a design change to
 * CasbinAuth itself (see core/casbin_auth/src/index.ts), not something
 * to improvise here. Currently low blast radius: nothing in this
 * codebase mints a JWT for any real caller yet (the "worker" role is
 * itself unreachable for the same reason -- see the merkql-worker-
 * pipeline companion spec), so this only bites once real authentication
 * exists.
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
