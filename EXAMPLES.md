# Runnable value demonstrations

Open the Console's **Examples** tab. Four original TiSona examples, built with Resonate, illustrate
patterns also featured in [Temporal's AI use cases](https://temporal.io/solutions/ai)
and [Code Exchange](https://temporal.io/code-exchange): human approval, durable
retries, Saga compensation and parallel pipelines. These examples reuse the
existing SDK and public execution/approval APIs, without changing the engine.

## Start

Keep `npm start` running, then start the separate example worker:

```sh
npm run worker:examples
```

Local development enters the Console automatically. Each card has scenario
presets, its input, the expected behavior, and a Run button. Buttons enable when
the corresponding function version is registered and a compatible worker is
reporting online. Heartbeat presence does not guarantee immediate task delivery.

Each example is one workspace: scenario controls and its value sit beside an
animated canvas. The canvas starts as an **Illustrated preview** with playback
and seeking. **Run example** starts the real API execution and switches that
same canvas to **Live execution**, without changing the page. Nodes retain their
positions through the switch. Other examples can run independently.

Approval buttons appear directly under the diagram's waiting state. Select a
node or expand Recorded steps to inspect its saved data inside the same card.
Completed outcomes stay visible. Change a scenario to preview it, or choose
**Show last run** to return to the recorded result. A pending run must finish or
be canceled before starting another in that card. Reloading restores the same
execution ID; it does not submit a new run. A lost start response can be retried
with the original idempotency key and body.

Open **Config → Appearance** to choose **System / Light / Dark**. System follows your
OS preference; manual choices persist between visits. Animation, form, status
and inspector colors share the same theme. Motion pauses off-screen and on
other pages, and respects reduced-motion preferences.

The example worker publishes four v1 manifests into `examples-v1`. It uses the
same URL/credential environment variables and `_FILE` support as the research
worker. Keep the research workers running if old research executions need them.
Do not change an existing version's workflow in place after it has been used;
publish a new version/group for incompatible changes.

## What to show

| Scenario | What happens | Evidence in the Console |
| --- | --- | --- |
| Support refund | Load a ticket and check policy, then wait for approval. Approve to issue a simulated refund and reply; decline to end without either. | The approval prompt, saved checks, and presence or absence of refund/reply checkpoints. A second preset skips approval under a simulated automatic policy. |
| Rate-limited tool | Record two 429 responses, wait with bounded exponential backoff, then receive 200. A second preset exhausts the retry budget. | Every attempt's saved response, durable timers, final attempt history and explicit recovered/exhausted outcome. |
| Order fulfillment | Reserve stock, charge, then fail shipping. Refund the charge and release stock in reverse order. A second preset fulfills successfully. | A rejected shipment checkpoint followed by refund/release checkpoints; final outcome is compensated. Successful orders have no compensation. |
| Document ingestion | Launch 3 independent document branches, wait, extract and index each, then join the batch. A longer preset allows a worker restart while waiting. | Overlapping branch timestamps, each branch's child checkpoints, and the joined index report. |

The duration settings are compressed demonstration timers. The document
scenario uses fixture content and does not call an embedding provider or perform
actual vector indexing. Refunds, payments, shipping, account enrichment and
customer messages are also simulated. There are no external charges or sends.
Checkpoints, durable timers, human decisions, task delivery and execution
outcomes are real and persisted in TiDB.

**Resolved** describes successful completion of workflow code. A business
outcome may still be **declined**, **exhausted** or **compensated**. The scenario
summary above the step inspector and the root result explain that distinction.
A 429 response is a successfully recorded failed tool response, rather than a
failure to save the checkpoint. Backoff is explicit workflow code using
`ctx.sleep`; this is not an engine-wide automatic retry policy.

## Show recovery

Start the refund's approval preset. When it is waiting, stop the example worker.
Submit approval with the worker offline, then start the worker again. The
decision is retained and the refund resumes. No open browser connection is
required to keep the wait alive.

Start a rate-limit example or the longer document preset, stop the example
worker during a durable wait, then restart it. Inspect the original execution
ID: saved steps remain, and pending work resumes after task delivery. This
demonstrates recovery of recorded progress, not exactly-once external effects.
Real tools must honor stable idempotency keys and reconcile ambiguous results.
The Saga demonstrates explicit compensating actions, not atomic rollback of
external services, and cancellation does not run Saga compensation automatically.

For repeatable fault injection, stop any separately started example worker and
leave the service running, then run:

```sh
npm run test:examples-live
```

This test owns only its example worker and execution IDs. It checks approval
with an offline worker, decline behavior, SIGKILL during backoff, preservation
of a completed planning checkpoint, retry exhaustion, compensation ordering,
successful fulfillment and overlapping document branches. It never stops the
service or deletes existing execution data. Private evidence is written to
`examples-live-results.json` in the Git-ignored private state directory `.local/`;
logs and audit fixtures remain there as well (see README).

## Use from an agent

`GET /v1/examples` returns the same catalogue used by the Console. Each item
contains its immutable function descriptor and input presets. Start it through
the normal `POST /v1/executions` API with `function`, `version`, `input` and an
`Idempotency-Key` header. Inspect with `GET /v1/executions/:id`, and use the
existing `POST /v1/executions/:id/waits` endpoint for human decisions. Agent and
worker API calls still require their scoped credentials.

The source is in `examples/catalogue.mjs`, `examples/workflows.mjs` and
`examples/worker.mjs`. Replace fixture leaf functions with real tools while
keeping workflow control flow and checkpoints.

## Live execution animation

Run any example to switch its own canvas to the live diagram. Actual checkpoint, timer, approval
and result records drive the animation, with updates about every two seconds.
Select a diagram node or recorded step to inspect its saved input/result.
Earlier failed responses remain visible after recovery, and a failed shipment
stays visible after compensation. Fast steps between refreshes remain in the
recorded-step list. Connection outages preserve the last view and automatically
resume updates after reconnecting. Each card clearly labels illustrated previews and recorded execution data.
