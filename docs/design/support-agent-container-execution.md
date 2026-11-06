# Support-agent container execution

Refs #1929. Status: implementation design draft. No container, worker, launcher,
model credential or runtime enrollment is implemented or enabled by this file.
Existing Agent behavior is unchanged. The complete support isolation gate remains
closed, including when no assistant is selected.

## Trust boundary

The first supported execution target is a dedicated Linux container host. A
trusted, separately deployed broker obtains a short-lived support grant and
starts an unprivileged worker container. The broker does not start the ordinary
owner-backed Gugu harness. Other hosts fail closed until they have an equivalent
reviewed boundary; a different directory or role prompt is insufficient.

The worker receives the approved public question and approved documentation. Its
process environment contains no owner JWT, refresh token, console credential,
database password, model key, personal home, browser profile, global memory or
other session context. No customer evidence or human whisper enters this path.
The broker keeps its own restricted support credential outside the worker and
uses a separately approved model credential rather than an owner's general key.

There are three separate authorities:

| Authority | Allowed work | Cannot do |
| --- | --- | --- |
| Trusted provisioner | Verify the actual deployment and register its reviewed runtime identity | Treat a worker's self-report as host approval |
| Broker | Fixed support operations and one approved model endpoint for its live grant | Approve its own host, broaden a grant, impersonate a human or proxy arbitrary URLs |
| Worker | Read approved documents, draft an answer, request a public reply through the broker | Reach the network, host files, shell, desktop, credentials or another session |

The existing database enrollment row and free-text audit reference are not proof
that any of these host properties have been exercised. Qualification requires a
trusted provisioner to connect that row to the exact reviewed deployment and its
observed image/document manifest. Provisioning, review and release enablement
remain distinct operations.

## Worker process

Launch one fresh container per question. Use a locally present image identified
by an approved immutable digest; do not pull a tag selected by a question, model
response or caller-controlled tool field. The launcher constructs argv directly
and never interpolates a shell command.

Required container settings:

- Non-root UID/GID, dropped capabilities and no-new-privileges.
- Read-only root filesystem, bounded memory/CPU/PIDs, no host PID/IPC namespace.
- No network interfaces beyond the isolated container namespace; no published
  ports, host network, Docker socket or cloud metadata route.
- Only the approved documentation directory mounted read-only, plus a bounded
  ephemeral scratch tmpfs with no executable files. No other host bind mounts.
- No inherited owner home, keychain, SSH/GitHub files, application profiles,
  production environment files, plugin directories or agent memories.
- A runtime-level permission policy denies child processes, addons, workers and
  filesystem access outside the worker program and documentation. The container
  boundary remains mandatory even if the language runtime also denies an action.
- Logging is disabled for the worker's content-bearing stdio protocol. The broker
  consumes it in memory and never forwards raw stdout/stderr to operator logs.

Approved document identifiers resolve through a trusted manifest. A question
cannot choose a path, traversal segment, URL, symlink target or attachment to
read. Check the mounted manifest against the reviewed digest before accepting a
question. Documents and model outputs are untrusted text, never executable code.

## Broker protocol

Use bounded, framed messages over the worker's attached stdin/stdout. No host
socket directory needs to be mounted. The worker receives no transport credential.
Reject unknown operations and fields, duplicate/out-of-order frame IDs and
oversized or incomplete frames. Apply a fixed whole-frame deadline rather than
extending the deadline whenever a byte arrives.

The initial protocol supports a single public question, approved document text,
one model-generation operation and one reply operation. The broker fixes the
group, source message, support identity and model destination from its trusted
job descriptor; worker frames cannot override them. It does not implement a
generic HTTP, SQL, RPC, filesystem, shell, session or desktop operation.

Fetch the source through the scoped support endpoint and verify its message ID
and group before feeding the worker. Use only whitelisted response fields. Never
follow message/web/document links or redirects as part of this fetch. Model
calls go to a provisioned HTTPS endpoint with bounded request/response bodies and
an absolute deadline; no caller-controlled destination or provider credential is
accepted from a worker frame. Unrecognized model tool calls are rejected.

Submit a reply through the dedicated support endpoint, with the fixed public
source message and fresh SQL authorization. No direct insertion, owner
impersonation, outside recipient or broader-credential retry is available. The
database's explicit support marker and independent reply limit remain in force.

## Revocation and disposal

All deadlines are bounded by the grant expiry. While generation is in flight,
the broker checks live authority on a bounded interval; an expiry, authorization
failure or unavailable authority service cancels generation and closes the
worker. The database independently refuses publication after revocation, even if
the local cancellation message is delayed.

Own the exact container ID and child handle. Stop only this task's owned process
and container; do not reap unrelated hosts, engines, sessions or desktop apps.
Wait for observed exit, remove the owned container and discard scratch/context
before reporting disposal. A request to stop is not evidence that a process has
exited. Never resume the failed question using an ordinary owner session.

Persist only approved audit references, operation/result and time. Do not retain
question bodies, model prompts/answers, credentials, evidence, signed URLs or raw
worker errors in logs. Any longer context retention needs its own approved rule.

## Required executable evidence

Use synthetic records and a disposable Linux CI host. Do not install or start a
container runtime on a personal Mac to produce this evidence.

| Exercise | Required observation |
| --- | --- |
| Public question, document and reply | Actual container path succeeds with only scoped authority |
| Host owner-file sentinel and another session directory | Actual read fails; approved document read succeeds as a positive control |
| Inherited environment, mounts and process arguments | No owner/model/database/console secret or personal profile reaches the worker |
| Shell, child process and desktop operation | Denied by the actual runtime/tool boundary |
| External, private-network, metadata and redirect destinations | Worker network fails; broker refuses unapproved destinations |
| Unknown frame operation, path, scope or recipient | Rejected before any privileged broker operation |
| Trickle, oversized and unterminated frames | Bounded rejection and observed worker disposal |
| Grant expiry/revocation during a held model response | Generation is canceled, container exits, no public reply is committed |
| Ownership, membership or configuration replacement | Old authority is refused; no inherited credential retry |
| Sequential questions | Fresh container and scratch; no previous private context or orphan process |

These tests must run against the actual isolation settings, not a mocked
permission helper. Unit tests can check parsing and orchestration, but cannot
establish a mount, network or OS permission boundary. Require a non-author
permission review and exact deployment evidence before enrolling a real host or
opening the support entry. No row in this table has passed merely because this
design draft exists.
