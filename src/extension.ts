import * as vscode from "vscode";
import { ChangeTreeProvider } from "./changeTreeProvider";
import { buildPatchRows, createJsonPayload, decideNativeDiff, PatchRow } from "./diffUtils";
import { InteractionController } from "./interactionController";
import { RemoteGitContentProvider } from "./documentProvider";
import { ExtensionLogger } from "./logger";
import { RemoteGitService } from "./remoteGitService";
import { SshConnectionEvent, SshRunner } from "./sshRunner";
import { NativeDiffHistoryEntry, RemoteGitChange, RemoteGitDiffStats, RemoteGitSettingsForm } from "./types";

const REMOTE_GIT_SCHEME = "remote-git-diff";
const DEFAULT_LARGE_DIFF_THRESHOLD = 250_000;
const DEFAULT_LARGE_CHANGE_THRESHOLD = 200;
const PATCH_CONTEXT_LINES = 3;
const SELF_TEST_OPEN_DIFF_TIMEOUT_MS = 20_000;
const NATIVE_DIFF_HISTORY_KEY = "remoteGitDiff.nativeDiffHistory";
const MAX_PATCH_ROWS_FOR_WEBVIEW = 20_000;
const MAX_PATCH_BYTES_FOR_WEBVIEW = 2_500_000;

type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting" | "error";

function isConnectedState(state: ConnectionState): boolean {
  return state === "connected";
}

function buildContentUri(side: "left" | "right", change: RemoteGitChange): vscode.Uri {
  const suffix = side === "left" ? "HEAD" : "WORKTREE";
  return vscode.Uri.parse(
    `${REMOTE_GIT_SCHEME}:/${suffix}/${encodeURIComponent(change.path)}?side=${side}&path=${encodeURIComponent(change.path)}`
  );
}

function isRemoteGitChange(value: unknown): value is RemoteGitChange {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<RemoteGitChange>;
  return typeof candidate.path === "string" && candidate.path.length > 0;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(task: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return await Promise.race([
    task,
    sleep(timeoutMs).then(() => {
      throw new Error(message);
    })
  ]);
}

async function waitForTab(labelIncludes: string, timeoutMs = 15000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const labels = vscode.window.tabGroups.all.flatMap((group) => group.tabs.map((tab) => tab.label));
    if (labels.some((label) => label.includes(labelIncludes))) {
      return;
    }
    await sleep(200);
  }
  throw new Error(`未在标签页中看到 ${labelIncludes}`);
}

function getOpenEditorLabels(): string[] {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs.map((tab) => tab.label));
}

function getFileName(filePath: string): string {
  return filePath.split("/").at(-1) ?? filePath;
}

function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

let patchViewStylesCache: string | undefined;

function getPatchViewStyles(): string {
  if (patchViewStylesCache) {
    return patchViewStylesCache;
  }

  const vscodeThemeCss = `
    body {
      margin: 0;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family);
    }
    .app-shell {
      display: grid;
      grid-template-rows: auto 1fr;
      height: 100vh;
    }
    .toolbar {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      padding: 10px 14px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background));
    }
    .title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
      font-weight: 600;
    }
    .meta {
      flex-shrink: 0;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .diff-host {
      overflow: auto;
      padding: 0 0 16px;
    }
    .diff-table {
      width: max-content;
      min-width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      font-family: var(--vscode-editor-font-family, Consolas, monospace);
      font-size: var(--vscode-editor-font-size, 13px);
      line-height: 1.45;
    }
    .line-number {
      width: 4.5rem;
      min-width: 4.5rem;
      padding: 0 8px;
      text-align: right;
      color: var(--vscode-editorLineNumber-foreground);
      background: var(--vscode-editor-background);
      border-right: 1px solid var(--vscode-panel-border);
      user-select: none;
      vertical-align: top;
    }
    .code-cell {
      width: 72ch;
      min-width: 72ch;
      max-width: 72ch;
      padding: 0 8px;
      white-space: pre;
      word-break: normal;
      overflow-wrap: normal;
      overflow: hidden;
      text-overflow: clip;
      tab-size: 2;
      vertical-align: top;
    }
    .code-text {
      display: block;
      overflow: hidden;
      text-overflow: clip;
      white-space: pre;
    }
    .row-delete .left-code,
    .row-pair .left-code {
      background: var(--vscode-diffEditor-removedLineBackground, rgba(255, 0, 0, 0.14));
    }
    .row-add .right-code,
    .row-pair .right-code {
      background: var(--vscode-diffEditor-insertedLineBackground, rgba(155, 185, 85, 0.18));
    }
    .row-hunk .code-cell,
    .row-hunk .line-number {
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-editorLineNumber-activeForeground, rgba(127, 127, 127, 0.16));
      font-weight: 600;
    }
    .split-divider {
      width: 1px;
      min-width: 1px;
      padding: 0;
      background: var(--vscode-panel-border);
    }
    .empty-state {
      display: grid;
      gap: 12px;
      align-content: start;
      padding: 24px;
    }
    .empty-title {
      font-size: 14px;
      font-weight: 600;
    }
    .empty-details {
      margin: 0;
      padding: 12px;
      overflow: auto;
      white-space: pre-wrap;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      background: var(--vscode-textCodeBlock-background, rgba(127, 127, 127, 0.08));
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-editor-font-family, Consolas, monospace);
      font-size: 12px;
      line-height: 1.5;
    }
  `;

  patchViewStylesCache = vscodeThemeCss;
  return patchViewStylesCache;
}


function getConfigHtml(form: RemoteGitSettingsForm, suggestedPath: string): string {
  const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  return `<!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>远程 Git Diff 配置</title>
    <style>
      body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 20px; }
      .wrap { max-width: 920px; margin: 0 auto; display: grid; gap: 16px; }
      .card { border: 1px solid var(--vscode-panel-border); border-radius: 10px; padding: 18px; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); }
      h1, h2 { margin: 0 0 12px; font-weight: 600; }
      p { margin: 0; line-height: 1.6; color: var(--vscode-descriptionForeground, var(--vscode-foreground)); }
      .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
      .full { grid-column: 1 / -1; }
      label { display: grid; gap: 6px; font-size: 12px; color: var(--vscode-descriptionForeground, var(--vscode-foreground)); }
      input[type="text"], input[type="number"], input[type="password"] { width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 6px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); background: var(--vscode-input-background); color: var(--vscode-input-foreground); outline: none; }
      .toolbar { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
      button { border: 1px solid transparent; border-radius: 6px; padding: 8px 14px; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
      button.secondary { background: var(--vscode-button-secondaryBackground, var(--vscode-editorWidget-background)); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); border-color: var(--vscode-panel-border); }
      .hint { font-size: 12px; opacity: 0.85; }
      .status { min-height: 24px; font-size: 12px; white-space: pre-wrap; color: var(--vscode-descriptionForeground, var(--vscode-foreground)); }
      .row { display: flex; align-items: center; gap: 10px; }
      code { font-family: var(--vscode-editor-font-family, monospace); }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <h1>远程 Git Diff 配置</h1>
        <p>在这里一次性完成服务器连接、仓库路径和认证配置。保存后会长期复用，切回 VS Code 时也会自动刷新。</p>
      </div>
      <div class="card">
        <h2>连接配置</h2>
        <div class="grid">
          <label>SSH 主机<input id="host" type="text" value="${escapeHtml(form.host)}" /></label>
          <label>SSH 端口<input id="port" type="number" value="${String(form.port)}" /></label>
          <label>SSH 用户名<input id="username" type="text" value="${escapeHtml(form.username)}" /></label>
          <label>SSH 密码<input id="password" type="password" value="${escapeHtml(form.password)}" placeholder="留空表示保留已保存密码" /></label>
          <label class="full">私钥路径<input id="privateKeyPath" type="text" value="${escapeHtml(form.privateKeyPath)}" placeholder="可选，例如 C:\\Users\\name\\.ssh\\id_rsa" /></label>
          <label class="full">Linux 仓库路径<input id="projectPath" type="text" value="${escapeHtml(form.projectPath)}" placeholder="/home/user/src/project" /></label>
          <div class="full row">
            <input id="strictHostKeyChecking" type="checkbox" ${form.strictHostKeyChecking ? "checked" : ""} />
            <label for="strictHostKeyChecking">启用严格主机校验</label>
          </div>
        </div>
        <p class="hint">建议路径：<code id="suggestedPath">${escapeHtml(suggestedPath || "(暂无)")}</code></p>
        <div class="toolbar">
          <button id="useSuggested" class="secondary">使用建议路径</button>
          <button id="save" class="secondary">仅保存</button>
          <button id="test">测试连接</button>
          <button id="saveConnect">保存并连接</button>
        </div>
        <div id="status" class="status"></div>
      </div>
    </div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const status = document.getElementById('status');
      const suggestedPath = document.getElementById('suggestedPath');
      const getForm = () => ({
        host: document.getElementById('host').value.trim(),
        port: Number(document.getElementById('port').value || '22'),
        username: document.getElementById('username').value.trim(),
        password: document.getElementById('password').value,
        privateKeyPath: document.getElementById('privateKeyPath').value.trim(),
        projectPath: document.getElementById('projectPath').value.trim(),
        strictHostKeyChecking: document.getElementById('strictHostKeyChecking').checked
      });
      document.getElementById('useSuggested').addEventListener('click', () => {
        document.getElementById('projectPath').value = suggestedPath.textContent === '(暂无)' ? '' : suggestedPath.textContent;
      });
      document.getElementById('save').addEventListener('click', () => vscode.postMessage({ type: 'save', form: getForm() }));
      document.getElementById('test').addEventListener('click', () => {
        status.textContent = '正在测试连接...';
        vscode.postMessage({ type: 'test', form: getForm() });
      });
      document.getElementById('saveConnect').addEventListener('click', () => {
        status.textContent = '正在保存并连接...';
        vscode.postMessage({ type: 'saveConnect', form: getForm() });
      });
      window.addEventListener('message', (event) => {
        const message = event.data;
        if (message.type === 'status') {
          status.textContent = message.text;
        }
      });
    </script>
  </body>
  </html>`;
}

function getPatchDiffHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  change: RemoteGitChange,
  rows: PatchRow[],
  stats: RemoteGitDiffStats
): string {
  const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const title = change.originalPath ? `${change.originalPath} -> ${change.path}` : change.path;
  const payload = createJsonPayload({
    title,
    stats,
    rows
  });
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "diffView.js"));
  const styles = getPatchViewStyles();

  return `<!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
    <style>${styles}</style>
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}">
      window.__REMOTE_GIT_DIFF_DATA__ = ${payload};
    </script>
    <script src="${scriptUri}"></script>
  </body>
  </html>`;
}

function getLargeDiffSummaryHtml(
  change: RemoteGitChange,
  stats: RemoteGitDiffStats,
  details: { leftLength: number; rightLength: number; reason: string; patchLength?: number }
): string {
  const title = change.originalPath ? `${change.originalPath} -> ${change.path}` : change.path;
  const styles = getPatchViewStyles();
  const patchLine = details.patchLength === undefined ? "" : `\nPatch 大小：${formatBytes(details.patchLength)}`;

  return `<!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
    <style>${styles}</style>
  </head>
  <body>
    <div class="app-shell">
      <div class="toolbar">
        <div class="title">${escapeHtml(title)}</div>
        <div class="meta">超大变更摘要</div>
      </div>
      <div class="empty-state">
        <div class="empty-title">该变更规模过大，已阻止加载完整自定义 Diff 以避免 VS Code 卡死。</div>
        <pre class="empty-details">原因：${escapeHtml(details.reason)}
新增：${stats.added} 行
删除：${stats.deleted} 行
HEAD 大小：${formatBytes(details.leftLength)}
工作区大小：${formatBytes(details.rightLength)}${patchLine}

建议：
1. 先缩小变更范围后再查看
2. 使用远端命令按目录/片段拆分 diff
3. 对超大重写文件优先看 git diff --stat 或外部比较工具</pre>
      </div>
    </div>
  </body>
  </html>`;
}

async function openConfigurationPanel(
  context: vscode.ExtensionContext,
  service: RemoteGitService,
  refresh: (reason?: string) => Promise<void>
): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    "remoteGitDiff.settings",
    "远程 Git Diff 配置",
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  const form = await service.getSettingsForm();
  const suggestedPath = service.getSuggestedProjectPath(form.host, form.username, form.projectPath);
  panel.webview.html = getConfigHtml(form, suggestedPath);

  const disposable = panel.webview.onDidReceiveMessage(async (message) => {
    const formData = message.form as RemoteGitSettingsForm;
    try {
      if (message.type === "save") {
        await service.saveSettings(formData);
        void panel.webview.postMessage({ type: "status", text: "配置已保存。" });
        return;
      }

      if (message.type === "test") {
        const result = await service.testConnection(formData);
        void panel.webview.postMessage({ type: "status", text: `连接成功：\n${result}` });
        return;
      }

      if (message.type === "saveConnect") {
        await service.saveSettings(formData);
        await refresh("save-connect");
        void panel.webview.postMessage({ type: "status", text: "配置已保存，并已完成连接刷新。" });
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      void panel.webview.postMessage({ type: "status", text: `失败：${messageText}` });
    }
  });

  context.subscriptions.push(panel, disposable);
}

async function ensureConnectionConfigured(
  context: vscode.ExtensionContext,
  service: RemoteGitService,
  refresh: (reason?: string) => Promise<void>
): Promise<boolean> {
  const config = await service.getConfig();
  const workspacePath = service.getWorkspacePath();
  const isRemoteWorkspace = Boolean(vscode.env.remoteName);
  const looksLikeWindowsWorkspace = /^[a-zA-Z]:\\/.test(workspacePath);

  if (config.host || isRemoteWorkspace) {
    return true;
  }

  if (!workspacePath || looksLikeWindowsWorkspace) {
    const choice = await vscode.window.showInformationMessage(
      "当前还没有配置远程 Linux 仓库连接，是否现在打开配置页？",
      "打开配置",
      "取消"
    );
    if (choice !== "打开配置") {
      return false;
    }
    await openConfigurationPanel(context, service, refresh);
    return false;
  }

  return true;
}

async function suppressDiffTimeoutPrompt(logger: ExtensionLogger): Promise<void> {
  const extensionConfig = vscode.workspace.getConfiguration("remoteGitDiff");
  if (!extensionConfig.get<boolean>("disableDiffTimeoutPrompt", true)) {
    return;
  }

  const diffConfig = vscode.workspace.getConfiguration("diffEditor");
  const current = diffConfig.get<number>("maxComputationTime");
  if (current === 0) {
    return;
  }

  const target = vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  await diffConfig.update("maxComputationTime", 0, target);
  logger.info("已关闭 diff 超时限制提示", { target });
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("远程 Git Diff");
  const logger = new ExtensionLogger(output, context);
  const runner = new SshRunner(output, logger);
  const service = new RemoteGitService(runner, context.secrets, logger);
  const treeProvider = new ChangeTreeProvider();
  const contentProvider = new RemoteGitContentProvider();
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  let refreshInFlight: Promise<void> | undefined;
  let connectionState: ConnectionState = "disconnected";
  const interactionController = new InteractionController();
  let patchDiffPanel: vscode.WebviewPanel | undefined;
  let activeDiffAbortController: AbortController | undefined;
  const nativeDiffHistory = new Map<string, NativeDiffHistoryEntry>(
    Object.entries(context.workspaceState.get<Record<string, NativeDiffHistoryEntry>>(NATIVE_DIFF_HISTORY_KEY, {}))
  );

  const persistNativeDiffHistory = async (): Promise<void> => {
    await context.workspaceState.update(
      NATIVE_DIFF_HISTORY_KEY,
      Object.fromEntries(nativeDiffHistory.entries())
    );
  };

  const rememberNativeDiffOutcome = async (
    change: RemoteGitChange,
    entry: Partial<NativeDiffHistoryEntry> & { fallbackCountDelta?: number }
  ): Promise<void> => {
    const current = nativeDiffHistory.get(change.path) ?? { fallbackCount: 0 };
    const next: NativeDiffHistoryEntry = {
      fallbackCount: current.fallbackCount + (entry.fallbackCountDelta ?? 0),
      lastDurationMs: entry.lastDurationMs ?? current.lastDurationMs,
      timedOut: entry.timedOut ?? current.timedOut,
      lastReason: entry.lastReason ?? current.lastReason
    };
    nativeDiffHistory.set(change.path, next);
    await persistNativeDiffHistory();
  };

  context.subscriptions.push(
    output,
    statusBar,
    { dispose: () => runner.dispose() },
    vscode.workspace.registerTextDocumentContentProvider(REMOTE_GIT_SCHEME, contentProvider)
  );

  void logger.ready().then(() => {
    logger.info("插件已激活", {
      workspace: vscode.workspace.workspaceFolders?.map((item) => item.uri.fsPath) ?? []
    });
  });

  const showLoggedError = (message: string, error: unknown): void => {
    logger.error(message, error);
    const errorText = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`远程 Git Diff ${message}：${errorText}`);
  };

  const isAbortError = (error: unknown): boolean => {
    return error instanceof Error && error.name === "AbortError";
  };

  process.on("unhandledRejection", (error) => {
    logger.error("捕获到未处理的 Promise 异常", error);
  });
  process.on("uncaughtException", (error) => {
    logger.error("捕获到未处理的扩展异常", error);
  });

  void suppressDiffTimeoutPrompt(logger);

  const treeView = vscode.window.createTreeView("remoteGitDiff.changes", {
    treeDataProvider: treeProvider,
    showCollapseAll: false
  });
  context.subscriptions.push(treeView);

  const updateStatusBar = (state: ConnectionState, info?: { branch?: string; target?: string; tooltip?: string }): void => {
    connectionState = state;
    void vscode.commands.executeCommand("setContext", "remoteGitDiff.connectionState", state);

    switch (state) {
      case "connected": {
        const branch = info?.branch ?? "(未知分支)";
        const target = info?.target ?? "工作区";
        statusBar.text = `$(git-branch) ${branch}  $(remote) ${target}`;
        statusBar.tooltip = info?.tooltip ?? `${branch} @ ${target}`;
        statusBar.command = "remoteGitDiff.configure";
        break;
      }
      case "connecting":
        statusBar.text = "$(sync~spin) 正在连接远程仓库";
        statusBar.tooltip = info?.tooltip ?? "正在连接远程仓库";
        statusBar.command = "remoteGitDiff.reconnect";
        break;
      case "reconnecting":
        statusBar.text = "$(sync~spin) 正在重新连接";
        statusBar.tooltip = info?.tooltip ?? "正在重新连接远程仓库";
        statusBar.command = "remoteGitDiff.reconnect";
        break;
      case "error":
        statusBar.text = "$(warning) 远程 Git Diff 连接异常";
        statusBar.tooltip = info?.tooltip ?? "点击打开配置";
        statusBar.command = "remoteGitDiff.configure";
        break;
      default:
        statusBar.text = "$(debug-disconnect) 远程 Git Diff 未连接";
        statusBar.tooltip = info?.tooltip ?? "点击打开配置";
        statusBar.command = "remoteGitDiff.configure";
        break;
    }
  };

  const applyConnectionEvent = (event: SshConnectionEvent): void => {
    logger.info("收到 SSH 状态事件", event);
    if (event.type === "connected") {
      return;
    }
    if (event.type === "connecting") {
      updateStatusBar(connectionState === "connected" ? "reconnecting" : "connecting", {
        tooltip: `正在连接 ${event.username}@${event.host}`
      });
      return;
    }
    if (event.type === "timeout" || event.type === "error") {
      interactionController.resetSession();
      updateStatusBar("error", {
        tooltip: event.reason ?? "远程连接异常"
      });
      return;
    }
    interactionController.resetSession();
    updateStatusBar("disconnected", {
      tooltip: event.reason ? `连接已断开：${event.reason}` : "连接已断开"
    });
  };

  context.subscriptions.push(runner.onDidChangeConnectionState(applyConnectionEvent));

  const openPatchDiffPanel = (change: RemoteGitChange, rows: PatchRow[], stats: RemoteGitDiffStats): void => {
    const title = change.originalPath ? `${change.originalPath} -> ${change.path}` : change.path;
    if (!patchDiffPanel) {
      patchDiffPanel = vscode.window.createWebviewPanel(
        "remoteGitDiff.patchDiff",
        `变更预览: ${title}`,
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: false,
          localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")]
        }
      );
      patchDiffPanel.onDidDispose(() => {
        patchDiffPanel = undefined;
      });
    } else {
      patchDiffPanel.reveal(vscode.ViewColumn.Active, false);
      patchDiffPanel.title = `变更预览: ${title}`;
    }
    patchDiffPanel.webview.html = getPatchDiffHtml(patchDiffPanel.webview, context.extensionUri, change, rows, stats);
  };

  const openLargeDiffSummaryPanel = (
    change: RemoteGitChange,
    stats: RemoteGitDiffStats,
    details: { leftLength: number; rightLength: number; reason: string; patchLength?: number }
  ): void => {
    const title = change.originalPath ? `${change.originalPath} -> ${change.path}` : change.path;
    if (!patchDiffPanel) {
      patchDiffPanel = vscode.window.createWebviewPanel(
        "remoteGitDiff.patchDiff",
        `鍙樻洿棰勮: ${title}`,
        vscode.ViewColumn.Active,
        {
          enableScripts: false,
          retainContextWhenHidden: false
        }
      );
      patchDiffPanel.onDidDispose(() => {
        patchDiffPanel = undefined;
      });
    } else {
      patchDiffPanel.reveal(vscode.ViewColumn.Active, false);
      patchDiffPanel.title = `鍙樻洿棰勮: ${title}`;
    }
    patchDiffPanel.webview.html = getLargeDiffSummaryHtml(change, stats, details);
  };

  const refresh = async (reason = "manual"): Promise<void> => {
    if (refreshInFlight) {
      return await refreshInFlight;
    }

    const refreshToken = interactionController.beginRefreshRequest();

    refreshInFlight = (async () => {
      try {
        logger.info("开始刷新远程变更", { reason });
        updateStatusBar(connectionState === "connected" ? "reconnecting" : "connecting");

        const ready = await ensureConnectionConfigured(context, service, refresh);
        if (!ready) {
          updateStatusBar("disconnected", { tooltip: "尚未完成远程连接配置。" });
          return;
        }

        const config = await service.getConfig();
        const changes = await service.listChanges();
        const branch = await service.getCurrentBranch(config);
        const target = config.host ? `${config.username}@${config.host}` : "工作区";

        if (!interactionController.isLatestRefreshRequest(refreshToken)) {
          logger.info("放弃过期的刷新结果", { reason });
          return;
        }

        treeProvider.setChanges(changes);
        await vscode.commands.executeCommand("setContext", "remoteGitDiff.hasChanges", changes.length > 0);
        updateStatusBar("connected", {
          branch,
          target,
          tooltip: `${config.projectPath}\n分支：${branch}\n变更数：${changes.length}\n刷新来源：${reason}`
        });
        logger.info("刷新远程变更完成", { reason, count: changes.length, branch, target });
      } catch (error) {
        treeProvider.clear();
        const message = error instanceof Error ? error.message : String(error);
        logger.error("刷新远程变更失败", error);
        updateStatusBar("error", { tooltip: message });
        void vscode.window.showErrorMessage(`远程 Git Diff 刷新失败：${message}`);
      } finally {
        refreshInFlight = undefined;
      }
    })();

    return await refreshInFlight;
  };

  const ensureConnectedForOpenDiff = async (): Promise<void> => {
    if (isConnectedState(connectionState)) {
      return;
    }
    logger.info("打开对比前执行连接预检", { connectionState });
    await refresh("open-diff-preflight");
    if (!isConnectedState(connectionState)) {
      throw new Error("当前远程连接不可用，请稍后重试。");
    }
  };

  const openDiff = async (item?: unknown): Promise<void> => {
    if (!isRemoteGitChange(item)) {
      logger.warn("忽略非文件节点的打开对比请求", item);
      return;
    }

    activeDiffAbortController?.abort();
    const abortController = new AbortController();
    activeDiffAbortController = abortController;
    const token = interactionController.beginDiffRequest();
    const change = item;

    try {
      const openStartedAt = Date.now();
      const stageTimings: Record<string, number> = {};
      await ensureConnectedForOpenDiff();
      logger.info("开始打开对比", { requestId: token.requestId, path: change.path, originalPath: change.originalPath });

      const statsStartedAt = Date.now();
      const stats = await service.getDiffStats(change, abortController.signal);
      stageTimings.statsMs = Date.now() - statsStartedAt;
      if (stats.isBinary) {
        logger.warn("检测到非文本文件，停止打开对比", { requestId: token.requestId, path: change.path });
        void vscode.window.showInformationMessage("此文件为非文本文件，暂不支持左右对比。");
        return;
      }

      const sizeStartedAt = Date.now();
      const [leftLength, rightLength] = await Promise.all([
        service.getHeadContentLength(change, abortController.signal),
        service.getWorkingTreeContentLength(change, abortController.signal)
      ]);
      stageTimings.sizeMs = Date.now() - sizeStartedAt;

      if (!interactionController.isLatestDiffRequest(token)) {
        logger.info("放弃过期的对比请求", { requestId: token.requestId, path: change.path });
        return;
      }

      logger.info("size evaluation completed", { requestId: token.requestId, path: change.path, leftLength, rightLength });
      const totalChangedLines = stats.added + stats.deleted;
      const largeDiffThresholdBytes = vscode.workspace
        .getConfiguration("remoteGitDiff")
        .get<number>("largeDiffThresholdBytes", DEFAULT_LARGE_DIFF_THRESHOLD);
      const largeChangeThresholdLines = vscode.workspace
        .getConfiguration("remoteGitDiff")
        .get<number>("largeChangeThresholdLines", DEFAULT_LARGE_CHANGE_THRESHOLD);
      const diffViewMode = vscode.workspace
        .getConfiguration("remoteGitDiff")
        .get<string>("diffViewMode", "native");
      const nativeHistory = nativeDiffHistory.get(change.path);
      const nativeDecision = decideNativeDiff({
        path: change.path,
        stats,
        leftLength,
        rightLength,
        largeDiffThresholdBytes,
        largeChangeThresholdLines,
        history: nativeHistory
      });
      const usePatchView = !nativeDecision.shouldUseNative;

      logger.info("准备打开对比", {
        requestId: token.requestId,
        path: change.path,
        leftLength,
        rightLength,
        added: stats.added,
        deleted: stats.deleted,
        totalChangedLines,
        usePatchView,
        nativeDecision,
        nativeHistory,
        largeDiffThresholdBytes,
        largeChangeThresholdLines,
        diffViewMode,
        stageTimings
      });

      if (usePatchView) {
        if (nativeDecision.reason === "summary-too-large") {
          logger.warn("变更过大，改为摘要视图", {
            requestId: token.requestId,
            path: change.path,
            leftLength,
            rightLength,
            added: stats.added,
            deleted: stats.deleted
          });
          await rememberNativeDiffOutcome(change, {
            fallbackCountDelta: 1,
            lastReason: nativeDecision.reason
          });
          openLargeDiffSummaryPanel(change, stats, {
            leftLength,
            rightLength,
            reason: "变更规模超过安全阈值，已阻止加载完整补丁。"
          });
          return;
        }

        const patchStartedAt = Date.now();
        const patch = await service.readPatch(change, PATCH_CONTEXT_LINES, abortController.signal);
        stageTimings.patchMs = Date.now() - patchStartedAt;
        if (!interactionController.isLatestDiffRequest(token)) {
          logger.info("放弃过期的 patch 预览请求", { requestId: token.requestId, path: change.path });
          return;
        }
        logger.info("改用补丁差异视图", { requestId: token.requestId, path: change.path });
        const patchLength = Buffer.byteLength(patch, "utf8");
        const rows = buildPatchRows(patch);
        if (patchLength > MAX_PATCH_BYTES_FOR_WEBVIEW || rows.length > MAX_PATCH_ROWS_FOR_WEBVIEW) {
          logger.warn("补丁内容过大，改为摘要视图", {
            requestId: token.requestId,
            path: change.path,
            patchLength,
            rowCount: rows.length
          });
          await rememberNativeDiffOutcome(change, {
            fallbackCountDelta: 1,
            lastReason: "summary-patch-guard"
          });
          openLargeDiffSummaryPanel(change, stats, {
            leftLength,
            rightLength,
            patchLength,
            reason: `补丁过大（>${formatBytes(MAX_PATCH_BYTES_FOR_WEBVIEW)} 或超过 ${MAX_PATCH_ROWS_FOR_WEBVIEW} 行渲染上限）。`
          });
          return;
        }
        logger.info("patch view timing", {
          requestId: token.requestId,
          path: change.path,
          stageTimings,
          totalOpenMs: Date.now() - openStartedAt
        });
        await rememberNativeDiffOutcome(change, {
          fallbackCountDelta: 1,
          lastReason: nativeDecision.reason
        });
        openPatchDiffPanel(change, rows, stats);
        return;
      }

      const headReadStartedAt = Date.now();
      const leftContent = await service.readHeadContent(change, abortController.signal);
      stageTimings.headReadMs = Date.now() - headReadStartedAt;

      if (!interactionController.isLatestDiffRequest(token)) {
        logger.info("鏀惧純杩囨湡鐨?HEAD 鍐呭璇锋眰", { requestId: token.requestId, path: change.path });
        return;
      }

      const worktreeReadStartedAt = Date.now();
      const rightContent = await service.readWorkingTreeContent(change, abortController.signal);
      stageTimings.worktreeReadMs = Date.now() - worktreeReadStartedAt;

      if (!interactionController.isLatestDiffRequest(token)) {
        logger.info("鏀惧純杩囨湡鐨勫伐浣滃尯鍐呭璇锋眰", { requestId: token.requestId, path: change.path });
        return;
      }

      const leftUri = buildContentUri("left", change);
      const rightUri = buildContentUri("right", change);
      contentProvider.setContent(leftUri, leftContent);
      contentProvider.setContent(rightUri, rightContent);

      const title = change.originalPath
        ? `${change.originalPath} -> ${change.path}`
        : change.path;

      logger.info("触发 VS Code 原生左右对比", {
        requestId: token.requestId,
        path: change.path,
        title,
        preview: false,
        stageTimings
      });

      const nativeDiffStartedAt = Date.now();
      await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, title, { preview: false });
      stageTimings.nativeDiffMs = Date.now() - nativeDiffStartedAt;
      await rememberNativeDiffOutcome(change, {
        lastDurationMs: stageTimings.nativeDiffMs,
        timedOut: false,
        lastReason: "native-ok"
      });
      logger.info("VS Code 左右对比命令已返回", { requestId: token.requestId, path: change.path });
    } catch (error) {
      if (isAbortError(error)) {
        logger.info("已取消过期对比请求", { requestId: token.requestId, path: change.path });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      updateStatusBar("error", { tooltip: message });
      showLoggedError("打开失败", error);
    } finally {
      if (activeDiffAbortController === abortController) {
        activeDiffAbortController = undefined;
      }
    }
  };

  const runStartupSelfTest = async (): Promise<void> => {
    if (process.env.REMOTE_GIT_DIFF_SELF_TEST !== "1") {
      return;
    }

    const runId = process.env.REMOTE_GIT_DIFF_SELF_TEST_RUN_ID ?? `run-${Date.now()}`;
    const requestedFiles = (process.env.REMOTE_GIT_DIFF_SELF_TEST_FILES ?? "")
      .split("|")
      .map((item) => item.trim())
      .filter(Boolean);

    logger.info("[SELF-TEST] 启动自测开始", { runId, requestedFiles });

    try {
      await vscode.commands.executeCommand("workbench.view.extension.remoteGitDiff");
      await sleep(1000);
      await refresh("self-test");
      await sleep(1000);

      const changes = await service.listChanges();
      const selectedChanges = requestedFiles.length > 0
        ? changes.filter((change) => requestedFiles.includes(change.path))
        : changes;
      logger.info("[SELF-TEST] 本次选中文件", {
        runId,
        selectedCount: selectedChanges.length,
        samplePaths: selectedChanges.slice(0, 10).map((item) => item.path)
      });

      const sequentialResults: Array<Record<string, unknown>> = [];

      for (const change of selectedChanges) {
        const fileName = getFileName(change.path);
        const stats = await service.getDiffStats(change);
        const startedAt = Date.now();
        const beforeLabels = new Set(getOpenEditorLabels());
        logger.info("[SELF-TEST] 开始打开对比", {
          runId,
          path: change.path,
          status: change.status,
          code: change.code,
          isBinary: stats.isBinary,
          added: stats.added,
          deleted: stats.deleted
        });

        await withTimeout(
          openDiff(change),
          SELF_TEST_OPEN_DIFF_TIMEOUT_MS,
          `自测打开对比超时: ${change.path}`
        );

        if (stats.isBinary) {
          await sleep(1200);
          const durationMs = Date.now() - startedAt;
          sequentialResults.push({
            path: change.path,
            kind: "binary",
            durationMs,
            added: stats.added,
            deleted: stats.deleted,
            opened: false
          });
          logger.info("[SELF-TEST] 非文本文件已验证", {
            runId,
            path: change.path,
            durationMs
          });
          continue;
        }

        await waitForTab(fileName, 30000);
        const durationMs = Date.now() - startedAt;
        const afterLabels = getOpenEditorLabels();
        const newLabels = afterLabels.filter((label) => !beforeLabels.has(label));
        sequentialResults.push({
          path: change.path,
          kind: "text",
          durationMs,
          added: stats.added,
          deleted: stats.deleted,
          opened: true,
          newLabels
        });
        logger.info("[SELF-TEST] 打开对比成功", {
          runId,
          path: change.path,
          durationMs,
          added: stats.added,
          deleted: stats.deleted,
          newLabels
        });
        await sleep(500);
      }

      const textChanges = selectedChanges.filter((change) => {
        const item = sequentialResults.find((result) => result.path === change.path);
        return item?.kind === "text";
      });

      const rapidSwitchTargets = textChanges.slice(0, Math.min(textChanges.length, 12));
      if (rapidSwitchTargets.length > 0) {
        logger.info("[SELF-TEST] 开始快速切换压力测试", {
          runId,
          count: rapidSwitchTargets.length,
          paths: rapidSwitchTargets.map((item) => item.path)
        });
        const rapidStartedAt = Date.now();
        for (const change of rapidSwitchTargets) {
          void openDiff(change);
          await sleep(120);
        }
        const expectedLast = rapidSwitchTargets[rapidSwitchTargets.length - 1];
        await waitForTab(getFileName(expectedLast.path), 30000);
        logger.info("[SELF-TEST] 快速切换压力测试完成", {
          runId,
          count: rapidSwitchTargets.length,
          durationMs: Date.now() - rapidStartedAt,
          lastPath: expectedLast.path
        });
      }

      const durations = sequentialResults
        .map((item) => Number(item.durationMs))
        .filter((value) => Number.isFinite(value));
      const avgDurationMs = durations.length > 0
        ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
        : 0;
      const maxItem = sequentialResults.reduce<Record<string, unknown> | undefined>((current, item) => {
        if (!current) {
          return item;
        }
        return Number(item.durationMs) > Number(current.durationMs) ? item : current;
      }, undefined);

      logger.info("[SELF-TEST] 项目级汇总", {
        runId,
        totalChanges: selectedChanges.length,
        testedChanges: sequentialResults.length,
        textCount: sequentialResults.filter((item) => item.kind === "text").length,
        binaryCount: sequentialResults.filter((item) => item.kind === "binary").length,
        avgDurationMs,
        maxDurationMs: maxItem ? Number(maxItem.durationMs) : 0,
        slowestPath: maxItem?.path ?? ""
      });
      logger.info("[SELF-TEST] 项目级明细", {
        runId,
        results: sequentialResults
      });
      logger.info("[SELF-TEST] 启动自测完成", { runId });
    } catch (error) {
      logger.error("[SELF-TEST] 启动自测失败", {
        runId,
        error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)
      });
    }
  };

  const disconnect = async (): Promise<void> => {
    logger.info("手动断开连接");
    interactionController.resetSession();
    await service.clearValidationCache();
    await runner.resetConnections();
    treeProvider.clear();
    updateStatusBar("disconnected", { tooltip: "已断开连接。" });
  };

  const reconnect = async (): Promise<void> => {
    logger.info("手动重新连接");
    interactionController.resetSession();
    await service.clearValidationCache();
    await runner.resetConnections();
    updateStatusBar("reconnecting");
    await refresh("reconnect");
  };

  statusBar.show();
  updateStatusBar("disconnected");

  context.subscriptions.push(
    vscode.commands.registerCommand("remoteGitDiff.refresh", async () => {
      await refresh("manual");
    }),
    vscode.commands.registerCommand("remoteGitDiff.configure", async () => {
      await openConfigurationPanel(context, service, refresh);
    }),
    vscode.commands.registerCommand("remoteGitDiff.openLogFile", async () => {
      await logger.ready();
      const filePath = logger.getLogFilePath();
      logger.info("打开日志文件", { filePath });
      await vscode.window.showTextDocument(vscode.Uri.file(filePath), { preview: false });
    }),
    vscode.commands.registerCommand("remoteGitDiff.openDiff", openDiff),
    vscode.commands.registerCommand("remoteGitDiff.disconnect", disconnect),
    vscode.commands.registerCommand("remoteGitDiff.reconnect", reconnect),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("remoteGitDiff")) {
        interactionController.resetSession();
        void service.clearValidationCache();
        void refresh("config-change");
      }
    }),
    vscode.window.onDidChangeWindowState((event) => {
      const autoRefresh = vscode.workspace.getConfiguration("remoteGitDiff").get<boolean>("autoRefreshOnFocus", true);
      if (event.focused && autoRefresh) {
        void refresh("window-focus");
      }
    }),
    treeView.onDidChangeVisibility((event) => {
      if (event.visible) {
        void refresh("view-visible");
      }
    })
  );

  void refresh("activate");
  void runStartupSelfTest();
}

export function deactivate(): void {
  // 由 subscriptions 统一释放
}
