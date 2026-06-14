---
title: Sakrylle Image Local Integration
status: local
scope: product-local
canonical_source: ../../sub2api/sakrylle-docs/10-platform-identity/rp-integration-guide.md
last_verified: 2026-06-06
---

# Sakrylle Image Local Integration

This page summarizes only the repository-local OIDC/Sakrylle integration concerns for **Sakrylle Image**.

For protocol details, use the canonical [RP integration guide](../../sub2api/sakrylle-docs/10-platform-identity/rp-integration-guide.md). For current Sakrylle API/OIDC Provider capability, use [current-state.md](../../sub2api/sakrylle-docs/10-platform-identity/current-state.md).

## Local focus areas

- `VITE_SAKRYLLE_OAUTH_BASE`, `VITE_SAKRYLLE_OAUTH_CLIENT_ID`, `VITE_SAKRYLLE_OIDC_ENABLED`
- runtime env injection and deployment feature flag behavior
- OAuth fallback scoped to official Sakrylle API base
- localStorage token risk and SPA-only id_token handling limits
- OIDC discovery, id_token parsing, nonce handling, refresh, revoke, logout
- Images/Responses group routing and group-specific model listing
- production gray rollout and rollback notes for Image

## Runtime configuration

The source code reads Vite-style variables:

- `VITE_DEFAULT_API_URL`
- `VITE_SAKRYLLE_OAUTH_BASE`
- `VITE_SAKRYLLE_OAUTH_CLIENT_ID`
- `VITE_SAKRYLLE_OIDC_ENABLED`
- `VITE_SAKRYLLE_OIDC_ISSUER`

Docker production images bake placeholders into the bundle and replace them at container startup. Runtime container env names are intentionally shorter:

| Runtime env | Meaning | Default |
|---|---|---|
| `DEFAULT_API_URL` | User-visible default API base URL | `https://api.sakrylle.com/v1` |
| `OAUTH_BASE` | Non-OIDC fallback OAuth base (OIDC paths resolve endpoints from discovery) | `https://oidc1.sakrylle.com` |
| `OAUTH_CLIENT_ID` | OAuth/OIDC RP client id | `sakrylle-image-playground` |
| `OIDC_ENABLED` | OIDC feature flag string; only `true` enables OIDC | `false` |
| `OIDC_ISSUER` | OIDC issuer / discovery base (decoupled from `OAUTH_BASE`) | `https://oidc1.sakrylle.com` |

Do not confuse Docker runtime names with Vite source variable names. In Compose, set `OIDC_ENABLED=true`; setting `VITE_SAKRYLLE_OIDC_ENABLED=true` alone will not be consumed by the runtime entrypoint.

## OAuth/OIDC callback behavior

- Redirect URI is `${window.location.origin}/oauth/callback`, with SSR fallback `https://image.sakrylle.com/oauth/callback`.
- PKCE verifier, CSRF state, and OIDC nonce are session-scoped storage values.
- With `OIDC_ENABLED=true`, authorize requests include `openid profile email` plus the Image v2 API scopes.
- Callback handling exchanges the authorization code at the Discovery token endpoint when OIDC is enabled.
- `id_token` payloads are decoded without browser-side signature verification. They enrich local identity display only; API authorization remains server-side.
- `/v1/me` remains the source of live balance, allowed groups, current group, and capability data.

## Refresh and group routing

- Regular refresh and `refreshWithGroupId(groupId)` use the Discovery `token_endpoint` when OIDC is enabled, otherwise `${OAUTH_BASE}/oauth/token`.
- OAuth grants can include a primary group token plus `additionalTokens[]` for other groups.
- Images and Responses modes store separate selected group ids in `sakrylle-image-playground.selected-groups`.
- Mode-specific group selection prefers capability metadata from `/v1/me`; generic fallback names are not treated as proof of capability.
- `/v1/models` queries require the exact selected group's access token. The model selector must not silently fall back to the primary token when listing another group's models.
- OAuth Bearer fallback for image/responses requests is allowed only for the official Sakrylle API base URL. Custom providers still require an explicit API key.

## Logout, revoke, and end-session semantics

Sakrylle Image has two distinct logout paths:

1. **OIDC RP-Initiated Logout**
   - Used when `OIDC_ENABLED=true` and the stored token includes `idToken`.
   - The client resolves `end_session_endpoint` via Discovery, clears local state, and redirects with `id_token_hint` and `post_logout_redirect_uri`.
   - This path targets provider-side browser session logout. It does not also guarantee a completed front-end `/oauth/revoke` call before redirect.

2. **Fallback local logout + revoke**
   - Used when OIDC is disabled, no `idToken` exists, or end-session discovery cannot be used.
   - The client clears local state and best-effort revokes the stored refresh token at the stable Sakrylle `/oauth/revoke` endpoint.
   - Revocation errors do not block local logout.

If platform policy changes to publish and require `revocation_endpoint` metadata, update `sakrylleOidcDiscovery.ts`, `sakrylleAuth.ts`, and this document together.

## Local storage and SPA trade-offs

- `sakrylle-image-playground.auth` is stored in `localStorage` and may contain access token, refresh token, group tokens, `idToken`, and decoded claims.
- `sakrylle-image-playground.pkce-verifier`, `sakrylle-image-playground.pkce-state`, and `sakrylle-image-playground.oidc-nonce` are stored in `sessionStorage`.
- This is a static SPA with no backend session store. XSS would expose stored tokens; keep CSP/XSS hygiene high and do not treat decoded claims as an authorization boundary.

## Preserved historical notes

Detailed original research and development planning were preserved under:

- [historical/research.md](./historical/research.md)
- [historical/development-plan.md](./historical/development-plan.md)

Those files are historical/product-local references. Some conclusions are intentionally outdated after the OIDC client implementation and Docker env injection landed; they do not override current code, this page, or center platform facts.
