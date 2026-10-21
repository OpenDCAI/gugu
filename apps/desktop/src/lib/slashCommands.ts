export interface SlashCommandContext {
  setText: (updater: (prev: string) => string) => void
  clearText: () => void
}

export interface SlashCommand {
  id: string
  trigger: string
  label: string
  run: (ctx: SlashCommandContext) => void
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: 'clear',
    trigger: '/clear',
    label: '/clear',
    run: (ctx) => {
      ctx.clearText()
    },
  },
  {
    id: 'shrug',
    trigger: '/shrug',
    label: '/shrug',
    // acceptSlash already strips the leading "/token"; just append the shrug to the cleaned text.
    run: (ctx) => {
      ctx.setText((prev) => prev + '¯\\_(ツ)_/¯')
    },
  },
]
