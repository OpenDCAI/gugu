# Task input confirmation

The task composer already writes inputs to SessionInputOutbox. The outbox owns durable sender storage, sending, the stable clientMessageId and the actual send error. SessionInputQueue projects those entries as muted user bubbles with “Sending…” or the actual failure and retry. It does not own a second echo, queue or session startup state.

The outbox orders its list by the persisted enqueue position (`createdAt` is made strictly increasing at enqueue), so delivery and the visible pending bubbles use the same order. IndexedDB's UUID key order is not input order.

The ACP projection owns the native transcript subscription while sender-owned inputs exist. Stream updates do not subscribe the whole composer to confirmation reads. Confirmed history ids are memoized by the existing immutable committed-history reference; only the active turn is scanned on streaming revisions. History replacement still checks old rows, without a clock cutoff or a fixed lookback limit.

The outbox has one confirmation concept: the host has durably accepted the item with this id. Each transport adapter supplies that fact. ACP, whether local or remote, confirms through the recorded user row's `_meta.clientMessageId`. The phone's own Pi transport confirms through `accepted:true` for the same clientRequestId after persisting its job. The outbox and bubble do not select a transport.

For ACP, the existing send request carries clientMessageId through the host delivery adapter into PromptInput. The existing v2 accepted receipt and v1 dispatched receipt call the same data annotation function on the existing user row. Native turn ids and receipt handles keep their existing meanings. Runtime admission, queueing, foreground ownership and completion remain owned by their existing modules.

A successful send reply leaves the input waiting for its recorded row and suppresses another send. A matching recorded user row removes that input. A row arriving before the send reply has the same result: serialized storage updates cannot recreate a removed input. Identical text with different clientMessageIds is two inputs. Text, timing and session lifecycle never confirm an input.

Retry uses the original input and id, including its original body and attachments. The existing transport deadline can report a send error; it never confirms an input. Views filter by the confirmed ids while reconciling durable storage, so storage latency cannot duplicate an already confirmed bubble.

Validation checkpoint: focused outbox, renderer, host adapter and v1/v2 receipt guards accompany this change. Full type, unit/MCP, browser, uncached lint and renderer gates, plus real delayed-start and failure/recovery visual checks, must be recorded against the final commit before acceptance. A source check or a helper probe is not product proof.
