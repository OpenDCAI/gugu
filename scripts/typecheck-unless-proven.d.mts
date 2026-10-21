export function decideTypecheck(input: {
  provenSha: string
  head: string
  dirtyTypeInputs: string[]
}): { run: boolean; reason: string }
