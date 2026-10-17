# Interactive walkthrough treatment

The viewer should remember: a worker process can stop while recorded progress
and decisions remain available, and the workflow continues from those records.

This is an in-product, silent HTML/SVG animation, adapted to the light and dark
Console themes. It applies Siddon Visual Engineering v2's continuity and causal-state
principles. It is not a rendered video project and has no audio or film assets.

Persistent objects keep their IDs, positions and labels within each story.
Blue means active, green means saved, amber means waiting, red means unavailable.
Text and symbols accompany every state. Motion follows actual graph connections;
the diagram responds to its available width rather than wrapping arrows away
from nodes. The SVG geometry follows the rendered node bounds.

Overview uses the same live example card as the Examples studio. Its default
recovery scenario records a plan, two simulated 429 responses, durable waits
and a successful third tool call. The main action starts this execution in
place, or follows it if already pending. Four pattern buttons switch the
featured card without duplicating its session. The card moves back to the
gallery on Examples, retaining its IDs and inspected steps. Overview includes
no execution-history list. Never imply exactly-once external effects or show
a worker crash as a live event without recorded evidence.

Example previews follow the selected preset: human gate or automatic policy;
bounded retries or exhaustion; shipping success or reverse-order compensation;
parallel branches followed by a join. Preview frames are illustrative.

Every frame is derived from its own data. Play advances one frame every 3.4
seconds and stops at the end. Pause, previous/next, replay and seeking use the
same states. Only visible active-page players animate. Reduced-motion users
get manual playback and no CSS transition or moving connector animation.

Each example combines its own description, scenario controls, preview and live
execution in one workspace. Running it switches the existing canvas to
**Live execution** without navigation. Its single
current frame is a pure projection of the authenticated execution-detail API,
including actual checkpoint IDs, saved responses, timer promises and approval
decisions. It has no Play, seek or client-side state progression. Refreshes keep
the same diagram nodes, so a recorded state change animates in place. Any step
that finishes between snapshots remains available in the recorded-step list;
we never play inferred intermediate events as though they were observed live.

The detail request is serialized and scheduled two seconds after the previous
response, with a ten-second timeout. Requests pause on hidden pages and stop
on navigation, logout, expired sessions and settled executions. A failed request
preserves the last snapshot, pauses connector motion and labels updates paused;
reconnecting restores updates automatically. Returning to a pending execution
fetches a fresh snapshot. Final outcomes can also be refreshed manually.

Red 429 responses remain inspectable after a later successful attempt. Elapsed
timers are saved waits, not execution failures. A compensated order retains the
failed shipment and the actual refund/release records. Parallel document nodes
follow their own parent/child records; an elapsed child timer alone never marks
the branch complete. Every node opens its recorded step inside the same card. Approval controls sit
immediately below the animated state, before the recorded-step disclosure.

Worker presence is matched to the execution's pinned version and routing group.
It reports heartbeat presence (20-second interval, 90-second TTL), not instant
crash detection or task health. Stale/unavailable presence is unknown. Task
resume counters never stand in for crash/recovery events. The four built-in
example workflows at v1 and research are supported; other functions retain the
generic native step inspector. Truncated responses are explicitly partial.


## Integrated studio and appearance

The single claim is that a durable workflow's failure, saved progress and next
user action remain understandable together, without a page/context switch.
The primary interface is a card with controls on the left and one persistent
canvas on the right; it stacks on narrow windows. Four cards have independent
execution sessions. Display only observed live states; fast events remain in
the recorded list. Moving connectors illustrate pending dependencies and never
advance server state or a percentage. Reduced motion disables moving packets
and transitions while preserving every recorded state and action.

The preview → live transformation preserves node elements and anchors when the
workflow topology matches. Changing the document-count preset explicitly maps
to the new set of branches. A wrapped four-stage flow uses a two-row path, with
SVG anchors following the actual grid positions. Replay is available only for
previews, and completion/recovery of a live execution stops automatic polling.

Appearance uses shared semantic CSS tokens for the whole Console. The dark
palette has a charcoal green stage, neutral off-white text and the same semantic
blue/green/amber/red states. System is the initial setting. Manual preference
is saved locally and applied before CSS renders to avoid a theme flash. Tests
check theme preference behavior, disabled storage and 4.5:1 contrast for normal
text and the semantic label/background pairs in both palettes.
