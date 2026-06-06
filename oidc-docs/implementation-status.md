---
title: Sakrylle Image Implementation Status
status: local
scope: product-local
canonical_source: ../../sub2api/sakrylle-docs/10-platform-identity/current-state.md
last_verified: 2026-06-06
---

# Sakrylle Image Implementation Status

Current documentation status: **mostly complete: OAuth PKCE and optional OIDC client support exist; production flags and SPA security trade-offs must remain explicit.**

Canonical platform status lives in [Sakrylle OIDC current state](../../sub2api/sakrylle-docs/10-platform-identity/current-state.md). This file only tracks product-local readiness and gaps.

## Product-local readiness checklist

- [ ] Local configuration points are documented in [local-integration.md](./local-integration.md).
- [ ] Product-specific OAuth/OIDC callback or scheme is documented.
- [ ] Token storage behavior is documented.
- [ ] Login, refresh, revoke/logout, and profile mapping smoke tests are documented.
- [ ] Known security gaps are linked to product implementation tasks.

## Suggested verification

- Verify production/staging env explicitly sets the intended OIDC feature flag.
- Run login callback and confirm state/nonce handling and `/v1/me` identity merge.
- Confirm refresh, revoke/logout, and group-based API access work.
- Check no OAuth bearer token is sent to non-Sakrylle custom providers.

