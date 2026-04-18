export type GitChangeKind =
  | "M"
  | "A"
  | "D"
  | "R"
  | "C"
  | "U"
  | "?";

export interface RemoteGitConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  projectPath: string;
  privateKeyPath: string;
  strictHostKeyChecking: boolean;
  statusArgs: string[];
}

export interface RemoteGitChange {
  status: string;
  code: GitChangeKind;
  path: string;
  originalPath?: string;
}

export interface RemoteGitSettingsForm {
  host: string;
  port: number;
  username: string;
  projectPath: string;
  privateKeyPath: string;
  password: string;
  strictHostKeyChecking: boolean;
}

export interface RemoteGitDiffStats {
  added: number;
  deleted: number;
  isBinary: boolean;
}

export interface NativeDiffHistoryEntry {
  lastDurationMs?: number;
  timedOut?: boolean;
  fallbackCount: number;
  lastReason?: string;
}
