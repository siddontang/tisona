# GitHub → Cloudflare backend → Netlify Console

The `TiSona` GitHub Actions workflow tests each pull request. A push to `main`
or a manual run on `main` additionally builds and deploys the complete service:

```text
Unit tests + Worker bundle check
  → build linux/amd64 runtime with the pinned Resonate engine
  → verify Cloudflare Containers access
  → deploy Worker, Durable Object and Container with encrypted runtime settings
  → verify release readiness, worker registration, idempotency and retry recovery
  → build and publish the Netlify Console
  → verify its session proxy and secure authenticated cookie
```

The frontend is published only after the new backend revision passes its smoke
check. Pull requests never receive deployment secrets and never deploy. Releases
are serialized; a newer push does not interrupt an in-progress deployment.

## Account requirements and one-time setup

Cloudflare **Workers Paid with Containers access** is required. The API token
must be authorized to deploy Workers, manage Durable Objects and manage/push
Containers and registry images in the selected account. A valid token alone
does not establish Containers entitlement. The preflight reports missing plan
access before uploading runtime secrets or publishing the Console. It does not
upgrade plans or add payment methods.

Netlify needs a token that can deploy the selected project. GitHub needs an
authenticated `gh` session permitted to manage this repository's Actions secrets
and variables. Local provisioning is scoped to `siddontang/tisona`.

Install dependencies, then run once on the trusted setup machine:

```sh
npm ci
node scripts/provision-hosting.mjs
```

The script reads token-only files `~/.cloudflare` and `~/.netlify`, or the matching
`CLOUDFLARE_API_TOKEN` and `NETLIFY_AUTH_TOKEN` environment variables. It selects
the sole available account/team or requires explicit account/team settings if
there are multiple. It creates/reuses `tisona-siddontang` on Netlify and provisions
a separate Cloud Zero instance/database for this hosted preview, independent of
the local demo. Setup does not publish an empty or disconnected Console.

Local recovery files go in `.local/hosting` (directory mode 0700, files 0600),
which Git and Docker both exclude. Retain a protected backup. They include
`console-admin.key`, `runtime.json` and the Cloud Zero response with its claim
information. Re-running setup preserves keys and the database. If GitHub already
has runtime credentials but this machine lacks the recovery copy, provisioning
refuses to silently replace the runtime.

The script configures these GitHub encrypted secrets:

| Secret | Use |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Deploy the backend |
| `NETLIFY_AUTH_TOKEN` | Publish the Console |
| `TISONA_RUNTIME` | Database URL, expiry, stable signing pair, bootstrap keys and origins |

It also sets repository variables `CLOUDFLARE_ACCOUNT_ID`, `NETLIFY_SITE_ID`,
`TISONA_API_ORIGIN` and `TISONA_CONSOLE_ORIGIN`. Account/site IDs and origins are
configuration, not credentials. No personal token or database secret is bundled
into browser assets, Docker layers or command arguments.

## Automatic releases

Commit and push to `main`. GitHub Actions builds on Linux; Docker does not need
to be installed on the setup laptop. The image fetches exactly the revision in
`engine-source.json`, builds with Cargo's lock file and installs only production
Node dependencies. Wrangler and Netlify CLI versions are pinned in the npm lock
file. The deployment's runtime secret is transferred to Cloudflare as a Worker
secret, then passed to the container only at startup.

If a release fails, inspect the failed step in Actions. For a missing Workers
Paid plan, enable it in the Cloudflare dashboard, then use **Re-run failed jobs**.
No code or secret changes are necessary for that specific blocker. Further token
permissions and runtime compatibility are verified by the later deployment steps.

The initial Console login uses `.local/hosting/console-admin.key`. Public test
auto-login remains disabled. Agents and customer SDK workers use the API origin
directly; browser `/session` and `/v1/*` calls use the Netlify same-origin proxy.
Do not send SDK protocol or long-lived SSE through Netlify.

## Runtime lifecycle and limits

All requests use the same Durable Object name, `starter`; paths and client IDs
cannot create additional project engines. The object starts one container with
the Node gateway, Rust engine and bundled example worker. It uses the `basic`
instance size (1/4 vCPU, 1 GiB memory). A durable alarm runs every minute and a
10-minute inactivity timeout bridges idle periods so timer processing does not
depend on browser activity. Once activated, this preview intentionally keeps
running and incurs compute charges, including during idle periods.

The release commit is recorded on the container. On upgrade the object stops
the previous container before starting the new one. Readiness checks wait for
both TiDB control state and the engine; an unavailable runtime returns 503.
Bootstrap keys apply only to an uninitialized project and revoked keys are not
reseeded. Signing keys and all durable execution/session state survive container
disk replacement through the external secret and TiDB. Shutdown supervises the
gateway, engine and bundled worker together.

This is a single-engine preview, with possible interruptions during upgrades or
platform failures. The alarm provides recovery attempts, not a scheduling SLA;
container restarts, SSE reconnects and idle-time timer behavior still require a
successful live Cloudflare verification. Do not run a second local engine against
the hosted database. Cloud Zero expires after its preview period; its expiry is
shown in the Console and expired configurations refuse to start. Claim it or
replace it with persistent TiDB before production use.

## Recovery and rollback

For an application rollback, revert the change on `main` and push. The normal
workflow rebuilds the previous source and runs the same checks; signing material
and database identity remain stable. Keep database migrations backward compatible.
Wrangler deploys Worker code before image preparation finishes, so backend
deployment is not atomic. A failure may require rerunning or reverting even when
the Netlify release has correctly been withheld.

For credential rotation, edit the protected recovery runtime, update the GitHub
`TISONA_RUNTIME` secret and deploy a new commit. Use named API keys for routine
client/worker rotation. Replacing an initial bootstrap key does not change an
already initialized project's keys. For database replacement, perform a verified
backup/restore and change the URL and expiry together; provisioning does not
automatically abandon an existing database.

References: [Container lifecycle](https://developers.cloudflare.com/containers/concepts/architecture/),
[Durable Object Container API](https://developers.cloudflare.com/containers/api/durable-object-container/),
[Deployment behavior](https://developers.cloudflare.com/containers/guides/deploy/),
[Netlify CLI](https://docs.netlify.com/api-and-cli-guides/cli-guides/get-started-with-cli/).
