/**
 * #1183 — new agents default to "<tool label> <serial>" (e.g. `Codex 1`, `Codex 2`) so creating
 * several same-type agents in a row never produces multiple indistinguishable rows all named "Codex".
 *
 * #6396 — the serial only goes up. It used to be「同类型现存数量 + 1」, which handed a deleted agent's
 * number back out (owner had `Claude 28`, the next session was `Claude 18`). The name is the addressing
 * name, so a reused number makes an old「让 Claude 18 去做」point at a different agent. Now:
 *   - serial = (highest number this account has ever used for this label) + 1;
 *   - "ever used" = max(`floor`, every `<label> <n>` among the names passed in). `floor` is the server's
 *     record (identity.agent_name_serials — it also remembers deleted and renamed agents); the names
 *     cover what the server has not seen yet (a local row whose cloud half has not landed);
 *   - that is larger than every known `<label> <n>`, so it can never equal one (「保证默认不重名」).
 * The server is the authority: identity.provision_taskpage_agent lifts a candidate that is below its
 * record. A correct `floor` just means the name a session starts with is the name it keeps.
 */
export type OwnedAgentLike = { display_name: string }

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `<label> <n>` → n; anything else → null. Same shape as the server's `^(.*\S)\s+(\d{1,9})$`. */
export function agentNameSerial(name: string, label: string): number | null {
  const match = new RegExp(`^${escapeRegExp(label)}\\s+(\\d{1,9})$`).exec(name.trim())
  return match ? Number(match[1]) : null
}

export function nextAgentDefaultName(
  ownedAgents: OwnedAgentLike[],
  label: string,
  options: {
    /** Names that are taken but are not the owner's agents list (e.g. the account's cloud agents). */
    reservedNames?: Iterable<string>
    /** Highest number the server has recorded for this label (0 = none yet). */
    floor?: number
  } = {},
): string {
  // 起点比每个已知的「<label> <n>」都大,所以不会与其中任何一个逐字相同 —— 不重名由构造保证,不用再撞名往后跳。
  let highest = options.floor ?? 0
  for (const name of [...ownedAgents.map((a) => a.display_name), ...(options.reservedNames ?? [])]) {
    highest = Math.max(highest, agentNameSerial(name, label) ?? 0)
  }
  return `${label} ${highest + 1}`
}

/**
 * #1586 — derive the default name from the FRESHEST owned-agents list at submit time, not a snapshot
 * captured when the modal opened (a second agent created within ~1.5s must see the first one).
 * #6396 — together with the server's record of the highest number used, fetched in the same beat.
 *
 * Both fetches are best-effort — a transient hiccup must NOT block creation (#1183 invariant): the list
 * falls back to the caller's snapshot, the floor to 0 (the names alone still give "highest + 1").
 */
export async function resolveAgentDefaultName(
  fetchLatestOwned: () => Promise<OwnedAgentLike[]>,
  fallbackOwned: OwnedAgentLike[],
  fetchFloor: (label: string) => Promise<number>,
  label: string,
): Promise<string> {
  const [owned, floor] = await Promise.allSettled([fetchLatestOwned(), fetchFloor(label)])
  const failed = [
    ...(owned.status === 'rejected' ? [['owned-agents list → caller snapshot', owned.reason]] : []),
    ...(floor.status === 'rejected' ? [['serial floor → 0, numbering from the names alone', floor.reason]] : []),
  ]
  if (failed.length > 0) console.warn('[agent-default-name] fetch failed; falling back', failed)
  return nextAgentDefaultName(
    owned.status === 'fulfilled' ? owned.value : fallbackOwned,
    label,
    { floor: floor.status === 'fulfilled' ? floor.value : 0 },
  )
}
