# Gugu (咕咕)

English | [简体中文](README.zh-CN.md)

Gugu puts a personal assistant, chat and device capabilities into one client. This repository contains the desktop app, the mobile shell, the headless gugu server, and the session, assistant, memory and task-orchestration code they share.

Licensed under a modified Apache License 2.0 — see [LICENSE](LICENSE). Personal use and use inside one organization need no commercial license; operating a hosted multi-tenant service for unrelated customers does. The full Apache 2.0 text is in [LICENSE-APACHE-2.0](LICENSE-APACHE-2.0); third-party components keep their own licenses (see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).

## Run it yourself

You need Git, the Node version in `.node-version`, the pnpm version in `package.json`, and a dedicated Supabase project under your own account. Models use your own Claude account or API key; the official models and official cloud hosting are optional.

1. Get the community backend [gugu-supabase](https://github.com/OpenDCAI/gugu-supabase) and initialize a new dedicated Supabase project as its README describes.
2. In the backend, run `pnpm run setup --client-dir /path/to/gugu` (plain `pnpm setup` is pnpm's own command) to write the public connection settings into this repository's `.envs/local.env`. Access tokens stay in your local environment.
3. In this repository, run `pnpm install --frozen-lockfile` and `pnpm rebuild:native`, then `GUGU_DB_TARGET=local bash scripts/dev-app.sh`.
4. Sign in with your email, add your own Claude account or API key under Settings → Subscriptions, then create a local assistant.

Sign-in uses an emailed code, so configure your own SMTP; the [self-hosting guide](https://github.com/OpenDCAI/gugu-supabase/blob/dev/docs/self-hosting.md) covers SMTP, the free Supabase plan and troubleshooting. Attachments use your own Supabase Storage; collaborative file editing additionally needs the Node service in the backend's `services/files`. See [optional official services](docs/optional-cloud-services.md) and [CONTRIBUTING](CONTRIBUTING.md).

## Repositories

| Repository | Contents |
| --- | --- |
| gugu (this repository) | Client, server, shared assistant core, memory and task orchestration, service protocols and clients |
| [gugu-supabase](https://github.com/OpenDCAI/gugu-supabase) | Identity, messaging, sync, device communication, permissions and basic file services |

Official cloud hosting, official models, payments and the remote-tunnel relay are operated separately and are not part of the open-source release. Without them, local assistants work as usual with your own model credentials.

## Checks and contributing

`pnpm typecheck` checks types and `pnpm lint` checks source rules; test projects and requirements are in [CONTRIBUTING](CONTRIBUTING.md). CI runs on GitHub-hosted runners with a disposable test database.

Most code comments are written in Chinese; contributions in English are welcome.
