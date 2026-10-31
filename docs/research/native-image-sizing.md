# Native screenshot sizing investigation

Status: proposal only. Refs #1015. Checked on 2026-10-30.

Do not enable blanket image pre-resizing. Both native clients tested already resize images before their API requests. Preserve the stored original, resolve the exact model and native-client capabilities, and keep the existing native-client behavior until a reviewed policy has reliable fidelity and latency evidence.

## Current path

The measured client source is `bae11a4c345d02a88cb2ea0d2377a6b74949a6ca`.

- `LocalAttachmentStore` stores the supplied bytes. `packages/session-runtime/src/acp-agents/node/boot.ts` reads them and encodes base64. `session/cell.ts` creates ACP image blocks without resizing.
- `apps/desktop/electron/runtime/codex-app-server-prompt.mjs` maps each image to `{ type: 'image', url: 'data:…;base64,…' }`. The mapper currently omits `detail`.
- The installed Claude ACP adapter (`@gugu-acp/claude-agent-acp@1.5.2`) maps ACP data to a Claude `image` block with a base64 source. The resolved SDK is 0.3.303, but the actual descendant process used the installed Claude Code **2.1.296**. The SDK also ships a 2.1.303 binary; package version alone would misidentify the executable used in this test.
- The tested Codex CLI is 0.160.0. Native-client preprocessing happens after the Gugu mappings above; preserving an image in the mapper does not establish that the API receives its original dimensions.

The retained original attachment was independently checked as 3840×2100 with its original byte count. At native-client HTTP egress, that image became 2000×1094 for Claude Code and 2048×1120 for Codex. Repeated runs produced the same respective image hashes and byte counts. These are observed limits for these versions and configurations, not general model limits.

## Official model limits

Claude has both an edge limit and a visual-token budget. Standard-tier images must satisfy a 1568px edge and 1568-token budget; the high-resolution tier uses 2576px and 4784 tokens. The token calculation is `ceil(width / 28) * ceil(height / 28)`. Use the documented fitting algorithm, including its rounding and padding rules, rather than scaling only the longest edge. For this 3840×2100 input the fitted sizes are **1485×812** and **2576×1409**, respectively. [Claude coordinate and resizing documentation](https://platform.claude.com/docs/en/build-with-claude/vision-coordinates).

Claude's current documentation assigns high-resolution support by model generation, automatically for 4.7 and later. The measured model was `claude-sonnet-5-5`; the smaller standard-tier candidate below is an experimental comparison, not its maximum native resolution. [Claude vision documentation](https://platform.claude.com/docs/en/build-with-claude/vision).

OpenAI detail behavior is model-specific. Supported models can offer `original`, and `auto` does not mean the same sizing behavior across all families. Some original modes retain source dimensions while others still impose a native dimension or patch budget. The current table does not separately specify the measured `gpt-6-luna` identifier, so its API-level original capability remains unverified here. Do not impose Claude's limits on OpenAI or unknown models. [OpenAI images and vision](https://developers.openai.com/api/docs/guides/images-vision).

Codex 0.160.0's locally generated app-server schema accepts `detail: auto | low | high | original` on image and local-image input. Schema support establishes a transport option, not end-to-end fidelity for an arbitrary model. A follow-up must verify that the selected model and CLI preserve original dimensions when explicitly requested. [App-server protocol and schema generation](https://developers.openai.com/codex/app-server).

## 3840×2100 experiment

The source was a real hidden app screenshot at 1920×1050 CSS pixels and scale 2. Variants used aspect-preserving Lanczos resampling and optimized PNG encoding. The original file was left untouched. Re-encoding the original without resizing produced 368169 bytes, larger than its 348404-byte source; encoding alone is not automatically a saving.

| Input                   | Pixels    | PNG bytes | Base64 bytes | Claude patches (28px) |
| ----------------------- | --------- | --------: | -----------: | --------------------: |
| Original                | 3840×2100 |    348404 |       464540 |                 10350 |
| Standard-tier candidate | 1485×812  |    172753 |       230340 |                  1566 |
| High-tier candidate     | 2576×1409 |    364631 |       486176 |                  4692 |

A smaller PNG can grow when resampling adds antialiased edges. Always compare encoded byte counts if bandwidth is the objective.

| Native client / input            | API image dimensions | API image bytes | Change from its original-input path |
| -------------------------------- | -------------------- | --------------: | ----------------------------------: |
| Claude / original                | 2000×1094            |          242138 |                            baseline |
| Claude / high-tier candidate     | 2000×1094            |          269151 |                              +11.2% |
| Claude / standard-tier candidate | 1485×812             |          172753 |                              −28.7% |
| Codex / original                 | 2048×1120            |          269659 |                            baseline |
| Codex / standard-tier candidate  | 1485×812             |          172753 |                              −35.9% |

The high-tier candidate is resized again by this Claude Code version and sends more bytes than supplying the original. The standard-tier candidate reduces bytes by discarding resolution that the measured high-resolution model could otherwise use.

### First visible text

Each measured case used a separate native session with a completed text warmup, followed by the same screenshot-reading prompt. Benchmark cases were sent sequentially in the final matrix. Native default reasoning settings were retained. The end-to-end clock starts at the send action and stops on the first new assistant text in that session; the HTTP clock starts at native-client egress and stops on the first text delta. It excludes reasoning-only events and heartbeats. The metadata observer added approximately 2–4ms of parsing before request submission.

The final comparison has **two samples per row**. All ten selected cases returned HTTP 200 on their first image-request attempt. An earlier exploratory Claude case with transient 503 retries and a contaminated UI warmup reading is excluded. Earlier low-effort Codex pilot runs are also excluded from the matrix.

| Client / input (2 samples each) | UI first text, seconds | UI median | HTTP first text, seconds |
| ------------------------------- | ---------------------- | --------: | ------------------------ |
| Claude / original               | 8.130, 9.851           |     8.991 | 7.767, 9.398             |
| Claude / claude-high            | 5.250, 6.508           |     5.879 | 4.925, 6.015             |
| Claude / claude-standard        | 4.877, 5.906           |     5.391 | 4.645, 5.744             |
| Codex / original                | 7.208, 8.183           |     7.696 | 6.554, 7.592             |
| Codex / claude-standard         | 8.596, 10.440          |     9.518 | 8.079, 9.936             |

These small samples do not establish a causal latency improvement or compare provider speed. Claude's smaller candidates were faster in this sample; Codex's smaller candidate was slower. Network scheduling, backend load, caching, and model reasoning remain uncontrolled sources of variation. The visible file label was read successfully; this is not a dense-OCR or coordinate-fidelity acceptance suite.

## Proposed policy for review

1. **Keep the original immutable.** Retain its file, attachment identity and MIME. A model-specific derivative is an internal handoff representation, not another message attachment. Reuse the original upload and retry identity; do not replace stored content under an existing upload ID.
2. **Make one layer responsible.** Default to native-client preprocessing. Introduce no second resize for a client that already satisfies the chosen target. Identify capabilities by provider, exact model, CLI version and explicit detail mode; unknown entries preserve the original and use existing behavior.
3. **Preserve supported original detail.** Before adding Gugu resizing, validate an explicit `original` input through Codex for a documented supporting model. Carry detail through the mapper when approved. Never silently map an original-capable input to a fixed Claude-sized derivative.
4. **Use both Claude constraints.** A reviewed legacy standard-tier policy uses the official edge-plus-token fit. A high-tier policy must also account for the CLI's actual preprocessing: 2576px input currently does not bypass the observed 2000px Claude Code resize. Prefer a supported CLI capability or upgrade over compensating with an undocumented override.
5. **Create derivatives only for a proven objective.** Compute them at model handoff so the transcript and stored original remain unchanged. Cache by original hash, policy version, model/client capabilities and encoding parameters. If the objective is bandwidth, use a derivative only when it reduces encoded bytes; fidelity or coordinate targets require their own explicit decision.
6. **Retain geometry.** Keep original and transmitted dimensions plus crop offsets with the internal handoff. Map returned coordinates using the actual image dimensions. For small text, test crops or zoomed regions against full-image downscaling.

Before enabling a policy, add capability-matrix tests for supported original detail, unknown models, both Claude tiers, already-small images, image orientation, immutable originals, cancellation/retry identity and coordinate round trips. Exercise the native clients rather than only mocking adapter payloads. Expand performance trials across screenshot content and network conditions; use a dense small-text fixture to assess accuracy alongside bytes and first text.

No production resizing, model defaults, attachment storage, retry behavior or UI is changed by this research document.
