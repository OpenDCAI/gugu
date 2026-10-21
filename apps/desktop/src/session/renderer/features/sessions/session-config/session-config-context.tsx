import { createContext, useContext } from 'react';

export type SessionConfigOptions = {
  /** Whether PR-related presets are visible. Set to false in automation contexts. Defaults to true. */
  showPrPresets?: boolean;
  /** When true, BranchNameField shows a read-only "auto-generated" placeholder instead of an input. Defaults to false. */
  autoBranchName?: boolean;
};

type ResolvedSessionConfig = Required<SessionConfigOptions>;

const defaults: ResolvedSessionConfig = {
  showPrPresets: true,
  autoBranchName: false,
};

const SessionConfigContext = createContext<ResolvedSessionConfig>(defaults);

export function SessionConfigProvider({
  children,
  showPrPresets,
  autoBranchName,
}: SessionConfigOptions & { children: React.ReactNode }) {
  const value: ResolvedSessionConfig = {
    showPrPresets: showPrPresets ?? defaults.showPrPresets,
    autoBranchName: autoBranchName ?? defaults.autoBranchName,
  };

  return <SessionConfigContext.Provider value={value}>{children}</SessionConfigContext.Provider>;
}

export function useSessionConfig(): ResolvedSessionConfig {
  return useContext(SessionConfigContext);
}
