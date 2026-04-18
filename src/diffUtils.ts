import { NativeDiffHistoryEntry, RemoteGitDiffStats } from "./types";

export interface PatchRow {
  type: "context" | "delete" | "add" | "spacer";
  leftLineNumber?: number;
  rightLineNumber?: number;
  leftText?: string;
  rightText?: string;
}

export function createJsonPayload(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function parseHunkHeader(header: string): { leftStart: number; rightStart: number } {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
  return {
    leftStart: match ? Number(match[1]) : 0,
    rightStart: match ? Number(match[2]) : 0
  };
}

export function buildPatchRows(patch: string): PatchRow[] {
  const rows: PatchRow[] = [];
  const lines = patch.split(/\r?\n/);
  let leftLine = 0;
  let rightLine = 0;
  let pendingDeletes: string[] = [];
  let pendingAdds: string[] = [];

  const flushChangedRows = (): void => {
    const count = Math.max(pendingDeletes.length, pendingAdds.length);
    for (let index = 0; index < count; index += 1) {
      const deleted = pendingDeletes[index];
      const added = pendingAdds[index];
      rows.push({
        type: deleted !== undefined && added === undefined ? "delete" : added !== undefined && deleted === undefined ? "add" : "spacer",
        leftLineNumber: deleted !== undefined ? leftLine++ : undefined,
        rightLineNumber: added !== undefined ? rightLine++ : undefined,
        leftText: deleted ?? "",
        rightText: added ?? ""
      });
    }
    pendingDeletes = [];
    pendingAdds = [];
  };

  for (const line of lines) {
    if (!line || line.startsWith("diff --git ") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
      continue;
    }

    if (line.startsWith("@@")) {
      flushChangedRows();
      const parsed = parseHunkHeader(line);
      leftLine = parsed.leftStart;
      rightLine = parsed.rightStart;
      rows.push({
        type: "spacer",
        leftText: line,
        rightText: line
      });
      continue;
    }

    if (line.startsWith("-")) {
      pendingDeletes.push(line.slice(1));
      continue;
    }

    if (line.startsWith("+")) {
      pendingAdds.push(line.slice(1));
      continue;
    }

    flushChangedRows();

    if (line.startsWith(" ")) {
      const text = line.slice(1);
      rows.push({
        type: "context",
        leftLineNumber: leftLine++,
        rightLineNumber: rightLine++,
        leftText: text,
        rightText: text
      });
      continue;
    }

    if (line.startsWith("\\")) {
      rows.push({
        type: "spacer",
        leftText: line,
        rightText: line
      });
    }
  }

  flushChangedRows();
  return rows;
}

export function shouldUsePatchView(
  stats: RemoteGitDiffStats,
  leftLength: number,
  rightLength: number,
  largeDiffThresholdBytes: number,
  largeChangeThresholdLines: number
): boolean {
  const maxLength = Math.max(leftLength, rightLength);
  const totalChangedLines = stats.added + stats.deleted;
  const veryLargeChangeThresholdLines = Math.max(1000, largeChangeThresholdLines * 4);
  const mediumDiffThresholdBytes = Math.max(50_000, Math.floor(largeDiffThresholdBytes / 5));

  if (maxLength > largeDiffThresholdBytes && totalChangedLines > largeChangeThresholdLines) {
    return true;
  }

  if (maxLength > mediumDiffThresholdBytes && totalChangedLines > veryLargeChangeThresholdLines) {
    return true;
  }

  return false;
}

export interface NativeDiffDecisionInput {
  path: string;
  stats: RemoteGitDiffStats;
  leftLength: number;
  rightLength: number;
  largeDiffThresholdBytes: number;
  largeChangeThresholdLines: number;
  history?: NativeDiffHistoryEntry;
}

export interface NativeDiffDecision {
  shouldUseNative: boolean;
  reason: string;
}

export interface LargeDiffSummaryInput {
  stats: RemoteGitDiffStats;
  leftLength: number;
  rightLength: number;
}

function hasCsvLikeExtension(path: string): boolean {
  return /\.(csv|tsv|tab|psv)$/i.test(path);
}

export function shouldUseSummaryView(input: LargeDiffSummaryInput): boolean {
  const { stats, leftLength, rightLength } = input;
  const totalChangedLines = stats.added + stats.deleted;
  const maxLength = Math.max(leftLength, rightLength);

  if (totalChangedLines >= 50_000) {
    return true;
  }

  if (maxLength >= 3_000_000 && totalChangedLines >= 10_000) {
    return true;
  }

  if (maxLength >= 1_000_000 && totalChangedLines >= 25_000) {
    return true;
  }

  return false;
}

export function decideNativeDiff(input: NativeDiffDecisionInput): NativeDiffDecision {
  const {
    path,
    stats,
    leftLength,
    rightLength,
    largeDiffThresholdBytes,
    largeChangeThresholdLines,
    history
  } = input;
  const maxLength = Math.max(leftLength, rightLength);
  const minLength = Math.min(leftLength, rightLength);
  const totalChangedLines = stats.added + stats.deleted;
  const isCsvLike = hasCsvLikeExtension(path);
  const isLikelyRewrite = maxLength > 0 && minLength / maxLength < 0.4;

  if (history?.timedOut) {
    return {
      shouldUseNative: false,
      reason: "history-timeout"
    };
  }

  if ((history?.lastDurationMs ?? 0) >= 8000) {
    return {
      shouldUseNative: false,
      reason: "history-slow"
    };
  }

  if (shouldUseSummaryView({ stats, leftLength, rightLength })) {
    return {
      shouldUseNative: false,
      reason: "summary-too-large"
    };
  }

  if (shouldUsePatchView(stats, leftLength, rightLength, largeDiffThresholdBytes, largeChangeThresholdLines)) {
    return {
      shouldUseNative: false,
      reason: "large-change-threshold"
    };
  }

  if (isCsvLike && maxLength >= 1_000_000 && totalChangedLines >= 2000) {
    return {
      shouldUseNative: false,
      reason: "csv-extreme-size-and-change"
    };
  }

  if (isCsvLike && maxLength >= 300_000 && totalChangedLines >= 800 && isLikelyRewrite) {
    return {
      shouldUseNative: false,
      reason: "csv-rewrite-like"
    };
  }

  if (maxLength >= 1_500_000 && totalChangedLines >= 4000 && isLikelyRewrite) {
    return {
      shouldUseNative: false,
      reason: "extreme-rewrite-like"
    };
  }

  return {
    shouldUseNative: true,
    reason: "native-ok"
  };
}
