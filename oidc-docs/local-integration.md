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
- production gray rollout and rollback notes for Image

## Preserved historical notes

Detailed original research and development planning were preserved under:

- [historical/research.md](./historical/research.md)
- [historical/development-plan.md](./historical/development-plan.md)

Those files are historical/product-local references. They do not override center platform facts.
