/**
 * Mints bearer tokens for the certification suites.
 *
 * These are **unsecured JWTs** — RFC 7519 §6, `alg: "none"` with an empty
 * signature — and that is not a shortcut. meshql never verifies a signature:
 * the gateway authenticates and meshql authorizes (see CLAUDE.md, "JWT Token
 * Handling"), so `JWTSubAuthorizer` reads the `sub` claim and nothing else.
 * A token signed with a real key and one signed with none travel through this
 * codebase along exactly the same path, so an unsecured token is a *faithful*
 * test fixture rather than a weakened one.
 *
 * Minting them here rather than with a library removes `jsonwebtoken` from the
 * repository entirely. It was only ever used to `decode` in production and to
 * `sign` in tests, and it drags in `buffer-equal-constant-time`, which uses the
 * long-removed `SlowBuffer` and throws on load under current Node — so the
 * whole chain was dead on anything past Node 20.
 *
 * If optional signature verification is ever added, this is the helper that
 * has to change: tests would then need genuinely signed tokens, which is the
 * point at which a library (`jose`) earns its place.
 */
function segment(value: unknown): string {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/**
 * A well-formed bearer token carrying `sub` and whatever else is supplied.
 * `expiresIn` is accepted for parity with what the suites used to pass; nothing
 * in meshql reads `exp`, because nothing validates claims.
 */
export function unverifiedToken(sub: string, claims: Record<string, unknown> = {}): string {
    const now = Math.floor(Date.now() / 1000);
    const header = segment({ alg: 'none', typ: 'JWT' });
    const payload = segment({ sub, iat: now, exp: now + 3600, ...claims });
    return `${header}.${payload}.`;
}
