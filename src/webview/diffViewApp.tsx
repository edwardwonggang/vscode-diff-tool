import React from "react";
import { createRoot } from "react-dom/client";

type PatchRow = {
  type: "context" | "delete" | "add" | "spacer";
  leftLineNumber?: number;
  rightLineNumber?: number;
  leftText?: string;
  rightText?: string;
};

declare global {
  interface Window {
    __REMOTE_GIT_DIFF_DATA__?: {
      title: string;
      stats: {
        added: number;
        deleted: number;
      };
      rows: PatchRow[];
    };
  }
}

type DiffPayload = NonNullable<typeof window.__REMOTE_GIT_DIFF_DATA__>;

function EmptyState({ title, details }: { title: string; details: string }): React.JSX.Element {
  return (
    <div className="app-shell">
      <div className="toolbar">
        <div className="title">{title}</div>
      </div>
      <div className="empty-state">
        <div className="empty-title">无法渲染差异视图</div>
        <pre className="empty-details">{details}</pre>
      </div>
    </div>
  );
}

function formatLineNumber(value?: number): string {
  return value === undefined ? "" : String(value);
}

function getRowClassName(row: PatchRow): string {
  if (row.type === "delete") {
    return "row-delete";
  }
  if (row.type === "add") {
    return "row-add";
  }
  if (
    row.type === "spacer" &&
    typeof row.leftLineNumber !== "number" &&
    typeof row.rightLineNumber !== "number" &&
    row.leftText === row.rightText &&
    (row.leftText ?? "").startsWith("@@")
  ) {
    return "row-hunk";
  }
  if (row.type === "spacer" && row.leftText && row.rightText) {
    return "row-pair";
  }
  return "row-context";
}

function DiffTable({ rows }: { rows: PatchRow[] }): React.JSX.Element {
  return (
    <table className="diff-table" cellPadding={0} cellSpacing={0}>
      <tbody>
        {rows.map((row, index) => {
          const className = getRowClassName(row);
          return (
            <tr key={`${index}-${row.leftLineNumber ?? "x"}-${row.rightLineNumber ?? "y"}`} className={className}>
              <td className="line-number">{formatLineNumber(row.leftLineNumber)}</td>
              <td className="code-cell left-code">
                <span className="code-text">{row.leftText ?? ""}</span>
              </td>
              <td className="split-divider" />
              <td className="line-number">{formatLineNumber(row.rightLineNumber)}</td>
              <td className="code-cell right-code">
                <span className="code-text">{row.rightText ?? ""}</span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function DiffApp({ payload }: { payload: DiffPayload }): React.JSX.Element {
  if (!payload.rows.length) {
    return <EmptyState title={payload.title} details="补丁内容为空，无法生成差异视图。" />;
  }

  return (
    <div className="app-shell">
      <div className="toolbar">
        <div className="title">{payload.title}</div>
        <div className="meta">
          新增 {payload.stats.added} 行，删除 {payload.stats.deleted} 行
        </div>
      </div>
      <div className="diff-host">
        <DiffTable rows={payload.rows} />
      </div>
    </div>
  );
}

function mount(): void {
  const container = document.getElementById("root");
  const payload = window.__REMOTE_GIT_DIFF_DATA__;

  if (!container) {
    return;
  }

  const root = createRoot(container);

  if (!payload) {
    root.render(<EmptyState title="Remote Git Diff" details="未收到差异数据。" />);
    return;
  }

  try {
    root.render(<DiffApp payload={payload} />);
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    root.render(<EmptyState title={payload.title} details={message} />);
  }
}

mount();
