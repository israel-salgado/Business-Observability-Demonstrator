/**
 * Dynatrace API authorization header — single source of truth.
 *
 * CommonJS on purpose: otel.cjs is loaded via `node --require ./otel.cjs` before the
 * ESM app graph exists, so it cannot import an ESM module. ESM callers use a default
 * import: `import dtAuth from './utils/dt-auth.cjs'`.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 * Only CLASSIC access tokens use the `Api-Token` scheme. Everything else is `Bearer`.
 *
 *   dt0c01.*  classic access token   → "Api-Token <token>"   (legacy)
 *   dt0s16.*  platform token         → "Bearer <token>"
 *   long JWT  OAuth access token     → "Bearer <token>"
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 * This rule was previously duplicated in at least four places, each with a subtly
 * different and now-incorrect test (`token.length > 100 && !token.startsWith('dt0')`),
 * which routed platform tokens to `Api-Token` and produced 401s.
 *
 * Verified empirically 2026-09-03 against a Gen3 sprint tenant. A `dt0s16` platform
 * token carrying the `openpipeline:*:ingest` scopes was accepted with `Bearer` on the
 * EXISTING endpoints, no endpoint changes required:
 *
 *   POST <env>/api/v2/otlp/v1/traces    → 200
 *   POST <env>/api/v2/bizevents/ingest  → 202
 *   POST <env>/api/v2/metrics/ingest    → 202
 *   POST <env>/platform/ingest/v1/events → 202
 *   POST <apps>/platform/storage/query/v1/query:execute → 202
 *
 * Note `<env>` means the host WITHOUT `.apps.`. The same paths on the `.apps.` host
 * return 404. See deriveOtlpBaseUrl() in otel.cjs.
 *
 * Do NOT reintroduce a length-based or `dt0`-prefix-based check. Classic tokens are
 * labelled "classic" in the Dynatrace docs and the OAuth permission picker now carries
 * a "[DEPRECATED] Environment Api" section, so `Bearer` is the forward-looking default.
 */

/** Returns 'Api-Token' or 'Bearer' for the given token. */
function dtAuthScheme(token) {
  return String(token || '').startsWith('dt0c') ? 'Api-Token' : 'Bearer';
}

/** Returns the full Authorization header value, e.g. "Bearer dt0s16.ABC.XYZ". */
function dtAuthHeader(token) {
  const t = String(token || '');
  return `${dtAuthScheme(t)} ${t}`;
}

/** True when the token is a Gen3 platform token. */
function isPlatformToken(token) {
  return String(token || '').startsWith('dt0s16.');
}

/** True when the token is a legacy classic access token. */
function isClassicToken(token) {
  return String(token || '').startsWith('dt0c');
}

module.exports = { dtAuthScheme, dtAuthHeader, isPlatformToken, isClassicToken };
