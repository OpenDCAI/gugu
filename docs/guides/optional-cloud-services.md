# Optional official service providers

Supabase identity, messages, device permissions and the local assistant runtime are separate from the optional official hosting and model providers.

For a community backend that does not deploy either provider, set these values in its selected `.envs/<target>.env` before building:

```dotenv
GUGU_CLOUD_COMPUTER_ENABLED=false
GUGU_PLATFORM_MODELS_ENABLED=false
```

The hosting and model switches are independent. A local assistant can use an enabled official model provider, and the hosting switch does not grant access to resources or membership. The server remains authoritative for all paid access.

An explicitly disabled hosting provider has no client endpoint, even if a Supabase URL or hosting override URL is present. Local assistant setup skips the hosting membership query. An explicitly disabled model provider does not fetch an official catalog, and local assistant creation leaves model selection to the configured harness.

The values accept `true` and `false`; invalid nonempty values fail. Unset values retain existing official-build behavior. Vite bakes the values into the renderer and main/server bundles; Node source runs can read their `GUGU_*` environment values. Renderer source environments may supply the corresponding `VITE_GUGU_*` values.

Disabling a provider is configuration, not error handling. A configured provider's network, authentication or entitlement failure still surfaces as a failure. This document covers provider selection; it does not replace installation of the community database schema, storage or a working local harness with its own credentials.
