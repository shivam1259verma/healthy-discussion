# Healthy Discussion — Kainostore edition

A microphone-based conversation monitor. One person at a time shows **Healthy
Discussion**; overlapping voices or shouting play a buzzer and show **Unhealthy
Discussion**. Audio is analysed live in the browser and is never uploaded or stored.

This folder is the hosted, Kainostore-ready version: the original single-file app
served behind Kainostore launch/login.

## What is in here

| Path | Purpose |
|---|---|
| `public/` | The app (`index.html`, `app.js`) and a small session bar (`session.js`) |
| `server.mjs`, `lib/` | Node server: `/health`, `/api/kaino/callback`, session guard, sign-out |
| `migrate.mjs`, `migrations/` | Creates the `app_sessions` table in Kainostore-managed PostgreSQL |
| `kaino.app.json`, `Dockerfile` | Hosting manifest and image |
| `test/` | 18 behaviour tests against a local fake Kainostore |
| `kainostore/` | Drafts of the CLI input files (app, pricing, listing) |

Free app, no in-app products. Kainostore is the only sign-in. Sessions live in
managed PostgreSQL (renewable, up to 8 hours), so users are not bounced every
five minutes and sessions survive restarts and updates.

## Environment

Kainostore supplies its own bindings (`KAINO_MARKETPLACE_URL`, client id/secret,
`DATABASE_URL`, `PORT`, …). You set two app-owned values, both non-secret, runtime:

- `KAINO_APP_ID` — the app's UUID (printed by `kaino apps create`). **Required**: the
  server refuses sessions for any other app.
- `KAINO_APP_SLUG` — optional; only used to build the "launch again" link.

## Run the tests locally

```bash
npm install
# any disposable loopback PostgreSQL database:
export TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/hd_test
npm test
```

## Publish on Kainostore

Human-only steps are marked **(you)**.

1. **(you)** Put this folder in a GitHub repo and push it (e.g. `healthy-discussion`).
2. **(you)** In the Developer Portal, give the *Kainostore GitHub App* access to that repo.
3. **(you)** `npm install --global @kainostore/cli@beta`, then `kaino login` and approve in the browser.
4. Discover the installation and repo:
   `kaino source installations --json` → `kaino source repositories --installation ID --page 1 --json`
5. Edit `kainostore/app.json` with the real `installation_id` and `repository`, then:
   `kaino apps create --file kainostore/app.json --json` and `kaino apps link --app APP_UUID`
6. Set the environment (this replaces the whole document):
   ```bash
   kaino env status --json                       # note the revision
   printf 'KAINO_APP_ID=APP_UUID\nKAINO_APP_SLUG=healthy-discussion\n' > runtime.env
   kaino env replace --file runtime.env --revision REVISION --json
   ```
7. Pricing — Free: `kaino pricing plan --file kainostore/pricing.json --json`, then
   `kaino pricing apply --file kainostore/pricing.json --plan DIGEST --json`
8. Listing: `kaino listing show --json`, fill `kainostore/listing.draft.json`
   (revision, primary_url), `kaino listing update --file kainostore/listing.draft.json --json`
9. Artwork (required before the first release): `kaino artwork generate --json`,
   `kaino artwork pick --option OPTION_ID --json`; icon via
   `kaino artwork generate --kind icon --json` or `kaino media upload --file icon.png --kind icon`.
10. `kaino doctor --json` (should pass), commit, push, and publish a **GitHub Release** (e.g. `v1.0.0`).
11. `kaino source releases --app APP_UUID --page 1 --json`, fill `release.json` from the result, then
    `kaino releases submit --file release.json --json` and `kaino releases watch RELEASE_UUID --timeout 300 --json`.
12. After it is live, test the real flow once: launch from Kainostore, press Start, allow the
    microphone, sign out.

The free plan includes three hosted apps; a release needs a free slot.

## Notes

- The microphone only works over HTTPS. The page sets `Permissions-Policy: microphone=(self)`
  and a strict CSP (no inline scripts).
- Tests use local fixtures, not the live platform. Launch, renewal and revocation against the
  real marketplace can only be confirmed after publication.
- The Docker image has not been built in the authoring environment (no Docker daemon); the same
  file layout was run with production-only dependencies and passed migrate → start → health.
