# Agent ACP A-gate Runbook (#1064)

This runbook proves the remaining A-gate for #1064 with authoritative database
timestamps, not UI text growth:

1. create agent from the real Electron UI
2. wait for the agent to come online and send its greeting via `gugu_message`
3. send a human message in the created DM
4. wait for the agent reply
5. verify `identity.gugu_device_commands` and `chat.messages` timing

The pass criterion is `create -> greeting` and `send -> reply` under 15 seconds
unless `P0_MAX_MS` is overridden.

## Prerequisites

- Linux desktop session with Xvfb available, for example `DISPLAY=:99`.
- Supabase URL + anon key in environment. For local dev, make sure the Electron
  main process and the renderer use the same backend:

  ```bash
  set -a
  . /path/to/gugu-desktop/.env.local
  set +a
  export GUGU_SUPABASE_URL="$VITE_SUPABASE_URL"
  export GUGU_SUPABASE_ANON_KEY="$VITE_SUPABASE_ANON_KEY"
  ```

- A smoke account that can log in:

  ```bash
  export P0_EMAIL='...'
  export P0_PW='...'
  ```

- Local engine credentials already configured:
  - `claude` CLI for `claude-code`
  - `codex` for `codex`

## Start Electron

Stop other Electron instances for the same account before running this gate. The
device id is deterministic for `(machine, user, tier)`, so two local Electron
processes can advertise the same device and race to claim the same device
commands. The smoke prints `current_device=...`; make sure no older Electron
process is still running for that device.

Use an isolated user-data dir and CDP port:

```bash
export GUGU_USER_DATA_DIR=/tmp/gugu-p0-a-gate-userdata
export GUGU_HOME=/tmp/gugu-p0-a-gate-home
export GUGU_NO_SANDBOX=1
export GUGU_DEBUG_PORT=9334
export DISPLAY=:99

pnpm dev -- --host 127.0.0.1 --port 5174 --strictPort
```

Wait until Vite is ready and Electron prints `DevTools listening`.

## Run the Smoke

Claude Code:

```bash
CDP_URL=http://127.0.0.1:9334 \
  pnpm smoke:agent-acp -- --engine=claude-code --max-ms=15000
```

Codex:

```bash
CDP_URL=http://127.0.0.1:9334 \
  pnpm smoke:agent-acp -- --engine=codex --max-ms=15000
```

The script drives the real UI through CDP, but the result is decided by DB rows:

- `identity.gugu_device_commands`: `agent.create` and `agent.deliver`
- `chat.messages`: greeting and reply rows written by the agent

Successful output includes:

- command ids
- chat id
- agent user id
- `create_to_greeting_ms`
- `send_to_reply_ms`
- screenshot directory

Do not treat a screenshot or a chat list text change as proof. The command and
message timestamps are the proof.

## Interpreting Failures

- `agent.create command failed`: startup failed. Check Electron logs first; this
  should fail loud instead of letting a model run without `gugu`.
- `Timed out waiting for agent greeting message`: create completed but the agent
  did not write a `chat.messages` row through `gugu_message`.
- `create -> greeting exceeded 15000ms`: the A-gate latency bar is not met.
- `send -> reply exceeded 15000ms`: delivery/reply latency is not met.

For #1064 review, paste the JSON summary into the issue or PR comment. Keep
secrets out of the log.

## 2026-06-18 Local A-gate Evidence

Environment:

- branch: `fix/1064-a-gate-019ed91b`
- Electron: full desktop app through CDP
- backend: local Supabase `http://127.0.0.1:54321`
- device: `6e65aefe-5a60-4443-8d77-310b170aa8af`
- SLO: 15000ms for both `create -> greeting` and `send -> reply`

Claude Code:

```json
{
  "run_id": "p0-claude-code-20260618071231",
  "engine": "claude-code",
  "chat_id": "6092b13b-644b-4ea7-9e11-3026234176b5",
  "agent_user_id": "ed530d5e-deff-4d93-acce-a5b7178c8122",
  "create_command_id": "584b554e-bcf4-42e4-8d2e-13f56c906aee",
  "greeting_message_id": "e5daf613-4bbb-47bb-97ec-023fb5e0411a",
  "create_to_greeting_ms": "12558ms",
  "deliver_command_id": "8dcd8b65-d93f-4f37-a522-831dd552a7ed",
  "reply_message_id": "16095a8a-ba25-4f13-b380-5e41cab4f732",
  "send_to_reply_ms": "7152ms"
}
```

Codex:

```json
{
  "run_id": "p0-codex-20260618072155",
  "engine": "codex",
  "chat_id": "85630376-bef0-4ef8-a4bd-3c45740d75e1",
  "agent_user_id": "f71b6f15-c617-4b93-8970-f361042f0e9a",
  "create_command_id": "b36bfeb2-6cd9-4740-8e24-c4a5115b3e2a",
  "greeting_message_id": "df1942b0-9b27-4cce-90e4-f2793e64fc29",
  "create_to_greeting_ms": "14580ms",
  "deliver_command_id": "e25324fa-7366-42d1-bfb6-1a2356093410",
  "reply_message_id": "f080238c-b58d-4d7c-9869-94d9228509bf",
  "send_to_reply_ms": "5239ms"
}
```
