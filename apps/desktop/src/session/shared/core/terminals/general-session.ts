export interface GeneralSession {
  type: 'general';
  config: GeneralSessionConfig;
}

export interface GeneralSessionConfig {
  sessionId?: string;
  cwd: string;
  projectPath?: string;
  shellSetup?: string;
  tmuxEnabled?: boolean;
  tmuxSessionName?: string;
  command?: string;
  args?: string[];
}
