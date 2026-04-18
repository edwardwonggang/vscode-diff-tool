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
const MAX_PATCH_BYTES_FOR_WEBVIEW = 12_000_000;

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
  throw new Error(`鏈湪鏍囩椤典腑鐪嬪埌 ${labelIncludes}`);
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

async function showAutoDismissNotification(message: string, timeoutMs = 3000): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: message,
      cancellable: false
    },
    async () => {
      await sleep(timeoutMs);
    }
  );
}

let patchViewStylesCache: string | undefined;
let settingsPanelSingleton: vscode.WebviewPanel | undefined;

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
    .inline-delete {
      background: var(--vscode-diffEditor-removedTextBackground, rgba(255, 0, 0, 0.28));
      text-decoration: line-through;
    }
    .inline-insert {
      background: var(--vscode-diffEditor-insertedTextBackground, rgba(155, 185, 85, 0.32));
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
    <title>杩滅▼ Git Diff 閰嶇疆</title>
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
        <h1>杩滅▼ Git Diff 閰嶇疆</h1>
        <p>鍦ㄨ繖閲屼竴娆℃€у畬鎴愭湇鍔″櫒杩炴帴銆佷粨搴撹矾寰勫拰璁よ瘉閰嶇疆銆備繚瀛樺悗浼氶暱鏈熷鐢紝鍒囧洖 VS Code 鏃朵篃浼氳嚜鍔ㄥ埛鏂般€?/p>
      </div>
      <div class="card">
        <h2>杩炴帴閰嶇疆</h2>
        <div class="grid">
          <label>SSH 涓绘満<input id="host" type="text" value="${escapeHtml(form.host)}" /></label>
          <label>SSH 绔彛<input id="port" type="number" value="${String(form.port)}" /></label>
          <label>SSH 鐢ㄦ埛鍚?input id="username" type="text" value="${escapeHtml(form.username)}" /></label>
          <label>SSH 瀵嗙爜<input id="password" type="password" value="${escapeHtml(form.password)}" placeholder="鐣欑┖琛ㄧず淇濈暀宸蹭繚瀛樺瘑鐮? /></label>
          <label class="full">绉侀挜璺緞<input id="privateKeyPath" type="text" value="${escapeHtml(form.privateKeyPath)}" placeholder="鍙€夛紝渚嬪 C:\\Users\\name\\.ssh\\id_rsa" /></label>
          <label class="full">Linux 浠撳簱璺緞<input id="projectPath" type="text" value="${escapeHtml(form.projectPath)}" placeholder="/home/user/src/project" /></label>
          <div class="full row">
            <input id="strictHostKeyChecking" type="checkbox" ${form.strictHostKeyChecking ? "checked" : ""} />
            <label for="strictHostKeyChecking">鍚敤涓ユ牸涓绘満鏍￠獙</label>
          </div>
        </div>
        <p class="hint">寤鸿璺緞锛?code id="suggestedPath">${escapeHtml(suggestedPath || "(鏆傛棤)")}</code></p>
        <div class="toolbar">
          <button id="useSuggested" class="secondary">浣跨敤寤鸿璺緞</button>
          <button id="save" class="secondary">浠呬繚瀛?/button>
          <button id="test">娴嬭瘯杩炴帴</button>
          <button id="saveConnect">淇濆瓨骞惰繛鎺?/button>
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
        document.getElementById('projectPath').value = suggestedPath.textContent === '(鏆傛棤)' ? '' : suggestedPath.textContent;
      });
      document.getElementById('save').addEventListener('click', () => vscode.postMessage({ type: 'save', form: getForm() }));
      document.getElementById('test').addEventListener('click', () => {
        status.textContent = '姝ｅ湪娴嬭瘯杩炴帴...';
        vscode.postMessage({ type: 'test', form: getForm() });
      });
      document.getElementById('saveConnect').addEventListener('click', () => {
        status.textContent = '姝ｅ湪淇濆瓨骞惰繛鎺?..';
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
  const patchLine = details.patchLength === undefined ? "" : `\nPatch 澶у皬锛?{formatBytes(details.patchLength)}`;

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
        <div class="meta">瓒呭ぇ鍙樻洿鎽樿</div>
      </div>
      <div class="empty-state">
        <div class="empty-title">璇ュ彉鏇磋妯¤繃澶э紝宸查樆姝㈠姞杞藉畬鏁磋嚜瀹氫箟 Diff 浠ラ伩鍏?VS Code 鍗℃銆?/div>
        <pre class="empty-details">鍘熷洜锛?{escapeHtml(details.reason)}
鏂板锛?{stats.added} 琛?
鍒犻櫎锛?{stats.deleted} 琛?
HEAD 澶у皬锛?{formatBytes(details.leftLength)}
宸ヤ綔鍖哄ぇ灏忥細${formatBytes(details.rightLength)}${patchLine}

寤鸿锛?
1. 鍏堢缉灏忓彉鏇磋寖鍥村悗鍐嶆煡鐪?
2. 浣跨敤杩滅鍛戒护鎸夌洰褰?鐗囨鎷嗗垎 diff
3. 瀵硅秴澶ч噸鍐欐枃浠朵紭鍏堢湅 git diff --stat 鎴栧閮ㄦ瘮杈冨伐鍏?/pre>
      </div>
    </div>
  </body>
  </html>`;
}

function getPatchLoadingHtml(
  change: RemoteGitChange,
  stageText: string,
  details?: { slowHint?: string }
): string {
  const title = change.originalPath ? `${change.originalPath} -> ${change.path}` : change.path;
  const styles = getPatchViewStyles();
  const slowHintBlock = details?.slowHint
    ? `<div class="loading-hint">${escapeHtml(details.slowHint)}</div>`
    : "";

  return `<!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
    <style>
      ${styles}
      .loading-shell { display: grid; grid-template-rows: auto 1fr; min-height: 100vh; }
      .loading-body { padding: 18px 18px 24px; display: grid; gap: 16px; align-content: start; }
      .loading-card { border: 1px solid var(--vscode-panel-border); border-radius: 10px; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); padding: 16px; display: grid; gap: 14px; }
      .loading-header { display: flex; align-items: center; gap: 12px; }
      .loading-spinner { width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--vscode-descriptionForeground); border-top-color: var(--vscode-progressBar-background, var(--vscode-textLink-foreground)); animation: remote-git-diff-spin 0.8s linear infinite; flex-shrink: 0; }
      .loading-title { font-size: 13px; font-weight: 600; }
      .loading-subtitle, .loading-hint { color: var(--vscode-descriptionForeground); font-size: 12px; }
      .loading-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
      .loading-column { border: 1px solid var(--vscode-panel-border); border-radius: 8px; overflow: hidden; }
      .loading-column-title { padding: 8px 10px; font-size: 12px; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background)); }
      .loading-lines { padding: 10px; display: grid; gap: 8px; }
      .loading-line { height: 12px; border-radius: 999px; background: linear-gradient(90deg, var(--vscode-panel-border) 0%, var(--vscode-descriptionForeground) 50%, var(--vscode-panel-border) 100%); background-size: 220% 100%; opacity: 0.35; animation: remote-git-diff-pulse 1.4s ease-in-out infinite; }
      .loading-line.short { width: 62%; }
      .loading-line.medium { width: 78%; }
      .loading-line.long { width: 94%; }
      @keyframes remote-git-diff-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      @keyframes remote-git-diff-pulse { 0% { background-position: 100% 0; opacity: 0.25; } 50% { opacity: 0.45; } 100% { background-position: -100% 0; opacity: 0.25; } }
    </style>
  </head>
  <body>
    <div class="loading-shell">
      <div class="toolbar">
        <div class="title">${escapeHtml(title)}</div>
        <div class="meta">鑷畾涔?Diff</div>
      </div>
      <div class="loading-body">
        <div class="loading-card">
          <div class="loading-header">
            <div class="loading-spinner"></div>
            <div>
              <div class="loading-title">${escapeHtml(stageText)}</div>
              <div class="loading-subtitle">澶ф枃浠舵垨澶у彉鏇翠細浼樺厛浣跨敤鎻掍欢鍐呯疆瑙嗗浘</div>
            </div>
          </div>
          ${slowHintBlock}
        </div>
        <div class="loading-columns">
          <div class="loading-column">
            <div class="loading-column-title">HEAD</div>
            <div class="loading-lines">
              <div class="loading-line long"></div>
              <div class="loading-line medium"></div>
              <div class="loading-line short"></div>
              <div class="loading-line long"></div>
              <div class="loading-line medium"></div>
            </div>
          </div>
          <div class="loading-column">
            <div class="loading-column-title">WORKTREE</div>
            <div class="loading-lines">
              <div class="loading-line medium"></div>
              <div class="loading-line long"></div>
              <div class="loading-line short"></div>
              <div class="loading-line medium"></div>
              <div class="loading-line long"></div>
            </div>
          </div>
        </div>
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
  if (settingsPanelSingleton) {
    const form = await service.getSettingsForm();
    const suggestedPath = service.getSuggestedProjectPath(form.host, form.username, form.projectPath);
    settingsPanelSingleton.webview.html = getConfigHtml(form, suggestedPath);
    settingsPanelSingleton.reveal(vscode.ViewColumn.One, false);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "remoteGitDiff.settings",
    "杩滅▼ Git Diff 閰嶇疆",
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  settingsPanelSingleton = panel;
  const form = await service.getSettingsForm();
  const suggestedPath = service.getSuggestedProjectPath(form.host, form.username, form.projectPath);
  panel.webview.html = getConfigHtml(form, suggestedPath);

  const disposable = panel.webview.onDidReceiveMessage(async (message) => {
    const formData = message.form as RemoteGitSettingsForm;
    try {
      if (message.type === "save") {
        await service.saveSettings(formData);
        void panel.webview.postMessage({ type: "status", text: "閰嶇疆宸蹭繚瀛樸€? });
        return;
      }

      if (message.type === "test") {
        const result = await service.testConnection(formData);
        void panel.webview.postMessage({ type: "status", text: `杩炴帴鎴愬姛锛歕n${result}` });
        return;
      }

      if (message.type === "saveConnect") {
        await service.saveSettings(formData);
        await refresh("save-connect");
        void panel.webview.postMessage({ type: "status", text: "閰嶇疆宸蹭繚瀛橈紝骞跺凡瀹屾垚杩炴帴鍒锋柊銆? });
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      void panel.webview.postMessage({ type: "status", text: `澶辫触锛?{messageText}` });
    }
  });

  panel.onDidDispose(() => {
    if (settingsPanelSingleton === panel) {
      settingsPanelSingleton = undefined;
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
      "褰撳墠杩樻病鏈夐厤缃繙绋?Linux 浠撳簱杩炴帴锛屾槸鍚︾幇鍦ㄦ墦寮€閰嶇疆椤碉紵",
      "鎵撳紑閰嶇疆",
      "鍙栨秷"
    );
    if (choice !== "鎵撳紑閰嶇疆") {
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
  logger.info("宸插叧闂?diff 瓒呮椂闄愬埗鎻愮ず", { target });
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("杩滅▼ Git Diff");
  const logger = new ExtensionLogger(output, context);
  const runner = new SshRunner(output, logger);
  const service = new RemoteGitService(runner, context.secrets, logger);
  const treeProvider = new ChangeTreeProvider();
  const contentProvider = new RemoteGitContentProvider();
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  let refreshInFlight: Promise<void> | undefined;
  let connectionState: ConnectionState = "disconnected";
  let pendingWarmupRefreshTimer: NodeJS.Timeout | undefined;
  let shouldScheduleWarmupRefresh = true;
  const interactionController = new InteractionController();
  let patchDiffPanel: vscode.WebviewPanel | undefined;
  let activeDiffAbortController: AbortController | undefined;
  let visibleChanges: RemoteGitChange[] = [];
  let hiddenTrackedFilePaths: string[] = [];
  const nativeDiffHistory = new Map<string, NativeDiffHistoryEntry>(
    Object.entries(context.workspaceState.get<Record<string, NativeDiffHistoryEntry>>(NATIVE_DIFF_HISTORY_KEY, {}))
  );

  const ensurePatchDiffPanel = (title: string): vscode.WebviewPanel => {
    if (!patchDiffPanel) {
      patchDiffPanel = vscode.window.createWebviewPanel(
        "remoteGitDiff.patchDiff",
        `鍙樻洿棰勮: ${title}`,
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
      patchDiffPanel.title = `鍙樻洿棰勮: ${title}`;
    }
    return patchDiffPanel;
  };

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
    {
      dispose: () => {
        if (pendingWarmupRefreshTimer) {
          clearTimeout(pendingWarmupRefreshTimer);
          pendingWarmupRefreshTimer = undefined;
        }
      }
    },
    vscode.workspace.registerTextDocumentContentProvider(REMOTE_GIT_SCHEME, contentProvider)
  );

  void logger.ready().then(() => {
    logger.info("鎻掍欢宸叉縺娲?, {
      workspace: vscode.workspace.workspaceFolders?.map((item) => item.uri.fsPath) ?? []
    });
  });

  const showLoggedError = (message: string, error: unknown): void => {
    logger.error(message, error);
    const errorText = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`杩滅▼ Git Diff ${message}锛?{errorText}`);
  };

  const isAbortError = (error: unknown): boolean => {
    return error instanceof Error && error.name === "AbortError";
  };

  process.on("unhandledRejection", (error) => {
    logger.error("鎹曡幏鍒版湭澶勭悊鐨?Promise 寮傚父", error);
  });
  process.on("uncaughtException", (error) => {
    logger.error("鎹曡幏鍒版湭澶勭悊鐨勬墿灞曞紓甯?, error);
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
        const branch = info?.branch ?? "(鏈煡鍒嗘敮)";
        const target = info?.target ?? "宸ヤ綔鍖?;
        statusBar.text = `$(git-branch) ${branch}  $(remote) ${target}`;
        statusBar.tooltip = info?.tooltip ?? `${branch} @ ${target}`;
        statusBar.command = "remoteGitDiff.configure";
        break;
      }
      case "connecting":
        statusBar.text = "$(sync~spin) 姝ｅ湪杩炴帴杩滅▼浠撳簱";
        statusBar.tooltip = info?.tooltip ?? "姝ｅ湪杩炴帴杩滅▼浠撳簱";
        statusBar.command = "remoteGitDiff.reconnect";
        break;
      case "reconnecting":
        statusBar.text = "$(sync~spin) 姝ｅ湪閲嶆柊杩炴帴";
        statusBar.tooltip = info?.tooltip ?? "姝ｅ湪閲嶆柊杩炴帴杩滅▼浠撳簱";
        statusBar.command = "remoteGitDiff.reconnect";
        break;
      case "error":
        statusBar.text = "$(warning) 杩滅▼ Git Diff 杩炴帴寮傚父";
        statusBar.tooltip = info?.tooltip ?? "鐐瑰嚮鎵撳紑閰嶇疆";
        statusBar.command = "remoteGitDiff.configure";
        break;
      default:
        statusBar.text = "$(debug-disconnect) 杩滅▼ Git Diff 鏈繛鎺?;
        statusBar.tooltip = info?.tooltip ?? "鐐瑰嚮鎵撳紑閰嶇疆";
        statusBar.command = "remoteGitDiff.configure";
        break;
    }
  };

  const applyConnectionEvent = (event: SshConnectionEvent): void => {
    logger.info("鏀跺埌 SSH 鐘舵€佷簨浠?, event);
    if (event.type === "connected") {
      if (shouldScheduleWarmupRefresh && !pendingWarmupRefreshTimer) {
        pendingWarmupRefreshTimer = setTimeout(() => {
          pendingWarmupRefreshTimer = undefined;
          shouldScheduleWarmupRefresh = false;
          void refresh("warmup-after-connect");
        }, 600);
      }
      return;
    }
    if (event.type === "connecting") {
      updateStatusBar(connectionState === "connected" ? "reconnecting" : "connecting", {
        tooltip: `姝ｅ湪杩炴帴 ${event.username}@${event.host}`
      });
      return;
    }
    if (event.type === "timeout" || event.type === "error") {
      interactionController.resetSession();
      updateStatusBar("error", {
        tooltip: event.reason ?? "杩滅▼杩炴帴寮傚父"
      });
      return;
    }
    interactionController.resetSession();
    updateStatusBar("disconnected", {
      tooltip: event.reason ? `杩炴帴宸叉柇寮€锛?{event.reason}` : "杩炴帴宸叉柇寮€"
    });
  };

  context.subscriptions.push(runner.onDidChangeConnectionState(applyConnectionEvent));

  const openPatchDiffPanel = (change: RemoteGitChange, rows: PatchRow[], stats: RemoteGitDiffStats): void => {
    const title = change.originalPath ? `${change.originalPath} -> ${change.path}` : change.path;
    const panel = ensurePatchDiffPanel(title);
    panel.webview.html = getPatchDiffHtml(panel.webview, context.extensionUri, change, rows, stats);
  };

  const openPatchLoadingPanel = (
    change: RemoteGitChange,
    stageText: string,
    details?: { slowHint?: string }
  ): void => {
    const title = change.originalPath ? `${change.originalPath} -> ${change.path}` : change.path;
    const panel = ensurePatchDiffPanel(title);
    panel.webview.html = getPatchLoadingHtml(change, stageText, details);
  };

  const openLargeDiffSummaryPanel = (
    change: RemoteGitChange,
    stats: RemoteGitDiffStats,
    details: { leftLength: number; rightLength: number; reason: string; patchLength?: number }
  ): void => {
    const title = change.originalPath ? `${change.originalPath} -> ${change.path}` : change.path;
    const panel = ensurePatchDiffPanel(title);
    panel.webview.html = getLargeDiffSummaryHtml(change, stats, details);
  };

  const refresh = async (reason = "manual"): Promise<void> => {
    if (refreshInFlight) {
      return await refreshInFlight;
    }

    const refreshToken = interactionController.beginRefreshRequest();

    refreshInFlight = (async () => {
      try {
        logger.info("寮€濮嬪埛鏂拌繙绋嬪彉鏇?, { reason });
        updateStatusBar(connectionState === "connected" ? "reconnecting" : "connecting");

        const ready = await ensureConnectionConfigured(context, service, refresh);
        if (!ready) {
          updateStatusBar("disconnected", { tooltip: "灏氭湭瀹屾垚杩滅▼杩炴帴閰嶇疆銆? });
          return;
        }

        const config = await service.getConfig();
        const changes = await service.listChanges();
        const hiddenTrackedFiles = await service.readHiddenTrackedFiles();
        hiddenTrackedFilePaths = hiddenTrackedFiles.paths;
        const hiddenPathSet = new Set(hiddenTrackedFilePaths);
        const filteredChanges = changes.filter((change) => !hiddenPathSet.has(change.path));
        const branch = await service.getCurrentBranch(config);
        const target = config.host ? `${config.username}@${config.host}` : "宸ヤ綔鍖?;

        if (!interactionController.isLatestRefreshRequest(refreshToken)) {
          logger.info("鏀惧純杩囨湡鐨勫埛鏂扮粨鏋?, { reason });
          return;
        }

        visibleChanges = filteredChanges;
        treeProvider.setChanges(filteredChanges);
        await vscode.commands.executeCommand("setContext", "remoteGitDiff.hasChanges", filteredChanges.length > 0);
        await vscode.commands.executeCommand("setContext", "remoteGitDiff.hasHiddenTrackedFiles", hiddenTrackedFilePaths.length > 0);
        updateStatusBar("connected", {
          branch,
          target,
          tooltip: `${config.projectPath}\n鍒嗘敮锛?{branch}\n鍙樻洿鏁帮細${changes.length}\n鍒锋柊鏉ユ簮锛?{reason}`
        });
        logger.info("鍒锋柊杩滅▼鍙樻洿瀹屾垚", { reason, count: changes.length, branch, target });
      } catch (error) {
        visibleChanges = [];
        hiddenTrackedFilePaths = [];
        treeProvider.clear();
        await vscode.commands.executeCommand("setContext", "remoteGitDiff.hasChanges", false);
        await vscode.commands.executeCommand("setContext", "remoteGitDiff.hasHiddenTrackedFiles", false);
        const message = error instanceof Error ? error.message : String(error);
        logger.error("鍒锋柊杩滅▼鍙樻洿澶辫触", error);
        updateStatusBar("error", { tooltip: message });
        void vscode.window.showErrorMessage(`杩滅▼ Git Diff 鍒锋柊澶辫触锛?{message}`);
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
    logger.info("鎵撳紑瀵规瘮鍓嶆墽琛岃繛鎺ラ妫€", { connectionState });
    await refresh("open-diff-preflight");
    if (!isConnectedState(connectionState)) {
      throw new Error("褰撳墠杩滅▼杩炴帴涓嶅彲鐢紝璇风◢鍚庨噸璇曘€?);
    }
  };

  const hideCurrentTrackedChanges = async (): Promise<void> => {
    await ensureConnectedForOpenDiff();
    if (visibleChanges.length === 0) {
      void vscode.window.showInformationMessage("褰撳墠娌℃湁鍙殣钘忕殑 tracked 鍙樻洿銆?);
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      `灏嗗綋鍓?${visibleChanges.length} 涓?tracked 鍙樻洿鍐欏叆椤圭洰绾ч殣钘忔竻鍗曪紝鍚庣画鎻掍欢涓嶅啀鏄剧ず锛屾槸鍚︾户缁紵`,
      { modal: true },
      "缁х画",
      "鍙栨秷"
    );
    if (choice !== "缁х画") {
      return;
    }

    const result = await service.addHiddenTrackedFiles(visibleChanges.map((change) => change.path));
    hiddenTrackedFilePaths = result.paths;
    logger.info("宸叉洿鏂?tracked 闅愯棌娓呭崟", {
      addedCount: visibleChanges.length,
      totalHiddenCount: result.paths.length,
      filePath: result.filePath
    });
    void vscode.window.showInformationMessage(`宸查殣钘忓綋鍓嶅彉鏇淬€傛竻鍗曟枃浠讹細${result.filePath}`);
    await refresh("hide-tracked");
  };

  const restoreHiddenTrackedChanges = async (): Promise<void> => {
    await ensureConnectedForOpenDiff();
    if (hiddenTrackedFilePaths.length === 0) {
      void vscode.window.showInformationMessage("褰撳墠娌℃湁宸查殣钘忕殑 tracked 鏂囦欢銆?);
      return;
    }

    const restoredCount = hiddenTrackedFilePaths.length;
    const choice = await vscode.window.showWarningMessage(
      `灏嗘竻绌哄綋鍓嶉」鐩殑闅愯棌娓呭崟锛屽苟鎭㈠ ${restoredCount} 涓?tracked 鏂囦欢鏄剧ず锛屾槸鍚︾户缁紵`,
      { modal: true },
      "鎭㈠",
      "鍙栨秷"
    );
    if (choice !== "鎭㈠") {
      return;
    }

    const result = await service.clearHiddenTrackedFiles();
    hiddenTrackedFilePaths = result.paths;
    logger.info("宸叉竻绌?tracked 闅愯棌娓呭崟", {
      restoredCount,
      filePath: result.filePath
    });
    void vscode.window.showInformationMessage(`宸叉仮澶嶉殣钘忔枃浠舵樉绀恒€傛竻鍗曟枃浠讹細${result.filePath}`);
    await refresh("restore-hidden-tracked");
  };

  const stageAllVisibleChanges = async (): Promise<void> => {
    await ensureConnectedForOpenDiff();
    if (hiddenTrackedFilePaths.length === 0) {
      void vscode.window.showInformationMessage("闅愯棌鍒楄〃涓虹┖锛屾殏涓嶅厑璁镐竴閿坊鍔犳墍鏈夊彉鏇淬€?);
      return;
    }
    if (visibleChanges.length === 0) {
      void vscode.window.showInformationMessage("褰撳墠娌℃湁鍙坊鍔犵殑鍙樻洿銆?);
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      `灏嗗綋鍓?${visibleChanges.length} 涓彲瑙佸彉鏇村叏閮ㄦ墽琛?git add锛屾槸鍚︾户缁紵`,
      { modal: true },
      "缁х画",
      "鍙栨秷"
    );
    if (choice !== "缁х画") {
      return;
    }

    const stagedCount = await service.stageTrackedChanges(visibleChanges.map((change) => change.path));
    logger.info("宸蹭竴閿坊鍔犲綋鍓嶅彲瑙佸彉鏇?, {
      stagedCount,
      hiddenCount: hiddenTrackedFilePaths.length
    });
    void vscode.window.showInformationMessage(`宸叉坊鍔?${stagedCount} 涓彲瑙佸彉鏇淬€俙);
    await refresh("stage-visible-tracked");
  };

  const openDiff = async (item?: unknown): Promise<void> => {
    if (!isRemoteGitChange(item)) {
      logger.warn("蹇界暐闈炴枃浠惰妭鐐圭殑鎵撳紑瀵规瘮璇锋眰", item);
      return;
    }

    activeDiffAbortController?.abort();
    const abortController = new AbortController();
    activeDiffAbortController = abortController;
    const token = interactionController.beginDiffRequest();
    const change = item;
    let loadingHintTimer: NodeJS.Timeout | undefined;
    let loadingHintVisible = false;
    const updatePatchLoadingStage = (stageText: string): void => {
      if (!interactionController.isLatestDiffRequest(token)) {
        return;
      }
      openPatchLoadingPanel(
        change,
        stageText,
        loadingHintVisible ? { slowHint: "鏂囦欢杈冨ぇ锛屼粛鍦ㄧ户缁鐞嗭紝璇风◢鍊欍€? } : undefined
      );
    };

    try {
      const openStartedAt = Date.now();
      const stageTimings: Record<string, number> = {};
      await ensureConnectedForOpenDiff();
      updatePatchLoadingStage("姝ｅ湪璇诲彇鍙樻洿缁熻");
      loadingHintTimer = setTimeout(() => {
        loadingHintVisible = true;
        updatePatchLoadingStage("姝ｅ湪缁х画澶勭悊澶ф枃浠?);
      }, 900);
      logger.info("寮€濮嬫墦寮€瀵规瘮", { requestId: token.requestId, path: change.path, originalPath: change.originalPath });

      const statsStartedAt = Date.now();
      const stats = await service.getDiffStats(change, abortController.signal);
      stageTimings.statsMs = Date.now() - statsStartedAt;
      if (stats.isBinary) {
        logger.warn("妫€娴嬪埌闈炴枃鏈枃浠讹紝鍋滄鎵撳紑瀵规瘮", { requestId: token.requestId, path: change.path });
        void showAutoDismissNotification("姝ゆ枃浠朵负闈炴枃鏈枃浠讹紝鏆備笉鏀寔宸﹀彸瀵规瘮銆?, 3000);
        return;
      }

      const sizeStartedAt = Date.now();
      const [leftLength, rightLength] = await Promise.all([
        service.getHeadContentLength(change, abortController.signal),
        service.getWorkingTreeContentLength(change, abortController.signal)
      ]);
      stageTimings.sizeMs = Date.now() - sizeStartedAt;

      if (!interactionController.isLatestDiffRequest(token)) {
        logger.info("鏀惧純杩囨湡鐨勫姣旇姹?, { requestId: token.requestId, path: change.path });
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

      logger.info("鍑嗗鎵撳紑瀵规瘮", {
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
        updatePatchLoadingStage("姝ｅ湪鐢熸垚鑷畾涔?Diff");
        if (nativeDecision.reason === "summary-too-large") {
          logger.warn("鍙樻洿杩囧ぇ锛屾敼涓烘憳瑕佽鍥?, {
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
            reason: "鍙樻洿瑙勬ā瓒呰繃瀹夊叏闃堝€硷紝宸查樆姝㈠姞杞藉畬鏁磋ˉ涓併€?
          });
          return;
        }

        updatePatchLoadingStage("姝ｅ湪鑾峰彇鏂囦欢鍐呭");
        const patchStartedAt = Date.now();
        const patch = await service.readPatch(change, PATCH_CONTEXT_LINES, abortController.signal);
        stageTimings.patchMs = Date.now() - patchStartedAt;
        if (!interactionController.isLatestDiffRequest(token)) {
          logger.info("鏀惧純杩囨湡鐨?patch 棰勮璇锋眰", { requestId: token.requestId, path: change.path });
          return;
        }
        logger.info("鏀圭敤琛ヤ竵宸紓瑙嗗浘", { requestId: token.requestId, path: change.path });
        const patchLength = Buffer.byteLength(patch, "utf8");
        if (patchLength > MAX_PATCH_BYTES_FOR_WEBVIEW) {
          logger.warn("琛ヤ竵鍐呭杩囧ぇ锛屾敼涓烘憳瑕佽鍥?, {
            requestId: token.requestId,
            path: change.path,
            patchLength
          });
          await rememberNativeDiffOutcome(change, {
            fallbackCountDelta: 1,
            lastReason: "summary-patch-guard"
          });
          openLargeDiffSummaryPanel(change, stats, {
            leftLength,
            rightLength,
            patchLength,
            reason: `琛ヤ竵杩囧ぇ锛?${formatBytes(MAX_PATCH_BYTES_FOR_WEBVIEW)}锛夛紝缁х画鍔犺浇浼氭槑鏄惧鍔?VS Code 鍗￠】椋庨櫓銆俙
          });
          return;
        }
        const rows = buildPatchRows(patch, MAX_PATCH_ROWS_FOR_WEBVIEW);
        updatePatchLoadingStage("姝ｅ湪娓叉煋椤甸潰");
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

      if (patchDiffPanel) {
        patchDiffPanel.dispose();
        patchDiffPanel = undefined;
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

      logger.info("瑙﹀彂 VS Code 鍘熺敓宸﹀彸瀵规瘮", {
        requestId: token.requestId,
        path: change.path,
        title,
        preview: true,
        stageTimings
      });

      const nativeDiffStartedAt = Date.now();
      await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, title, { preview: true });
      stageTimings.nativeDiffMs = Date.now() - nativeDiffStartedAt;
      await rememberNativeDiffOutcome(change, {
        lastDurationMs: stageTimings.nativeDiffMs,
        timedOut: false,
        lastReason: "native-ok"
      });
      logger.info("VS Code 宸﹀彸瀵规瘮鍛戒护宸茶繑鍥?, { requestId: token.requestId, path: change.path });
    } catch (error) {
      if (isAbortError(error)) {
        logger.info("宸插彇娑堣繃鏈熷姣旇姹?, { requestId: token.requestId, path: change.path });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      updateStatusBar("error", { tooltip: message });
      showLoggedError("鎵撳紑澶辫触", error);
    } finally {
      if (loadingHintTimer) {
        clearTimeout(loadingHintTimer);
      }
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

    logger.info("[SELF-TEST] 鍚姩鑷祴寮€濮?, { runId, requestedFiles });

    try {
      await vscode.commands.executeCommand("workbench.view.extension.remoteGitDiff");
      await sleep(1000);
      await refresh("self-test");
      await sleep(1000);

      const changes = await service.listChanges();
      const selectedChanges = requestedFiles.length > 0
        ? changes.filter((change) => requestedFiles.includes(change.path))
        : changes;
      logger.info("[SELF-TEST] 鏈閫変腑鏂囦欢", {
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
        logger.info("[SELF-TEST] 寮€濮嬫墦寮€瀵规瘮", {
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
          `鑷祴鎵撳紑瀵规瘮瓒呮椂: ${change.path}`
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
          logger.info("[SELF-TEST] 闈炴枃鏈枃浠跺凡楠岃瘉", {
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
        logger.info("[SELF-TEST] 鎵撳紑瀵规瘮鎴愬姛", {
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
        logger.info("[SELF-TEST] 寮€濮嬪揩閫熷垏鎹㈠帇鍔涙祴璇?, {
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
        logger.info("[SELF-TEST] 蹇€熷垏鎹㈠帇鍔涙祴璇曞畬鎴?, {
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

      logger.info("[SELF-TEST] 椤圭洰绾ф眹鎬?, {
        runId,
        totalChanges: selectedChanges.length,
        testedChanges: sequentialResults.length,
        textCount: sequentialResults.filter((item) => item.kind === "text").length,
        binaryCount: sequentialResults.filter((item) => item.kind === "binary").length,
        avgDurationMs,
        maxDurationMs: maxItem ? Number(maxItem.durationMs) : 0,
        slowestPath: maxItem?.path ?? ""
      });
      logger.info("[SELF-TEST] 椤圭洰绾ф槑缁?, {
        runId,
        results: sequentialResults
      });
      logger.info("[SELF-TEST] 鍚姩鑷祴瀹屾垚", { runId });
    } catch (error) {
      logger.error("[SELF-TEST] 鍚姩鑷祴澶辫触", {
        runId,
        error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)
      });
    }
  };

  const disconnect = async (): Promise<void> => {
    logger.info("鎵嬪姩鏂紑杩炴帴");
    interactionController.resetSession();
    await service.clearValidationCache();
    await runner.resetConnections();
    shouldScheduleWarmupRefresh = true;
    if (pendingWarmupRefreshTimer) {
      clearTimeout(pendingWarmupRefreshTimer);
      pendingWarmupRefreshTimer = undefined;
    }
    visibleChanges = [];
    hiddenTrackedFilePaths = [];
    treeProvider.clear();
    void vscode.commands.executeCommand("setContext", "remoteGitDiff.hasChanges", false);
    void vscode.commands.executeCommand("setContext", "remoteGitDiff.hasHiddenTrackedFiles", false);
    updateStatusBar("disconnected", { tooltip: "宸叉柇寮€杩炴帴銆? });
  };

  const reconnect = async (): Promise<void> => {
    logger.info("鎵嬪姩閲嶆柊杩炴帴");
    interactionController.resetSession();
    await service.clearValidationCache();
    await runner.resetConnections();
    shouldScheduleWarmupRefresh = true;
    if (pendingWarmupRefreshTimer) {
      clearTimeout(pendingWarmupRefreshTimer);
      pendingWarmupRefreshTimer = undefined;
    }
    updateStatusBar("reconnecting");
    await refresh("reconnect");
  };

  statusBar.show();
  updateStatusBar("disconnected");
  void vscode.commands.executeCommand("setContext", "remoteGitDiff.hasHiddenTrackedFiles", false);

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
      logger.info("鎵撳紑鏃ュ織鏂囦欢", { filePath });
      await vscode.window.showTextDocument(vscode.Uri.file(filePath), { preview: false });
    }),
    vscode.commands.registerCommand("remoteGitDiff.stageAllVisibleChanges", stageAllVisibleChanges),
    vscode.commands.registerCommand("remoteGitDiff.hideCurrentTrackedChanges", hideCurrentTrackedChanges),
    vscode.commands.registerCommand("remoteGitDiff.restoreHiddenTrackedChanges", restoreHiddenTrackedChanges),
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
  // 鐢?subscriptions 缁熶竴閲婃斁
}
