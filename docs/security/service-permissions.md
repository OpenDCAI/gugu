# Gugu-provided MCP service permissions

This backend foundation adds one user/Agent decision model on the authenticated Gugu MCP path. Production starts in **observation mode**: existing tools execute and return exactly as before; the new decision is only a private comparison record. Observation is not a security boundary or a claim that all existing paths filter secrets.

The newly introduced private state is excluded from Agent file access in both modes. This exclusion is independent of policy observation: an existing `files.other` grant must never expose the journal or permit manufacturing the enforcement switch.

Enforcement is off by default. There is no new UI, MCP administration tool, approval card, or credential vault in this change. Only a trusted host entry acting for the owning person may change the per-account, per-host rollout switch, read/clear the private records, or write account rules. Agent actors and other accounts are rejected. The interface must supply the person identity from authenticated host state, never deserialize it from tool arguments. Wiring that entry and enabling enforcement require the separately reviewed UI work.

## Decision contract

The account settings key `service_permissions` contains versioned user rules and Agent overrides. It uses the existing identity settings RLS and optimistic concurrency mechanism. There is no separate permission-sync protocol. A stale write fails instead of replacing newer permissions. A missing setting means `ask_some` and no standing grants; a malformed setting or unavailable current authority never becomes an allow.

1. Existing identity, group-role, App scope, device and OS checks remain mandatory in their existing dispatchers. The new layer cannot grant access through a failing existing boundary.
2. Matching locked user denials apply to every Agent.
3. Use matching rules for the actual executing Agent when present; otherwise use matching ordinary user rules. Another Agent, including a delegated child, does not inherit the caller's exceptions.
4. Within that one layer, deny wins over ask, and ask over allow, independent of rule order or selector specificity.
5. Credentials, sending as the person, expanding social access and permission changes require person confirmation every time. An allow cannot remove this requirement.
6. `always_ask` raises other allows to ask, except discovery that does not read private content. Otherwise only reviewed discovery defaults to allow; private reads, sends, execution and changes default to ask.

Decisions contain a stable reason, source, matched rule IDs and overridden ordinary rule IDs. Selectors match exact resource values and explicit namespaces; no substring or implicit path-prefix permission is inferred. The executing owner, subject, session and tool scope come from the authenticated grant, independently of who requested work in a group. Request metadata, chat assertions and `confirmed` arguments confer no permission.

## Execution and the shared App boundary

`GuguMcpHost` connects its SDK server through `permissionTransport`. Pre-call evaluation happens after bearer authentication and before handing a `tools/call` to the SDK. Post-call evaluation happens before its response is sent to the harness. This includes the core registrar and the custom App/connected-service handlers that do not use `registerTool`.

| Input | Operation evaluated |
| --- | --- |
| Direct core tool | Exact registered tool and selected resource fields |
| `catalog_call` | Recursively unpacked actual tool and its arguments |
| `device_call` | Actual device action, device and resource arguments |
| Native App gateway | Host-bound App/program namespace and actual tool |
| App through catalog | Dynamic App tool; a wrapper's allow is insufficient |
| Connected service | Host-bound integration namespace and actual tool |

The same host-stamped owner/Agent/task identity, App scope and cancellation used by the App runtime remain authoritative. This change adds no executor, page lease, native driver, projection stack, or second task lifecycle. It can therefore coexist with the App migration tracked in #1607. Each destination keeps enforcing its existing resource boundaries. The new rollout gate is local to the executing Gugu host; this change does not advertise remote policy enforcement on another host that has not enabled it.

A standing allow for a private read or an operation with an unverified resource also requires `resolveResource`, supplied by its trusted host dispatcher. It must provide the actual canonical object, including public IDs, reply-derived recipients, relative paths and other aliases. Raw selectors alone are insufficient. Until those resource adapters are integrated, the default host retains observation and enforced allows with unverified resources are raised to `resource_verification_required`. This prevents a raw alias from sidestepping an object-specific locked denial. The reviewed UI/approval entry and canonical resource adapters must both be ready before enabling enforcement; this foundation does not advertise a complete fine-grained resource sandbox.

Observation uses a nonblocking account-policy snapshot refreshed at most once every five seconds; an initial or failed snapshot is recorded as `policy_unavailable`. It never waits on a cloud query in the existing tool path. Enforcement reads current account rules before and after each call, without reusing an observed allow; reads have cancellation and a five-second network deadline. Unknown authority fails closed. Discovery does not acquire an App page or run a device action. Group rules, membership, topic lists, identity/group context and device listings are private reads, not discovery. Only target-free capability/documentation discovery may bypass resource resolution.

Enforced ask results return `owner_confirmation_required` and execute zero effects while the trusted person approval entry is absent. No reusable approval or confirmation ticket is manufactured. The operation digest helper fingerprints owner, executing Agent/session, tool and all arguments (including recipient, body and attachment references) for the future reviewed approval integration. It does not approve anything or bind the bytes of mutable files; real approval integration must bind resolved versions/content before use.

The transport follows request/grant cancellation and does not replay an uncertain operation. If post-call authority changes or post-call verification fails, enforcement withholds the result and reports that effects may have occurred, with no automatic retry. This includes calls that start in observation but become enforced while executing: a failed fresh query or an unreadable switch withholds the result. The after-record uses the effective enforcement mode. This is not rollback.

## Tool inventory

`permissions/inventory.ts` is the reviewed table of all **85 core tools and 117 device actions** on this implementation baseline. Each name has a risk and effect class. The inventory test connects to the actual product MCP composition in both provision roles and reads both native discovery and the complete paginated catalog, rather than maintaining a second list of registrars. It also constructs the real device families, including generated Computer Use actions and mixed-case names. An addition or removal without a corresponding reviewed classification fails the test.

Installed Apps and connected services are dynamic, so a static market-wide list cannot be complete. Each actual dynamic call receives a high-risk, unclassified operation; MCP read-only hints and similar names cannot downgrade it. Explicit denials still apply; an allow does not suppress its enforced confirmation requirement. New core tools fail closed as unclassified. Browser/Computer actions with opaque business effects are not treated as safe reads because their names resemble clicks or navigation.

Classification follows actual effects: `app_check` runs a page with real writes and is high-risk execution; `project_get` can join the Agent to the project group and is social access. Project association changes and the default identity-removing `session_archive` alter access and are high-risk permission operations. The explicit `remove_social_identity:false` archive variant is a reversible write. Mixed operations otherwise keep their highest known effect until a trusted adapter can distinguish them.

## Post-call and private record limits

In enforced mode the final response filters exact known tokens, common credential fields, bearer strings and selected recognizable token formats. Raw failure details are withheld. This happens before delivery into the harness's result/history path. Observation deliberately leaves both successful and failing tool responses unchanged.

Text filtering is best effort. It cannot guarantee removal of unknown secrets, images, screenshots, DOM-derived semantics, attachment bytes or arbitrary encodings. The App or resource owner must protect those observations at their own source. Gugu does not claim that post-call processing retracts a message, email, file upload, native action, HTTP request, or any other side effect already executed. Outgoing content must be authorized before that effect. Terminal-capable Agents and ordinary native programs can bypass this MCP path; this is not a computer sandbox or a defense against a compromised OS account.

Records live in an account-separated private host directory, with directory mode 0700 and file mode 0600 on Unix. No MCP reader, group message, task timeline or assistant resource index is registered for them. Native file actions and chat/session upload gateways reject this directory independently of the rollout switch, including dangling final links, chains of relative/absolute links, directory links, canonical macOS casing and absent write destinations. Resolution inspects each link entry before treating a path component as absent, and resolves parent components after link targets; cycles and unresolved errors fail closed. Recursive listings/search results omit it; ripgrep excludes it before reading; whole-tree copy, move, replacement and trash of containing directories are refused. Path checks are supplemented by a fresh protected-file identity inventory using bigint dev+ino. Ordinary hard links remain usable; aliases of protected files are denied in file, metadata and upload gateways. When protected files have additional link names, bulk copy/move/trash and grep inspect their input trees before invoking external readers; an unverifiable or over-budget tree is refused. Protected roots may be files as well as directories, and rg excludes both the root itself and descendants. Journal and switch I/O validates the opened descriptor as a regular single-link file before use; maintenance refuses to unlink a multiply linked journal, so its protected identity is retained. Unix file modes alone do not separate the host from an Agent using the same OS account. The person-only API reads/clears only its own account. Agent/session identifiers, tool decisions, rule provenance and outcomes are retained; selected targets are keyed pseudonyms. Bodies, full arguments, file contents, credentials and raw errors are never record fields. Records are pruned after 90 days and daily storage is bounded. They are not tamper-proof against the local OS account. Enforcement stops before dispatch if its required private record cannot be written; observation reports a payload-free local diagnostic without changing the tool result.

Validation exercises the authenticated HTTP MCP path, including denial/ask with zero handler calls, direct/catalog/device aliases, custom App/integration handlers, same-layer conflicts, locked denials, subject spoofing, cancellation, revoked authority after execution, result/error canaries, observation-to-enforcement query failures, native file read/write attacks against the journal/switch, real ripgrep exclusion, attachment ingestion and person-only administration. Independent review of these negative cases is required before merge.

Private file exclusions now share the trusted, startup-registered [protected private storage boundary](protected-private-storage.md). They also cover the predeclared vault root independently of this permission rollout. This does not enable vault saving or use.
