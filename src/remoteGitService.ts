import * as vscode from "vscode";
import * as path from "node:path";
import { ExtensionLogger } from "./logger";
import { SshRunner } from "./sshRunner";
import { RemoteGitChange, RemoteGitConfig, RemoteGitDiffStats, RemoteGitSettingsForm } from "./types";

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const TRACKED_CHANGE_EXCLUDE_FILE_NAME = ".remote-git-diff-hidden-tracked-files.md";

interface ConfigCacheEntry {
  cacheKey: string;
  resolvedProjectPath: string;
}

export class RemoteGitService {
  private validatedConfigCache: ConfigCacheEntry | undefined;

  public constructor(
    private readonly runner: SshRunner,
    private readonly secrets: vscode.SecretStorage,
    private readonly logger?: ExtensionLogger
  ) {}

  public async getConfig(): Promise<RemoteGitConfig> {
    const config = vscode.workspace.getConfiguration("remoteGitDiff");
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const workspacePath = workspaceFolder?.uri.fsPath ?? "";
    const host = (process.env.REMOTE_GIT_DIFF_HOST ?? config.get<string>("host", "")).trim();
    const configuredProjectPath = (process.env.REMOTE_GIT_DIFF_PROJECT_PATH ?? config.get<string>("projectPath", "")).trim();
    const resolvedConfig = {
      host,
      port: Number(process.env.REMOTE_GIT_DIFF_PORT ?? config.get<number>("port", 22)),
      username: (process.env.REMOTE_GIT_DIFF_USERNAME ?? config.get<string>("username", "")).trim(),
      password: process.env.REMOTE_GIT_DIFF_PASSWORD ?? (await this.secrets.get("remoteGitDiff.password")) ?? undefined,
      projectPath: configuredProjectPath || (!host ? workspacePath : ""),
      privateKeyPath: (process.env.REMOTE_GIT_DIFF_PRIVATE_KEY_PATH ?? config.get<string>("privateKeyPath", "")).trim(),
      strictHostKeyChecking: (process.env.REMOTE_GIT_DIFF_STRICT_HOST_KEY_CHECKING ?? String(config.get<boolean>("strictHostKeyChecking", true))) === "true",
      statusArgs: config.get<string[]>("statusArgs", ["--untracked-files=no"])
    };
    this.logger?.info("读取远程 Git 配置", {
      host: resolvedConfig.host,
      port: resolvedConfig.port,
      username: resolvedConfig.username,
      projectPath: resolvedConfig.projectPath,
      privateKeyPath: resolvedConfig.privateKeyPath,
      strictHostKeyChecking: resolvedConfig.strictHostKeyChecking,
      passwordSource: process.env.REMOTE_GIT_DIFF_PASSWORD ? "env" : resolvedConfig.password ? "secret" : "empty",
      projectPathSource: configuredProjectPath ? "config-or-env" : (!host && workspacePath ? "workspace" : "empty")
    });
    return resolvedConfig;
  }

  public getWorkspacePath(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  }

  public getSuggestedProjectPath(host: string, username: string, currentProjectPath = ""): string {
    if (currentProjectPath.trim()) {
      return currentProjectPath.trim();
    }

    const workspacePath = this.getWorkspacePath();
    if (!workspacePath) {
      return "";
    }

    if (!host) {
      return workspacePath;
    }

    if (!username) {
      return "";
    }

    const windowsMountedPath = workspacePath.match(/^[a-zA-Z]:[\\/](.+)$/);
    if (windowsMountedPath) {
      const relativePath = windowsMountedPath[1].replace(/\\/g, "/");
      return `/home/${username}/${relativePath}`;
    }

    return workspacePath.replace(/\\/g, "/");
  }

  public async getSettingsForm(): Promise<RemoteGitSettingsForm> {
    const config = await this.getConfig();
    return {
      host: config.host,
      port: config.port,
      username: config.username,
      projectPath: config.projectPath || this.getSuggestedProjectPath(config.host, config.username),
      privateKeyPath: config.privateKeyPath,
      password: config.password ?? "",
      strictHostKeyChecking: config.strictHostKeyChecking
    };
  }

  public async saveSettings(form: RemoteGitSettingsForm): Promise<void> {
    this.logger?.info("保存远程配置", {
      host: form.host,
      port: form.port,
      username: form.username,
      projectPath: form.projectPath,
      hasPassword: Boolean(form.password),
      hasPrivateKey: Boolean(form.privateKeyPath)
    });

    this.validatedConfigCache = undefined;

    const config = vscode.workspace.getConfiguration("remoteGitDiff");
    await config.update("host", form.host.trim(), vscode.ConfigurationTarget.Global);
    await config.update("port", form.port, vscode.ConfigurationTarget.Global);
    await config.update("username", form.username.trim(), vscode.ConfigurationTarget.Global);
    await config.update("projectPath", form.projectPath.trim(), vscode.ConfigurationTarget.Global);
    await config.update("privateKeyPath", form.privateKeyPath.trim(), vscode.ConfigurationTarget.Global);
    await config.update("strictHostKeyChecking", form.strictHostKeyChecking, vscode.ConfigurationTarget.Global);

    if (form.password) {
      await this.setPassword(form.password);
    } else if (!form.privateKeyPath.trim()) {
      await this.clearPassword();
    }
  }

  public async testConnection(form?: RemoteGitSettingsForm): Promise<string> {
    this.logger?.info(
      "开始测试连接",
      form
        ? {
            host: form.host,
            port: form.port,
            username: form.username,
            projectPath: form.projectPath
          }
        : "使用已保存配置"
    );

    const config = form
      ? {
          host: form.host.trim(),
          port: form.port,
          username: form.username.trim(),
          password: form.password || ((await this.secrets.get("remoteGitDiff.password")) ?? undefined),
          projectPath: form.projectPath.trim(),
          privateKeyPath: form.privateKeyPath.trim(),
          strictHostKeyChecking: form.strictHostKeyChecking,
          statusArgs: vscode.workspace.getConfiguration("remoteGitDiff").get<string[]>("statusArgs", ["--untracked-files=no"])
        }
      : await this.getConfig();

    const resolvedConfig = await this.getValidatedConfig(config, false);
    const branch = await this.getCurrentBranch(resolvedConfig);
    this.logger?.info("连接测试成功", { projectPath: resolvedConfig.projectPath, branch });
    return `${resolvedConfig.projectPath}\n分支：${branch}`;
  }

  public async getCurrentBranch(config?: RemoteGitConfig): Promise<string> {
    const resolvedConfig = config ?? await this.getValidatedConfig();
    const branch = (await this.runner.runGit(resolvedConfig, ["branch", "--show-current"])).trim();
    return branch || "(分离头指针)";
  }

  public async listChanges(): Promise<RemoteGitChange[]> {
    const config = await this.getValidatedConfig();
    const args = ["status", "--porcelain=v1", "-z", ...config.statusArgs];
    const output = await this.runner.runGit(config, args);
    const changes = this.parsePorcelain(output);
    this.logger?.info("读取变更列表完成", { count: changes.length });
    return changes;
  }

  public async getDiffStats(change: RemoteGitChange, signal?: AbortSignal): Promise<RemoteGitDiffStats> {
    const config = await this.getValidatedConfig();
    const output = await this.runner.runGit(config, ["diff", "--numstat", "--", change.path], signal);
    const firstLine = output.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";

    if (!firstLine) {
      return { added: 0, deleted: 0, isBinary: false };
    }

    const parts = firstLine.split("\t");
    const isBinary = parts[0] === "-" && parts[1] === "-";
    const added = isBinary ? 0 : Number(parts[0] ?? "0");
    const deleted = isBinary ? 0 : Number(parts[1] ?? "0");
    const stats = {
      added: Number.isFinite(added) ? added : 0,
      deleted: Number.isFinite(deleted) ? deleted : 0,
      isBinary
    };

    this.logger?.info("读取 diff 统计完成", { path: change.path, ...stats, raw: firstLine });
    return stats;
  }

  public async readPatch(change: RemoteGitChange, contextLines = 3, signal?: AbortSignal): Promise<string> {
    const config = await this.getValidatedConfig();
    const patch = await this.runner.runGit(config, ["diff", `--unified=${contextLines}`, "--", change.path], signal);
    this.logger?.info("读取 patch 完成", {
      path: change.path,
      contextLines,
      length: Buffer.byteLength(patch, "utf8")
    });
    return patch;
  }

  public async getHeadContentLength(change: RemoteGitChange, signal?: AbortSignal): Promise<number> {
    if (change.code === "A" || change.code === "?") {
      return 0;
    }

    const config = await this.getValidatedConfig();
    const target = change.originalPath ?? change.path;
    const output = await this.runner.runGit(config, ["cat-file", "-s", `HEAD:${target}`], signal);
    const length = Number(output.trim());
    const resolved = Number.isFinite(length) ? length : 0;
    this.logger?.info("读取 HEAD 内容长度完成", {
      path: target,
      length: resolved
    });
    return resolved;
  }

  public async getWorkingTreeContentLength(change: RemoteGitChange, signal?: AbortSignal): Promise<number> {
    if (change.code === "D") {
      return 0;
    }

    const config = await this.getValidatedConfig();
    if (!config.host) {
      const base = vscode.Uri.file(config.projectPath);
      const uri = vscode.Uri.joinPath(base, ...change.path.split("/"));
      const stat = await vscode.workspace.fs.stat(uri);
      this.logger?.info("读取工作区内容长度完成", {
        path: change.path,
        length: stat.size
      });
      return stat.size;
    }

    const output = await this.runner.runShell(
      config,
      `cd ${shellEscape(config.projectPath)} && wc -c < ${shellEscape(change.path)}`,
      signal
    );
    const length = Number(output.trim());
    const resolved = Number.isFinite(length) ? length : 0;
    this.logger?.info("读取工作区内容长度完成", {
      path: change.path,
      length: resolved
    });
    return resolved;
  }

  public async readHeadContent(change: RemoteGitChange, signal?: AbortSignal): Promise<string> {
    const config = await this.getValidatedConfig();
    const target = change.originalPath ?? change.path;

    try {
      const content = await this.runner.runGit(config, ["show", `HEAD:${target}`], signal);
      this.logger?.info("读取 HEAD 内容完成", {
        path: target,
        length: Buffer.byteLength(content, "utf8")
      });
      return content;
    } catch (error) {
      if (change.code === "A" || change.code === "?") {
        return "";
      }
      throw error;
    }
  }

  public async readWorkingTreeContent(change: RemoteGitChange, signal?: AbortSignal): Promise<string> {
    const config = await this.getValidatedConfig();

    if (change.code === "D") {
      return "";
    }

    if (!change.path) {
      throw new Error("当前变更项缺少文件路径，无法打开对比。");
    }

    const content = await this.runner.readFile(config, change.path, signal);
    this.logger?.info("读取工作区内容完成", {
      path: change.path,
      length: Buffer.byteLength(content, "utf8")
    });
    return content;
  }

  public async clearValidationCache(): Promise<void> {
    this.validatedConfigCache = undefined;
  }

  public async readHiddenTrackedFiles(): Promise<{ filePath: string; paths: string[] }> {
    const config = await this.getValidatedConfig();
    const filePath = this.getTrackedChangeExcludeFilePath(config.projectPath, Boolean(config.host));

    try {
      const content = await this.readTextFile(config, filePath);
      const paths = [...new Set(
        content
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
      )].sort((left, right) => left.localeCompare(right));
      return { filePath, paths };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/no such file|cannot find path|enoent/i.test(message)) {
        return { filePath, paths: [] };
      }
      throw error;
    }
  }

  public async addHiddenTrackedFiles(paths: string[]): Promise<{ filePath: string; paths: string[] }> {
    const current = await this.readHiddenTrackedFiles();
    const nextPaths = [...new Set([...current.paths, ...paths.map((item) => item.trim()).filter(Boolean)])]
      .sort((left, right) => left.localeCompare(right));
    await this.writeTrackedExcludeFile(current.filePath, nextPaths);
    return {
      filePath: current.filePath,
      paths: nextPaths
    };
  }

  public async clearHiddenTrackedFiles(): Promise<{ filePath: string; paths: string[] }> {
    const current = await this.readHiddenTrackedFiles();
    await this.writeTrackedExcludeFile(current.filePath, []);
    return {
      filePath: current.filePath,
      paths: []
    };
  }

  private async getValidatedConfig(
    providedConfig?: RemoteGitConfig,
    allowCache = true
  ): Promise<RemoteGitConfig> {
    const config = providedConfig ?? await this.getConfig();

    if (!config.projectPath) {
      if (config.host) {
        throw new Error("已配置远程主机时，仓库路径必须填写 Linux 路径，例如 /home/user/src/project。");
      }
      throw new Error("请先在 VS Code 中打开 Git 工程目录，或手动设置仓库路径。");
    }

    if (config.host && !config.username) {
      throw new Error("已配置远程主机时，必须填写 SSH 用户名。");
    }

    if (config.host && /^[a-zA-Z]:\\/.test(config.projectPath)) {
      throw new Error(`当前路径 '${config.projectPath}' 是 Windows 路径。连接远程 Linux 时，请填写服务器上的 Linux 路径，例如 /home/user/src/project。`);
    }

    const cacheKey = this.getConfigCacheKey(config);
    if (allowCache && this.validatedConfigCache?.cacheKey === cacheKey) {
      return {
        ...config,
        projectPath: this.validatedConfigCache.resolvedProjectPath
      };
    }

    try {
      const result = await this.runner.runGit(config, ["rev-parse", "--show-toplevel"]);
      const resolvedPath = result.trim() || config.projectPath;
      this.validatedConfigCache = {
        cacheKey,
        resolvedProjectPath: resolvedPath
      };
      this.logger?.info("仓库路径校验通过", { projectPath: resolvedPath, cache: allowCache });
      return {
        ...config,
        projectPath: resolvedPath
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.error("仓库路径校验失败", {
        host: config.host,
        port: config.port,
        username: config.username,
        projectPath: config.projectPath,
        error: message
      });

      if (this.isAuthenticationError(message) || this.isConnectionError(message)) {
        throw error;
      }

      throw new Error(`路径 '${config.projectPath}' 不是有效的 Git 仓库。如果已设置远程主机，这里必须是服务器上的仓库路径。原始错误: ${message}`);
    }
  }

  private getTrackedChangeExcludeFilePath(projectPath: string, isRemote: boolean): string {
    if (isRemote) {
      const normalized = projectPath.replace(/\\/g, "/").replace(/\/+$/, "");
      const parent = normalized.slice(0, normalized.lastIndexOf("/")) || "/";
      return `${parent}/${TRACKED_CHANGE_EXCLUDE_FILE_NAME}`;
    }

    return path.join(path.dirname(projectPath), TRACKED_CHANGE_EXCLUDE_FILE_NAME);
  }

  private async readTextFile(config: RemoteGitConfig, absolutePath: string): Promise<string> {
    if (!config.host) {
      const content = await vscode.workspace.fs.readFile(vscode.Uri.file(absolutePath));
      return Buffer.from(content).toString("utf8");
    }

    return await this.runner.runShell(
      config,
      `[ -f ${shellEscape(absolutePath)} ] && cat ${shellEscape(absolutePath)} || true`
    );
  }

  private async writeTrackedExcludeFile(absolutePath: string, paths: string[]): Promise<void> {
    const config = await this.getValidatedConfig();
    const content = paths.join("\n");
    if (!config.host) {
      const fileUri = vscode.Uri.file(absolutePath);
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(absolutePath)));
      await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, "utf8"));
      return;
    }

    const dirPath = absolutePath.slice(0, absolutePath.lastIndexOf("/")) || "/";
    const encodedContent = Buffer.from(content, "utf8").toString("base64");
    await this.runner.runShell(
      config,
      `mkdir -p ${shellEscape(dirPath)} && python - <<'PY'
from pathlib import Path
import base64

path = Path(${shellEscape(absolutePath)})
path.write_bytes(base64.b64decode(${shellEscape(encodedContent)}))
PY`
    );
  }

  private isAuthenticationError(message: string): boolean {
    return /authentication methods failed|permission denied|auth fail|password/i.test(message);
  }

  private isConnectionError(message: string): boolean {
    return /timed out|timeout|econnrefused|ehostunreach|enotfound|network|connect/i.test(message);
  }

  private getConfigCacheKey(config: RemoteGitConfig): string {
    return JSON.stringify({
      host: config.host,
      port: config.port,
      username: config.username,
      projectPath: config.projectPath,
      privateKeyPath: config.privateKeyPath,
      strictHostKeyChecking: config.strictHostKeyChecking,
      hasPassword: Boolean(config.password)
    });
  }

  private parsePorcelain(output: string): RemoteGitChange[] {
    const entries = output.split("\0").filter(Boolean);
    const changes: RemoteGitChange[] = [];

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const status = entry.slice(0, 2);
      const path = entry.slice(3);
      const code = this.mapStatus(status);

      if (status.startsWith("R") || status.startsWith("C")) {
        const targetPath = path;
        const originalPath = entries[index + 1];
        if (!originalPath) {
          continue;
        }
        changes.push({
          status,
          code,
          path: targetPath,
          originalPath
        });
        index += 1;
        continue;
      }

      changes.push({
        status,
        code,
        path
      });
    }

    return changes;
  }

  private mapStatus(status: string): RemoteGitChange["code"] {
    const normalized = `${status[0]}${status[1]}`.trim();
    if (normalized.includes("U")) {
      return "U";
    }
    if (normalized.includes("R")) {
      return "R";
    }
    if (normalized.includes("C")) {
      return "C";
    }
    if (normalized.includes("A")) {
      return "A";
    }
    if (normalized.includes("D")) {
      return "D";
    }
    if (normalized.includes("M")) {
      return "M";
    }
    return "?";
  }

  private async setPassword(password: string): Promise<void> {
    await this.secrets.store("remoteGitDiff.password", password);
  }

  private async clearPassword(): Promise<void> {
    await this.secrets.delete("remoteGitDiff.password");
  }
}
