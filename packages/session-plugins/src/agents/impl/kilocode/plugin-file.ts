// Verbatim source of the Kilo gugu notifications plugin, embedded as a string constant.
export const KILOCODE_PLUGIN_CONTENT = `\
/* global fetch, process */

export const GuguNotifications = async () => ({
  event: async ({ event }) => {
    const port = process.env.GUGU_HOOK_PORT;
    const token = process.env.GUGU_HOOK_TOKEN;
    const ptyId = process.env.GUGU_PTY_ID;
    if (!port || !token || !ptyId) return;

    const sessionId = getKiloSessionId(event);
    if (sessionId) {
      await postToGugu({ port, token, ptyId, type: 'session', body: { sessionId } });
    }

    const payload = toGuguPayload(event);
    if (!payload) return;

    await postToGugu({ port, token, ptyId, type: payload.type, body: payload.body });
  },
});

async function postToGugu({ port, token, ptyId, type, body }) {
  try {
    await fetch(\`http://127.0.0.1:\${port}/hook\`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Gugu-Token': token,
        'X-Gugu-Pty-Id': ptyId,
        'X-Gugu-Event-Type': type,
      },
      signal: AbortSignal.timeout(2000),
      body: JSON.stringify(body),
    });
  } catch {
    // Hook delivery is best-effort and must never interrupt Kilo.
  }
}

function getKiloSessionId(event) {
  if (!event.type?.startsWith('session.')) return undefined;

  const infoId = event.properties?.info?.id;
  if (isKiloSessionId(infoId)) return infoId.trim();

  const sessionId = event.properties?.sessionID;
  if (isKiloSessionId(sessionId)) return sessionId.trim();

  return undefined;
}

function isKiloSessionId(value) {
  return typeof value === 'string' && value.trim().startsWith('ses');
}

function toGuguPayload(event) {
  // session.idle 就是这一轮结束:报 stop(与 codex 适配器同口径),❌ 报成 idle_prompt ——
  // 那样宿主拿不到「回合结束」这条边,完成横幅、提示音与做完未读都会丢(spec hook-status-derivation)。
  if (event.type === 'session.idle') {
    return {
      type: 'stop',
      body: {
        title: 'Kilo',
        message: 'Kilo finished the turn.',
      },
    };
  }

  if (event.type === 'session.error') {
    return {
      type: 'error',
      body: {
        title: 'Kilo error',
        message: typeof event.properties?.error === 'string' ? event.properties.error : undefined,
      },
    };
  }

  return undefined;
}
`;
