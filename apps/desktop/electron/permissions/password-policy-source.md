# Password policy freshness and invalidation

Phase 1 uses the existing account settings read/CAS and private human-account
`gugu:user:<owner>:events` / `setting_changed` broadcast. The event contract is in
the community backend pinned by `.github/community-backend.json`: foundation
`identity.broadcast_user_setting_changed` plus the human-user-events release.
No database migration, additional policy store, approval ledger or transport is
introduced here.

Every request, pre-fill, post-pre-submit-audit and pre-confirm handoff check must
fresh-read the policy. Local permission writes synchronously withdraw existing
facts before their first settings I/O; fresh facts remain unavailable until all
in-progress local writes settle. A received valid remote user-settings change
withdraws old facts; broadcast configuration is never used as permission data.
Missing subscription, channel failure, malformed event, query failure, account
lifetime cancellation or disposal closes eligibility. Reconnection cannot
revive old facts and requires another fresh read.

As approved on 2026-11-07, **Phase 1 does not promise a zero-length interval from
a cloud policy commit to the local native action**. Disconnection detection and
notification delivery are not an atomic cloud/native transaction. Requiring a
cloud commit to prevent every subsequent local action needs an authorization /
execution coordination protocol, deferred to Phase 2; that stronger path stays
unavailable. This boundary belongs in acceptance/developer documentation, not
additional settings-page copy.

This source supplies policy facts only. The real authenticated actor lifetime,
password-specific mode, resource/protection proofs, trusted local person entry
and full native factory/acceptance must still be connected. There is currently
no production constructor call and saving/use remain unavailable. A joined
channel or a passing source test grants neither approval nor handback.
