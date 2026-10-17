# Single-project deployment runbook

This deployment serves one project with one active engine. It provides explicit
configuration, persisted credentials/sessions, immutable versions, worker
presence, probes and metrics. It does not provide multi-tenant engine isolation,
SSO, automatic engine failover, a billing system, or a certified SLA.

## Prepare the runtime

Use a Linux host with Node.js 22+, npm, Rust/Cargo, and a persistent TiDB MySQL
database near the host. Claim the demo database before its expiry, or use a new
persistent instance. Keep a separate staging database for fault-injection tests.

From the repository root, install the locked dependencies and build the engine:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build:engine -- --release
```

The supplied systemd template assumes the checkout is `/opt/tisona`, Node is
`/usr/bin/node`, and a `resonate` service user owns `/var/lib/resonate-cloud`.
Adjust these paths for the host. The templates are included for deployment;
the local verification does not install a Linux service or publish a domain.

## Configure secrets and the database

Copy `deploy/service.env.example` to `/etc/resonate-cloud/service.env` and edit
the project, HTTPS public URL and paths. The file contains paths, not passwords.
Put a MySQL connection URL into `/etc/resonate-cloud/database.url`, readable only
by the service identity:

```text
mysql://USER:URL_ENCODED_PASSWORD@HOST:4000/DATABASE
```

The database must exist before production setup. Setup needs DDL permissions
for cloud control tables and the engine's initial migrations. Database TLS
always verifies the certificate and hostname; insecure `ssl-mode` options are
rejected. Protect the database URL, signing private key, bootstrap admin key,
and generated `resonate.toml` as secrets. Back up the signing keys separately
from the application database.

Generate the signing pair and bootstrap key as the service identity:

```sh
RESONATE_STATE_DIR=/var/lib/resonate-cloud npm run init-secrets
```

Existing files are never overwritten. Load the environment and initialize:

```sh
set -a
. /etc/resonate-cloud/service.env
set +a
npm run setup
```

`NODE_ENV=production` requires an explicit database URL and matching Ed25519 key
files. It never provisions a temporary database. Setup writes owner-only engine
configuration, applies the cloud migration ledger, and bootstraps the project
once. Existing projects do not import new bootstrap keys on later setup runs.
Revocation is durable. After successful initial setup, the bootstrap key file
may be removed from the runtime configuration and kept in restricted recovery
storage; remove its environment variable too if removing the file.

Local development defaults to automatic Console sign-in on loopback addresses.
Production always disables it, including when `RESONATE_TEST_AUTO_LOGIN=true`.
Use `RESONATE_TEST_AUTO_LOGIN=false` locally to exercise manual authentication.

For migration from the original demo, retain the existing project ID and engine
database. If the old `cloud_functions` catalogue needs importing into a freshly
initialized control project, set `RESONATE_IMPORT_LEGACY_FUNCTIONS=true` for that
setup operation. The old demo's local setup performs this import automatically.
Existing executions retain their request identities and remain queryable.

## Start behind HTTPS

Install the edited `deploy/resonate-cloud.service` unit and start it through the
host's service manager. It runs the release engine and Node gateway under one
supervised service and restarts on failure. `npm start` uses the same launcher.
Keep one active engine; gateway replicas require the same project, control
database, signing configuration and public origin, while the engine remains
single-active.

Place an HTTPS reverse proxy in front of `127.0.0.1:8787`. It must preserve the
Authorization header, allow outbound worker SSE subscriptions, and avoid
buffering or short timeouts for `text/event-stream`. Set `RESONATE_PUBLIC_URL`
to the external HTTPS origin. Browser cookies are then Secure. Keep engine port
8001 and engine metrics port 9091 private. Do not use the cloud-service
environment as direct Rust engine overrides; the launcher filters it and uses
the generated TOML instead.

The production DNS path is direct MySQL/TLS. If a deployment explicitly needs
the development byte relay, set `RESONATE_DATABASE_RELAY=true` and rerun setup.
It still verifies the original database hostname end to end.

## Credentials and worker rollouts

Sign in using the initial administrator key, then create named, scoped keys in
API access. Values are shown once. Use file-mounted worker credentials through
`RESONATE_TOKEN_FILE` and set `RESONATE_URL` to the project endpoint. The demo
worker can serve v2 with `WORKER_VERSION=2`; it automatically uses `research-v2`.

Different versions of one function must use distinct worker groups. Function
descriptors are immutable. Start the new version's workers and verify their
heartbeats before switching callers to `version: 2`. Keep v1 workers available
until v1 executions drain. Callers can pin v1 again during rollback; publishing
an old version does not move the latest-version default backwards.

To rotate a key, create its replacement, update the consumer, verify operation,
then revoke the old key. Revocation invalidates its browser sessions and new
API requests immediately; already-open worker streams revalidate within 15
seconds. The UI prevents revoking the current sign-in key, and the server
protects the last active administrator. Key IDs identify audit actors; this is
not a per-person identity or OIDC system.

## Monitor

Probe `/health/live` for process liveness and `/health/ready` for engine/control
readiness. A failed readiness check should remove traffic, not repeatedly kill
an otherwise live process during a database outage.

Create a metrics-only API key and put it in the scraper's protected credential
file. `deploy/prometheus.yml` uses Prometheus's documented
[`authorization.credentials_file`](https://prometheus.io/docs/prometheus/latest/configuration/configuration/#http_config)
and scrapes the gateway and engine through authenticated endpoints. Its sample
rules cover scrape failures, API error rate and gateway latency. Requests use
bounded route labels, never execution IDs, tokens, arbitrary URLs or payloads.

Worker presence is a heartbeat with a 90-second TTL. Offline workers are normal
while durable tasks wait for approval; a useful paging policy also needs the
project's expected worker schedule and pending-work context. The supplied
rules do not page solely because the worker count reaches zero.

## Upgrade and recover

1. Take or confirm a usable database backup. Record the deployed application
   revision, signing-key references, worker versions and database configuration.
2. Run staging unit, control-store SQL and worker/engine recovery tests.
3. Apply control setup migrations before serving new gateway code. Migrations
   are checksummed and use restartable DDL; edited historical migrations fail
   setup. Keep schema changes compatible with the old release during rollout.
4. Restart the service under supervision. Check readiness, metrics, existing
   execution inspection and the browser session. Sessions reside in TiDB.
5. Exercise restoration into a separate instance, update credentials/connection
   configuration, and verify that pending executions and approvals are present.
   Measure actual recovery time and accepted data-loss window.

Backup recovery can restore checkpoints to an earlier state. External effects
must use stable idempotency keys or reconciliation with the external service.
A successful external call followed by a worker crash can otherwise run again.
Cancellation records the root outcome and does not undo completed effects.
Operation audit entries record intent and are not atomic with engine commits.

No automatic execution/history deletion is configured. Define retention and
the idempotency retention window together before adding cleanup; never delete
checkpoints belonging to an active execution just to reduce storage usage.
