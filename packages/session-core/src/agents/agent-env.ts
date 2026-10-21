/**
 * 用户 shell 里透传给 agent 的、**多家共用**的变量名:厂商 SDK 的通用约定(`OPENAI_*`、`ANTHROPIC_API_KEY`、
 * `AWS_*` 走 Bedrock、`GOOGLE_*` 走 Vertex/ADC、各家聚合平台的 key)与咕咕自己的测试开关。
 * **某一家自己的**名字(品牌前缀、它的数据根、它的模型旋钮)由那一家插件的 `sessionBundle.shellEnv.passThrough` 声明;
 * 宿主用的白名单是这两份的并集(session-plugins `agentShellEnvPassThrough`)。
 * `APP_SERVER_LOGS` 查不到是哪一家读的(历史遗留),照旧放这里。
 */
export const SHARED_AGENT_ENV_VARS = [
  'AIMLAPI_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'APP_SERVER_LOGS',
  'AWS_ACCESS_KEY_ID',
  'AWS_DEFAULT_REGION',
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AZURE_OPENAI_API_ENDPOINT',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_KEY',
  'DASHSCOPE_API_KEY',
  'GEMINI_API_KEY',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GUGU_SESSION_TEST_HOOKS',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_GENAI_API_VERSION',
  'GOOGLE_VERTEX_BASE_URL',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'MOONSHOT_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENAI_ORGANIZATION',
  'OPENAI_PROJECT',
  'OPENROUTER_API_KEY',
  'OPENROUTER_BASE_URL',
  'XAI_API_KEY',
  'ZAI_API_KEY',
] as const;

/**
 * 用户 shell 里**明确不许**透传给 agent 的变量 —— 咕咕自己管着的那几格(#5873)。
 *
 * 会话 env 有一层**底座**(`buildUserShellBaseEnv`:用户登录环境默认全过,只挡负名单),所以拒绝必须写下来,
 * 不写就是从后门放进来。这里只放与哪一家都无关的;**某一家的**(claude 的信任通道、codex 的令牌、opencode 的配置根)
 * 由那一家插件的 `sessionBundle.shellEnv.denied` 声明,宿主取并集(session-plugins `agentShellEnvDenied`)。
 *
 *  · `NODE_TLS_REJECT_UNAUTHORIZED` —— 关掉 TLS 校验。用户 shell 里为了调试留下的一个 `0`
 *    不该静默地传染给每一条 agent 会话。
 *  · `TOOLBOX_ACTION` —— 厂商自己的工具箱集成开关,与本会话无关。
 *    (2026-09-21 #6097:同组的 `GOOSE_TERMINAL` 随 goose 插件一起删掉。)
 */
export const HOST_SHELL_DENIED_ENV_VARS = [
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'TOOLBOX_ACTION',
] as const;

export const TRANSPORT_ENV_VARS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
] as const;
