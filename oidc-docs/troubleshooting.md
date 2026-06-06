---
title: Sakrylle Image Troubleshooting
status: local
scope: product-local
canonical_source: ../../sub2api/sakrylle-docs/10-platform-identity/rp-integration-guide.md
last_verified: 2026-06-06
---

# Sakrylle Image Troubleshooting

Use this page for product-local failure modes only. For endpoint semantics, scopes, claims, and token boundaries, use the canonical center docs.

## First checks

- Confirm the product is using the intended Sakrylle issuer and API base.
- Confirm the product-specific client id, redirect URI, and scopes match the center registration matrix.
- Confirm local storage paths / bundle ids / data directories do not collide with upstream software.
- Confirm logs do not expose OAuth codes, access tokens, refresh tokens, id tokens, or full token responses.

## Canonical references

- [OIDC current state](../../sub2api/sakrylle-docs/10-platform-identity/current-state.md)
- [RP integration guide](../../sub2api/sakrylle-docs/10-platform-identity/rp-integration-guide.md)
- [Commercial boundaries](../../sub2api/sakrylle-docs/10-platform-identity/commercial-boundaries.md)
- [Configuration isolation](../../sub2api/sakrylle-docs/10-platform-identity/configuration-isolation.md)
