---
title: Sakrylle Image Implementation Status
status: local
scope: product-local
canonical_source: ../../sub2api/sakrylle-docs/10-platform-identity/current-state.md
last_verified: 2026-06-06
---

# Sakrylle Image Implementation Status

Current documentation status: **client implementation is complete and locally verified with automated tests/build; changes have been committed and pushed on `theme/sakrylle`; production enablement still depends on explicit deployment flags and deployed IdP smoke tests.**

Canonical platform status lives in [Sakrylle OIDC current state](../../sub2api/sakrylle-docs/10-platform-identity/current-state.md). This file only tracks product-local readiness and gaps for the Image SPA.

## Current repository progress (2026-06-06)

- OIDC/group routing/branding documentation polish has been implemented on `theme/sakrylle` and pushed in commit `a868c7d` (`fix: complete Sakrylle OIDC and branding polish`).
- Local automated verification completed before the commit:
  - targeted Vitest suite: `src/lib/sakrylleAuth.test.ts`, `src/lib/groupSelection.test.ts`, `src/lib/oauthFallback.test.ts`, `src/locales/locales.test.ts` — 80 tests passed.
  - full `npm run test` — 285 tests passed across 20 test files.
  - `npm run build` — build succeeded with known Vite warnings about `oauthFallback.ts` mixed static/dynamic import and large chunks.
- Deployment-facing validation is still pending: production/staging `OIDC_ENABLED` env confirmation and real IdP smoke tests with single-group and multi-group accounts.

## Implemented locally

- OAuth 2.0 Authorization Code + PKCE login remains the base flow.
- Optional OIDC is gated by `VITE_SAKRYLLE_OIDC_ENABLED === 'true'`.
- OIDC-enabled login adds `openid profile email` scopes.
- OIDC Discovery resolves authorization, token, userinfo, JWKS, and end-session endpoints with issuer/origin validation and hardcoded fallback.
- Callback handling parses `id_token` payload claims, checks `aud`/`exp`, and validates nonce when present.
- `/v1/me` remains the source for live account/group data; `id_token` claims are merged as identity fields when OIDC is enabled.
- Regular refresh and group-specific refresh use the Discovery token endpoint when OIDC is enabled.
- RP-Initiated Logout redirects to `end_session_endpoint` when OIDC is enabled and an `id_token` is available.
- Fallback logout clears local state and performs best-effort refresh-token revoke against the stable `/oauth/revoke` platform endpoint.
- OAuth Bearer fallback is limited to the official Sakrylle API base URL and is not sent to arbitrary custom providers.
- Images/Responses group selection is mode-aware; model listing uses the selected group's exact access token and does not silently fall back to the primary token.

## Runtime env mapping

Vite-facing variables are compiled into placeholders in the Docker image. The container entrypoint replaces those placeholders from shorter runtime env names:

| Runtime env | Bundle placeholder | Vite variable |
|---|---|---|
| `DEFAULT_API_URL` | `__VITE_DEFAULT_API_URL_PLACEHOLDER__` | `VITE_DEFAULT_API_URL` |
| `OAUTH_BASE` | `__VITE_SAKRYLLE_OAUTH_BASE_PLACEHOLDER__` | `VITE_SAKRYLLE_OAUTH_BASE` |
| `OAUTH_CLIENT_ID` | `__VITE_SAKRYLLE_OAUTH_CLIENT_ID_PLACEHOLDER__` | `VITE_SAKRYLLE_OAUTH_CLIENT_ID` |
| `OIDC_ENABLED` | `__VITE_SAKRYLLE_OIDC_ENABLED_PLACEHOLDER__` | `VITE_SAKRYLLE_OIDC_ENABLED` |

Do not set `VITE_SAKRYLLE_OIDC_ENABLED` directly in Docker Compose expecting runtime replacement. For the production container, set `OIDC_ENABLED=true` or `OIDC_ENABLED=false`.

## Product-local readiness checklist

- [x] Local configuration points are documented in [local-integration.md](./local-integration.md).
- [x] Product-specific OAuth/OIDC callback and redirect behavior are documented.
- [x] Token storage behavior and SPA trade-offs are documented.
- [x] Login, refresh, revoke/logout, profile mapping, and group routing verification targets are documented.
- [x] Known security gaps are linked to product-local implementation notes.
- [ ] Production/staging compose values have been manually verified for the intended `OIDC_ENABLED` value.
- [ ] End-to-end smoke tests have been run against the deployed IdP with real single-group and multi-group accounts.

## Known trade-offs and risks

- Tokens remain in browser `localStorage` because this is a static SPA. XSS would expose access/refresh tokens; this is an accepted current architecture trade-off, not an authorization boundary.
- `id_token` payloads are decoded client-side without signature verification. Claims are used for display/identity enrichment only; authorization still depends on access tokens and server-side APIs.
- OIDC `end_session_endpoint` and OAuth token revoke are distinct operations. The redirect logout path does not also guarantee a completed front-end revoke call; token-family invalidation policy belongs to the provider contract.
- `/oauth/revoke` is intentionally treated as a stable Sakrylle platform endpoint rather than an OIDC Discovery endpoint. Revisit this if the platform starts publishing `revocation_endpoint` metadata.

## Suggested verification

- Verify production/staging env explicitly sets the intended `OIDC_ENABLED` runtime flag.
- Run login callback and confirm state/nonce handling and `/v1/me` identity merge.
- Confirm regular refresh and `refreshWithGroupId()` use the expected token endpoint when OIDC is enabled.
- Confirm revoke/logout behavior in three cases: OIDC with `id_token`, OIDC fallback without usable end-session, and non-OIDC.
- Confirm Images/Responses group selection uses mode-capable groups and that `/v1/models` never uses the wrong group's primary token.
- Check no OAuth bearer token is sent to non-Sakrylle custom providers.
