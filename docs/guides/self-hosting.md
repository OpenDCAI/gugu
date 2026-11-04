# Run Gugu yourself

English | [简体中文](self-hosting.zh-CN.md)

Store accounts, messages and attachments in your own Supabase project, run the client from source, and use your local Agent CLI login or your own model API configuration.

## Prerequisites

- Git, the Node version in [`.node-version`](../../.node-version), and the pnpm version in [`package.json`](../../package.json).
- On macOS, Xcode command line tools to compile native modules.
- A new, dedicated Supabase project under your own account, and an SMTP service for sign-in codes.
- An installed and authenticated Agent CLI, such as Claude Code or Codex, or your own model API configuration.

## Install the community backend

Clone the client and community backend into neighboring directories:

```sh
git clone --branch dev https://github.com/OpenDCAI/gugu.git
git clone --branch dev https://github.com/OpenDCAI/gugu-supabase.git
```

Follow the backend's [self-hosting guide](https://github.com/OpenDCAI/gugu-supabase/blob/dev/docs/self-hosting.md) to prepare the project, configure SMTP, and set `SUPABASE_PROJECT_REF` and `SUPABASE_ACCESS_TOKEN` locally. Then initialize it:

```sh
cd gugu-supabase
pnpm install --frozen-lockfile
pnpm run setup --client-dir ../gugu
```

Here, `setup` is a repository script, so use `pnpm run setup`; `pnpm setup` is pnpm's built-in command. Initialization writes the client's `.envs/local.env` with public connection settings only. Keep administration tokens in your local environment, outside the client and Git.

## Start the client

```sh
cd ../gugu
pnpm install --frozen-lockfile
pnpm rebuild:native
GUGU_DB_TARGET=local bash scripts/dev/dev-app.sh
```

Run `rebuild:native` after each dependency installation to compile native modules for Electron. `GUGU_DB_TARGET=local` selects `.envs/local.env`; the launch script sets isolated `GUGU_HOME` and `GUGU_USER_DATA_DIR` paths and prints the directories, debugging port and log location. See [development tools](development-tools.md) to customize the development directories.

After signing in and completing onboarding, use your local CLI login or connect your credentials under Settings → Subscriptions, then create a local Agent.

## Files and optional services

Attachments use your own Supabase Storage. Collaborative file editing also requires the backend's `services/files`; see the [file service guide](https://github.com/OpenDCAI/gugu-supabase/blob/dev/docs/files-service.md).

Community setup disables official cloud hosting, official models and the remote-tunnel relay by default; local Agents use your own credentials. Independent hosting and model switches are described in [official service configuration](optional-cloud-services.md). The servers for official hosting, the model gateway, payments and the tunnel relay are outside the two public repositories below.

## Source repositories

| Repository | Contents |
| --- | --- |
| [gugu](https://github.com/OpenDCAI/gugu) | Desktop client, Android shell, headless server, and shared session, assistant, memory and task-orchestration code |
| [gugu-supabase](https://github.com/OpenDCAI/gugu-supabase) | Identity, messaging, sync, device communication, permissions and basic file services |

See [development tools](development-tools.md) for check commands and the [contributing guide](../../CONTRIBUTING.md) for contribution rules. License conditions are in [LICENSE](../../LICENSE); the complete Apache 2.0 text is in [LICENSE-APACHE-2.0](../../LICENSE-APACHE-2.0).
