# AGENTS.md

Agent instructions for this repository. `CLAUDE.md` is the full operational
runbook and remains the source of truth; keep this file aligned with it when
project facts change.

## Project Shape

Sakrylle Image is a fork of `CookSleep/gpt_image_playground`, maintained on the
`theme/sakrylle` branch as `Ranshen1209/sakrylle-image`.

- Pure frontend SPA: React 19, TypeScript, Vite 6, Tailwind 3, Zustand 5,
  i18next.
- No backend in this repo. User data lives in browser IndexedDB/localStorage;
  image calls go to API providers directly.
- Production site: `https://image.sakrylle.com`.
- Default Sakrylle API base must be `https://api.sakrylle.com/v1`.
- Sakrylle OAuth lives at `https://sub.sakrylle.com`.

## Non-Negotiables

- Preserve the multi-provider architecture. Do not remove OpenAI-compatible,
  fal.ai, custom HTTP, Responses API, or Agent paths just because Sakrylle is the
  default.
- The only Sakrylle image model is `gpt-image-2`
  (`src/lib/apiProfiles.ts::DEFAULT_IMAGES_MODEL`).
- Sakrylle GPT-Image group keys are group-scoped. `group_id=5` is the GPT-Image
  group with image generation enabled.
- Keep OAuth PKCE, OAuth Bearer fallback, multi-group selection, and OIDC feature
  flag behavior intact unless the task is explicitly changing them.
- Do not store translated runtime error/status strings in persistent data. Use
  sentinels from `src/lib/agentSentinels.ts` so language switching keeps old
  records correct.
- Brand name `Sakrylle` is not translated. Technical words such as API, URL,
  API Key, token, and OAuth stay in English.
- Rebase or UI work must preserve the Sakrylle visual system: Monet purple
  palette, Liquid Glass utilities, ambient body class, Sakrylle logo, and dark
  first-paint FOUC guard.

## API And Auth Facts

- Images API:
  - `POST /v1/images/generations`
  - `POST /v1/images/edits`
- Sakrylle default image path uses streaming `POST /v1/chat/completions` for
  text/image/mask generation when `streamChatCompletionsImage` is enabled.
- Responses API:
  - `POST /v1/responses`
  - Used for Agent multi-turn conversations and streaming image flows.
- Platform API:
  - `GET /v1/me`
  - `GET /v1/account/balance`
  - `GET /v1/models`
- OAuth Bearer fallback is allowed only for official Sakrylle base URLs and only
  when scopes allow the requested mode.
- Canonical v2 scopes:
  `profile:read account:read account:balance:read models:read images:create responses:create offline_access`.
  OIDC adds `openid profile email`.
- Current billing is per successful request, not token-based.

## Environment Variables

Build-time Vite envs:

- `VITE_DEFAULT_API_URL`
- `VITE_SAKRYLLE_PLATFORM_API`
- `VITE_SAKRYLLE_OAUTH_BASE`
- `VITE_SAKRYLLE_OAUTH_CLIENT_ID`
- `VITE_SAKRYLLE_OIDC_ENABLED`

Docker runtime envs injected by `deploy/inject-api-url.sh`:

- `DEFAULT_API_URL`
- `ENABLE_API_PROXY`
- `LOCK_API_PROXY`
- `OAUTH_BASE`
- `OAUTH_CLIENT_ID`
- `OIDC_ENABLED`
- `API_PROXY_URL`
- `HOST`
- `PORT`

Production intentionally uses browser direct calls to
`https://api.sakrylle.com/v1`; the nginx API proxy is disabled unless explicitly
configured otherwise.

## Key Files

- `src/store.ts` - main Zustand store, task lifecycle, Agent lifecycle, image
  cache subscriptions, import/export.
- `src/lib/apiProfiles.ts` - provider profiles, defaults, validation.
- `src/lib/openaiCompatibleImageApi.ts` - OpenAI-compatible image calls,
  concurrent multi-image splitting, retry/refill behavior.
- `src/lib/chatCompletionsImageApi.ts` - Sakrylle streaming image path.
- `src/lib/sakrylleAuth.ts` - OAuth PKCE, refresh rotation, OIDC token handling.
- `src/lib/groupSelection.ts` - OAuth multi-group selection and group token
  lookup.
- `src/lib/oauthFallback.ts` - OAuth Bearer fallback for image/Responses calls.
- `src/lib/sakrylleAccount.ts` - platform API calls and authed fetch retry.
- `src/lib/sakrylleOidcDiscovery.ts` - OIDC discovery and endpoint fallback.
- `src/lib/i18n.ts`, `src/lib/language.ts`, `src/locales/*.json` - i18n.
- `src/lib/agentSentinels.ts` - persisted status/error sentinel handling.
- `src/lib/theme.ts` - light/dark theme and View Transition switching.
- `src/index.css` - Sakrylle palette, Liquid Glass utilities, ambient
  background.
- `index.html` - title, body class, first-paint FOUC guard, metadata.
- `deploy/Dockerfile`, `deploy/inject-api-url.sh` - Docker build/runtime config
  injection.

## i18n Rules

- Add new UI strings to both `src/locales/zh.json` and `src/locales/en.json`.
- Keep key sets, placeholders, and non-empty strings in sync; tests enforce this.
- Components should use `useTranslation()`.
- Non-component libs can import `i18n` and call `i18n.t(...)`.
- Persistent messages must use sentinels rather than translated strings.
- Existing profile default names such as `新配置`, `默认`, and `（复制）` are
  persisted data and need migration care before changing.

## Theme And Branding Rules

- `index.html` must keep the dark-mode first-paint IIFE before blocking styles.
- `body` must keep the `sakrylle-ambient` class.
- New glass-like UI should reuse `.glass-panel`, `.glass-card`,
  `.glass-input-shell`, `.glass-button`, and `.glass-button-primary` from
  `src/index.css`.
- Avoid reintroducing Tailwind `blue-*` styling in Sakrylle UI. Use the existing
  Monet purple values/palette.
- `src/components/icons.tsx::SakrylleLogo` is the canonical logo. Do not restore
  the old `public/pwa-icon.svg` flow.
- Header intentionally removed the install-app prompt and help modal entry.

## Multi-Image Behavior

For Sakrylle `gpt-image-2`, upstream ignores single-request `n>1`; the app must
split multi-image requests into parallel `n:1` calls.

- `MAX_CONCURRENT_IMAGE_REQUESTS` is intentionally 6.
- Retry/refill behavior should preserve partial success handling and avoid
  unlimited extra paid requests.
- A fully successful refill should not surface as partial failure; exhausted
  refill budget should keep successful images and show partial failure.

## Tests And Commands

Common commands:

```bash
npm install
npm run dev
npm run mock:api
npm run test
npm run test:watch
npx vitest run src/lib/someFile.test.ts
npm run build
npm run preview
npm run deploy:cf
```

Run focused tests for touched areas when possible. Important suites include:

- `src/lib/sakrylleAuth.test.ts`
- `src/lib/sakrylleAccount.test.ts`
- `src/lib/sakrylleOidcDiscovery.test.ts`
- `src/lib/oauthFallback.test.ts`
- `src/lib/groupSelection.test.ts`
- `src/lib/sakrylleImageSize.test.ts`
- `src/lib/agentSentinels.test.ts`
- `src/lib/agentApi.test.ts`
- `src/locales/locales.test.ts`
- `src/lib/apiProfiles.test.ts`
- `src/lib/api.test.ts`
- `src/lib/urlSettings.test.ts`
- `src/store.test.ts`

If changing default API literals, update matching test assertions.

## Release And Deployment Notes

- Bump both `package.json` version and `public/sw.js` cache name for releases.
  Otherwise old Service Worker chunks may remain active.
- Docker image is published to
  `ghcr.io/ranshen1209/gpt_image_playground:latest`.
- GitHub Actions Docker build is normally triggered manually with
  `workflow_dispatch`; do not rely on tag push alone.
- Rollback must use a recorded image digest. The `latest` tag moves.
- OAuth redirect URIs are owned by sub2api. To add or change callback domains,
  update `oauth_clients.redirect_uris` in sub2api, not this repo.

## Upstream Sync

Normal upstream flow:

```bash
git fetch upstream
git checkout theme/sakrylle
git rebase upstream/main
```

Expected conflict hotspots:

- `index.html`
- `src/index.css`
- `src/lib/apiProfiles.ts`
- `src/components/Header.tsx`
- `src/components/SettingsModal.tsx`
- `src/components/icons.tsx`
- `src/main.tsx`
- `src/App.tsx`
- `tailwind.config.js`
- `README.md`
- `public/manifest.webmanifest`
- `public/favicon.png`
- `package.json`
- `public/sw.js`
- `deploy/Dockerfile`
- `deploy/inject-api-url.sh`
- `src/vite-env.d.ts`
- `src/store.ts`

When upstream adds UI, check for `blue-*` Tailwind classes and convert them to
the Sakrylle palette. `src/components/HelpModal.tsx` is intentionally deleted;
keep it deleted unless the product decision changes.

## OIDC Documentation Governance

`oidc-docs/` is product-local documentation for Sakrylle Image only. Shared
platform identity docs are canonical in `../sub2api/sakrylle-docs/`.

When changing OAuth/OIDC client behavior, `VITE_SAKRYLLE_*` envs,
`OIDC_ENABLED`, token storage, discovery, nonce/id_token handling, logout/revoke,
group routing, or Image rollout status, update local `oidc-docs/` in the same
change and update center docs if the shared platform contract changes.

