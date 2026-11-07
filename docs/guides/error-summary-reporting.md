# Desktop Beta error summaries

The optional `GUGU_ERROR_REPORTING_ENDPOINT` build configuration defaults to empty.
An empty/invalid value, a local build, a production build, mobile, or a headless
server does not activate the reporting host. A configured published desktop Beta
still requires explicit local consent for the current signed-in account (or the
separate signed-out context). The consent UI is tracked in #1937.

The reporting host asks the consent owner synchronously through the internal
`error-summary:read-local-consent` callback signal. If the consent host is absent,
unavailable or has not resolved the current identity, reporting remains disabled.
The local `error-summary:consent-changed` signal cancels in-flight work and clears
pending records on withdrawal or account changes. No identifiers leave the host.

Consent is checked before extracting any error properties. The renderer drops
errors immediately unless its current context is already allowed, then confirms
that same context with the main process before extraction. Withdrawal invalidates
pending checks. The host checks consent before native extraction and checks the
renderer context again on IPC receipt; the local context is never sent over HTTP.

The pure `sanitizeErrorSummary` function rebuilds an object containing only error
type, application-owned locations, version, OS and time. It drops error messages,
unknown fields, nested context, user identifiers, query keys and SDK metadata.
A second pass rejects suspected credentials, email and phone values. Source paths
are reduced to application roots; user home directories, third-party files and
URL parameters are excluded. No raw log, screenshot, memory, replay, trace,
profile, session tracking, cookie or breadcrumb collector is initialized.

The pure normalizer never reads an error stack or message. A separate runtime
boundary, called only after consent, accepts only the matching V8 native stack
accessor. It synchronously installs a private formatter, reads real CallSites,
then restores the exact previous `Error.prepareStackTrace` descriptor in `finally`.
There is no await or foreign formatter call inside that window, and no permanent
global lock. It reads only application file/line/column values; error name,
message, constructor getters, arbitrary stack strings and custom stack getters
are never used as location sources. Multiline messages cannot inject frames.
V8 caches the private formatter's controlled string (without message or function
names) on that captured Error. Weakly held sanitized locations allow repeat reads
of our own result; they do not keep the Error alive.

The main host prepends its exception-monitor and rejection listeners, ahead of
ordinary loggers that might format the stack first. This gives the original throw
point, not the collection handler. A stack previously cached by another formatter
cannot be authenticated and yields no locations. An unreplaceable formatter also
fails closed. These cases never fall back to a constant collection location.
The renderer prefers brand-checked native ErrorEvent file/line/column metadata for
published application bundles, so earlier local logging does not erase ordinary
browser error locations. Synthetic events, replacement event getters, queries,
foreign URLs and user source paths are excluded. Promise rejection/React signals
without browser location metadata can still have empty locations if their stack
was already formatted. Reviewed handled operations retain their fixed operation
code locations. Browser DOM exceptions are excluded there without reading name.

Empty-location measurement must separate eligible, configured, consented summaries
by capture path; denied/unconfigured occurrences are not its denominator. The
controlled same-realm Node test and Electron 44 run-as-node probe each produce
0/20 empty for fresh throws and 20/20 empty after prior formatting, with both
source-map-support 0.5.13 and 0.5.21 restored and still operational. This is a
coverage matrix, not an estimate of a production percentage. The deployed main
listener order and earlier renderer local logging affect the real mix. No new
outgoing measurement field or production sampler is added. Live Blink/packaged
pilot acceptance must measure that mix rather than extrapolate from these tests.

The client POSTs JSON to the configured HTTPS `/v1/beta-errors` route. The exact
request is `{ schemaVersion: 1, summary }`, where summary has only the five fields
above. The client does not transmit a DSN, project ID, SDK authentication or an
event identifier. The official intake validates approved versions and build-file
manifests, generates a random transport ID and rebuilds one event for its fixed
GlitchTip Beta project. GlitchTip configuration and credentials stay server-side.

The request uses Node fetch without the signed-in Chromium session/cookie jar,
refuses redirects and has a five-second timeout. The deployment must separately
verify GlitchTip compatibility, disable IP request logging/retention and enforce
the server-side field contract. No real receiver has been configured or deployed
by this client change.

Already-sanitized events may be saved locally (maximum 20, maximum age 24 hours).
They are rebuilt from the allowlist before transmission. Fatal JavaScript capture
saves synchronously without waiting for networking. A failed send is retried only
on a later occurrence or restart; no hot retry loop runs. Pre-consent occurrences
are not enqueued or replayed. Withdrawal and account switching clear pending work.

Coverage in this first client change: main-process uncaught JavaScript exceptions
and unhandled rejections; renderer error/rejection hooks; React boundary signals
from the consent change; renderer-process exit summaries; and an explicitly
reviewed settings-read handled-error boundary. The static handled-error entry
point is available for further reviewed boundaries. The broader handled-error
inventory, native hard-crash metadata/Crashpad, signed-package source maps,
receiver deployment, localization/legal policy changes and cross-platform crash
exercises remain separate pilot acceptance work. Raw native dumps are never sent.

Protocol v1 is defined by the client-owned five-field summary and the official
intake route. General GlitchTip guidance: https://glitchtip.com/sdkdocs/electron/.
