#!/usr/bin/env bash
# @@@hot-attach-verify — repeatable REAL-MACHINE regression for the hot-attach link (#732/#734).
# Codifies the manual verification (not a paper-tiger): on a real machine, register a hot-attached agent
# in tmux, assert it reaches online (not stuck starting/exiled), and (if a DM can be resolved) assert a
# message is delivered into the pane. fail-loud on the core assertion; cleans up scratch on exit.
#
# Prereqs (documented, not faked):
#   - TARGET: ssh alias of a machine with gugu CLI + claude + tmux + a logged-in ~/.gugu (default macmini-yatu).
#   - DB_SSH: ssh alias that can reach the live supabase DB container (default pgl) — reads runtime_status +
#     resolves the agent's 咕咕号 (identity.users.gugu_number) + the owner↔agent DM.
#   - DB_CONTAINER: the supabase-db container (default supabase-db-rpf13of5osgwjexjfnajzpxl).
#
# Usage:
#   TARGET=macmini-yatu bash scripts/hot-attach-verify.sh
#
# Exit codes: 0 = core assertion (online) passed (delivery best-effort); non-zero = failed at the labelled step.
set -euo pipefail

TARGET="${TARGET:-macmini-yatu}"
DB_SSH="${DB_SSH:-pgl}"
DB_CONTAINER="${DB_CONTAINER:-supabase-db-rpf13of5osgwjexjfnajzpxl}"
AGENT_NAME="${AGENT_NAME:-hotattach-verify-$$}"
TMUX_SOCKET="${TMUX_SOCKET:-gugu}"
MARKER="HOTATTACH_VERIFY_MARKER_$$_$(date +%s)"
SESSION="haverify-$$"
GUID=""

log() { printf '%s\n' "$*" >&2; }
fail() { printf 'FAIL [%s] %s\n' "$1" "$2" >&2; exit 1; }
ssh_target() { ssh -o ConnectTimeout=12 "$TARGET" "$@"; }
db() { ssh "$DB_SSH" "docker exec -i $DB_CONTAINER psql -U postgres -t -A -c \"$1\"" 2>/dev/null || true; }

cleanup() {
  local rc=$?
  log "cleanup: killing tmux $SESSION + removing agent ${GUID:-$AGENT_NAME}"
  ssh_target "tmux -L $TMUX_SOCKET kill-session -t $SESSION 2>/dev/null || true" || true
  # remove by GUID (stable across name collisions); fall back to name
  if [ -n "$GUID" ]; then ssh_target "gugu agent remove $GUID 2>/dev/null || true" || true; fi
  exit $rc
}
trap cleanup EXIT INT TERM

# --- 1. launch claude in tmux; POLL (not fixed sleep) for the SessionStart hook to write a surface ---
log "1/4 launching claude in tmux $SESSION on $TARGET"
ssh_target "tmux -L $TMUX_SOCKET new-session -d -s $SESSION -x 220 -y 50 && tmux -L $TMUX_SOCKET send-keys -t $SESSION 'claude --dangerously-skip-permissions' Enter" \
  || fail launch "could not start claude in tmux on $TARGET"
SID=""
for i in $(seq 1 20); do   # poll up to ~20s for the capture hook to land a surface row
  SID="$(ssh_target "ls -t ~/.gugu/session-surfaces/ 2>/dev/null | head -1 | sed 's/\\.json//' || true")" || SID=""
  [ -n "$SID" ] && break
  sleep 1
done
[ -n "$SID" ] || fail capture "SessionStart hook never wrote a session-surface (capture did not land)"

# --- 2. register the agent bound to that live session; capture its GUID + 咕咕号 ---
log "2/4 registering $AGENT_NAME bound to session $SID"
ssh_target "CLAUDE_CODE_SESSION_ID=$SID gugu agent register $AGENT_NAME" || fail register "gugu agent register failed"
GUID="$(ssh_target "jq -r '.[] | select(.name==\"$AGENT_NAME\") | .gugu_user_id' ~/.gugu/agents.json 2>/dev/null || true")" || GUID=""
[ -n "$GUID" ] || fail register "could not read back the registered agent's gugu_user_id"
AGENT_HAO="$(db "SELECT gugu_number FROM identity.users WHERE id='$GUID'")"
[ -n "$AGENT_HAO" ] || fail register "could not resolve agent 咕咕号 (gugu_number) for $GUID"

# --- 3. ASSERT online (the #734 regression: NOT stuck starting / not exiled). Poll the live DB ~20s. ---
log "3/4 asserting $GUID (咕咕号 $AGENT_HAO) reaches runtime_status=online"
status=""
for i in $(seq 1 10); do
  status="$(db "SELECT runtime_status FROM identity.agent_runtime_states WHERE agent_user_id='$GUID'")"
  [ "$status" = "online" ] && break
  sleep 2
done
[ "$status" = "online" ] \
  || fail online "agent is '$status' (expected online) — stuck starting/exiled (the #734 bug if pre-fix, or capture/liveness failed)"

# --- 4. ASSERT delivery: create the owner↔agent DM via `gugu dm` (guye #741 — wraps get_or_create_dm,
#        token via CLI internal auth, never on the cmdline so no ps leak), send TO THE AGENT (not the
#        owner), grep the pane. register does NOT create a DM, so we create it here. Hard assert — no skip:
#        "message lands in the terminal" is the core of hot-attach, not optional. ---
log "4/4 creating owner↔agent DM via 'gugu dm $AGENT_HAO' + asserting delivery into $SESSION pane"
DM="$(ssh_target "gugu dm $AGENT_HAO")" || fail dm "'gugu dm $AGENT_HAO' failed"
[ -n "$DM" ] || fail dm "'gugu dm $AGENT_HAO' returned an empty chat id"
ssh_target "gugu send chat:$DM --to $AGENT_HAO '$MARKER'" || fail send "gugu send to DM $DM failed"
sleep 3
ssh_target "tmux -L $TMUX_SOCKET capture-pane -t $SESSION -p -S -50" | grep -q "$MARKER" \
  || fail deliver "marker '$MARKER' not found in the pane — message did not land in the agent terminal"

log "PASS: hot-attach verified on $TARGET — registered+online+delivered (agent $GUID / 咕咕号 $AGENT_HAO / DM $DM)"
exit 0
