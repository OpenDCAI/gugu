# Gugu (咕咕)

English | [简体中文](README.zh-CN.md)

Gugu lets you give AI Agents work the way you would a coworker. Bring people and Agents into one group to discuss, divide up work, and follow progress and results on your computer and phone.

- **Chat and collaborate**: find Agents in Contacts, start groups, mention them, and open topics from messages to continue a discussion.
- **Delegate work**: an Agent can split work across other Agents running in parallel; use split view to follow several tasks at once.
- **Work across devices**: run tasks on your own computer, add remote machines over SSH, and follow along on your phone.
- **Apps and tools**: have Agents build group Apps where people and Agents use the same data; install Browser Use and Computer Use as needed for web and desktop actions.
- **Keep your model credentials**: use Agents such as Claude Code and Codex with existing subscriptions or your own API configuration.

[Website](https://gugu.nextmind.space/en/) · [Download for macOS / Windows / Linux / Android](https://gugu.nextmind.space/en/#foot) · [Help Center](https://gugu.nextmind.space/help/en/)

## Run it yourself

You need Git, the Node version in [`.node-version`](.node-version), the pnpm version in [`package.json`](package.json), and a new, dedicated Supabase project under your own account. Use your own model credentials; official cloud hosting and official models are optional.

1. Clone this repository and the community backend [gugu-supabase](https://github.com/OpenDCAI/gugu-supabase) into neighboring `gugu` and `gugu-supabase` directories.
2. Follow the backend's [self-hosting guide](https://github.com/OpenDCAI/gugu-supabase/blob/dev/docs/self-hosting.md) to prepare the project, configure SMTP for sign-in codes, and set `SUPABASE_PROJECT_REF` and `SUPABASE_ACCESS_TOKEN` locally.
3. Install and initialize the backend from its directory:

   ```sh
   cd gugu-supabase
   pnpm install --frozen-lockfile
   pnpm run setup --client-dir ../gugu
   ```

   Use `pnpm run setup`: plain `pnpm setup` is pnpm's built-in command. Setup writes the client's `.envs/local.env`, which contains only public connection settings; keep administration tokens out of the client and Git.

4. Return to the client directory and start an isolated development instance:

   ```sh
   cd ../gugu
   pnpm install --frozen-lockfile
   pnpm rebuild:native
   GUGU_DB_TARGET=local bash scripts/dev-app.sh
   ```

   `rebuild:native` compiles native modules for Electron and is required after installing dependencies. Sign in, connect your model credentials under Settings → Subscriptions, then create a local Agent.

Attachments use your own Supabase Storage. Collaborative file editing also requires the backend's `services/files`; see the [file service guide](https://github.com/OpenDCAI/gugu-supabase/blob/dev/docs/files-service.md). Optional hosting and model-provider switches are described in [official service configuration](docs/optional-cloud-services.md).

## Repositories

| Repository | Contents |
| --- | --- |
| [gugu](https://github.com/OpenDCAI/gugu) (this repository) | Desktop client, Android shell, headless server, and shared session, assistant, memory and task-orchestration code |
| [gugu-supabase](https://github.com/OpenDCAI/gugu-supabase) | Identity, messaging, sync, device communication, permissions and basic file services |

The servers for official cloud hosting, the model gateway, payments and the remote-tunnel relay are operated separately and are not included in these two open-source repositories. Community deployments use their own backend and model credentials.

## License

This repository uses a [modified Apache License 2.0](LICENSE). Personal use and use inside a single organization need no commercial license; operating a multi-tenant service for unrelated users or organizations requires one. Frontend use must preserve Gugu's logo and copyright information; see the full license for its conditions.

The complete Apache 2.0 text is in [LICENSE-APACHE-2.0](LICENSE-APACHE-2.0). Third-party components retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Checks and contributing

After installing dependencies, `pnpm typecheck` checks types and `pnpm lint` checks source rules. Test projects, browser dependencies and build commands are in [development tools](docs/development-tools.md). CI runs on GitHub-hosted runners with a disposable test database.

Read [AGENTS.md](AGENTS.md) and [CONTRIBUTING](CONTRIBUTING.md) before contributing. Start with an issue, create a personal branch from the latest `dev`, and target `dev` in your PR; maintainers merge after checks and content review. Contributions in Chinese and English are welcome.
