# Support-agent isolation design

Refs [#1929](https://github.com/GUYI-AI/gugu/issues/1929).

Status: design branch only. No runtime, credential issuer, database permission,
host configuration or existing behavior specification is changed by this document.
The engineering lead approved implementing dedicated restricted support-agent
credentials. That decision does not establish that isolation already exists.

The help-group entry is a release dependency of the complete isolation gate:
it must stay unavailable until the reviewed gate passes. Selecting no assistants,
renaming an ordinary Agent or using a special directory does not pass it. Until
then, humans can request offline drafts using de-identified questions; Agents do
not receive raw customer input. Recovery evidence never enters an Agent.

## One support principal, with no inherited owner authority

A trusted controller provisions a dedicated support principal for one explicitly
selected Agent and the configured public help destination. Its short-lived,
revocable credential identifies the Agent, allowed source group, approved public
topic scope, effective configuration version, capabilities, expiry and revocation
handle. Tokens must be issued only after validating the duty human, ownership,
accepted membership and the isolated runtime's readiness.

The support process receives neither the human owner's JWT/refresh credentials
nor a service-role or general console key. It cannot mint, expand or refresh its
own authority outside that grant. Normal Agents retain their existing behavior;
this is an explicit support-principal boundary.

Prefer a narrow server endpoint or restricted database principal whose general
table/RPC surface is closed by default. A narrow MCP facade over a broad owner
token is insufficient: direct HTTP must be equally restricted. The exact backend
contract and issuer require implementation review; the design does not introduce
a new publicly available API by itself.

## Server authorization and delivery

Each public read, search, reply and event subscription checks the live grant,
configuration version, Agent ownership/membership, destination and capability.
Public topics must have a server-verified relationship to the configured source
group; a caller-supplied parent ID is not proof.

Only the approved group's public content and approved documents are readable.
Deny all whispers, owner DMs, unrelated groups, private customer material, console
records and recovery evidence. General message history, search, file/document
fetch, signed URLs and realtime delivery must all use the same principal scope.
Do not rely on an Agent ignoring a delivered private message.

Allow only approved public replies in the configured source group or its approved
public topics. Deny outside recipients, owner impersonation, arbitrary joins or
invitations, Agent expansion, group management and cross-session work. Retry and
refresh paths must not substitute a broader credential when a support request is
denied or expires.

## Actual execution boundary

Run the support Agent in a separate OS account, container or dedicated host with
only approved documentation mounted read-only. It must not have the owner's home,
keychain, SSH/GitHub credentials, personal browser profiles, production files,
global memories, other sessions or private support storage available to read.

Disable arbitrary shell/files, computer control and unapproved outbound requests
in the execution environment, not merely in a tool-name list. Isolate inherited
engine configuration, plugins and subprocess environments as well. If a harness
cannot meet the boundary, it is unavailable for this support role rather than
silently running with ordinary owner authority.

Network access is limited to approved service/document destinations, including
redirect and private-network boundaries. Documents, webpages and attachments are
untrusted input, never authority to widen tools, credentials or destinations.
Changing a workspace or a role prompt is not a substitute for this host boundary.

## Disablement, reassignment and observability

On disablement, removal, transfer or configuration replacement, revoke the grant,
stop in-flight work and reject subsequent reads, replies, subscriptions and token
renewals. A reply must recheck authority before publication. Clear or retain
context according to the approved retention rule; leaving a group does not prove
historical data was deleted.

Record grant/Agent references, operation, target scope, version, result and time
for allowed and rejected operations. Do not record raw user messages, evidence,
credentials or signed URLs. Human operators must be able to distinguish an
authorization rejection, expired grant and unavailable service without exposing
private diagnostics to the group.

## Verification gate

Use dedicated non-production principals, synthetic private records and hostile
customer inputs. None of these checks uses an owner's account or real recovery
evidence. A non-author permission reviewer verifies the effective server and host
boundaries; a role prompt or a self-signed checklist is not sufficient evidence.

| Attempt or state | Required observable result |
| --- | --- |
| Approved public question and document read | Working scoped read/reply using only the support principal |
| Direct REST/RPC call outside the facade | Same denial as the corresponding prohibited tool |
| Another group or a forged public-topic parent | Denial before content or identifiers are returned |
| Human whisper, owner DM or customer evidence | Neither delivered nor readable/searchable/signable |
| Outside recipient, impersonation or arbitrary join | No message, membership or expanded authority created |
| Prompt injection asks for owner files, keys or another session | The actual OS/tool boundary rejects the access |
| Unapproved network request or redirect | Blocked outside the model's discretion |
| Revocation or membership/ownership change during work | In-flight publication stops; later access/renewal fails |
| Token refresh or service failure | Visible failure; no owner-token fallback |
| Process environment and mounted files inspected | No owner credentials, personal profiles or private stores |
| Stop/restart and retained context | Only the approved support context remains accessible |

Implementation spans the trusted issuer/server enforcement, runtime provisioning,
delivery/tool integration and adversarial verification. The initial 3-6
engineer-day estimate must be revised if the credential or harness boundary needs
larger changes. The public help entry remains scheduled after this gate, with no
calendar exception. This branch is not a claim that any row above has passed.
