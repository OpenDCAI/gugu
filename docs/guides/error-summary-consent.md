# Desktop Beta error-summary consent

This consent UI applies only to published desktop Beta builds. It does not enable
reporting on production, mobile, headless server or community/local builds.
Installing a Beta build does not imply consent. An eligible error sets only a
local encounter marker; the first interactive UI then asks once with equally
weighted Allow / Don't allow actions. The dialog remains outside the application
error boundary so a rendering failure does not automatically remove it.

Both answers are saved in the installation's `error-summary-consent.json` under
the isolated user-data directory. Each signed-in account has a separate hashed
local key; the signed-out context is separate. No identity is included in an
outgoing event. An unresolved identity or an unreadable/malformed record does not
allow reporting. Writes carry the context shown in the UI so a choice made for a
previous account cannot authorize the next account.

A failed acceptance save never enables reporting. A failed withdrawal blocks it
in memory and displays a retry message; durable withdrawal requires a successful
save. The settings switch allows the choice to be changed later. Withdrawal and
account switches synchronously cancel transport work and delete the local pending
summary file, even if no reporting endpoint is currently configured. No error
from before consent is retained for later transmission.

The internal `error-summary:read-local-consent` callback signal is used by the
separate reporting change (#1938). If that implementation is absent, this consent
change uploads nothing. It never installs an SDK or a crash-dump uploader.

Validation requires true Electron light/dark screenshots, first-error and restart
behavior, account switching, settings reversal, and storage-failure tests. No
owner account or production service may be used for acceptance.
