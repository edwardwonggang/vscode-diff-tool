import * as cp from "node:child_process";
import { promises as fs } from "node:fs";
import { Client } from "ssh2";
import * as vscode from "vscode";
import { ExtensionLogger } from "./logger";
import { RemoteGitConfig } from "./types";

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

interface ConnectionEntry {
  client: Client;
  ready: Promise<Client>;
  key: string;
  lastUsedAt: number;
  summary: {
    host: string;
    port: number;
    username: string;
  };
}

export type SshConnectionEventType =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error"
  | "timeout";

export interface SshConnectionEvent {
  type: SshConnectionEventType;
  key: string;
  host: string;
  port: number;
  username: string;
  reason?: string;
}

export class SshRunner {
  private readonly connections = new Map<string, ConnectionEntry>();
  private readonly idleTimeoutMs = 5 * 60 * 1000;
  private readonly commandTimeoutMs = 60 * 1000;
  private readonly cleanupTimer: NodeJS.Timeout;
  private readonly connectionEventEmitter = new vscode.EventEmitter<SshConnectionEvent>();

  public readonly onDidChangeConnectionState = this.connectionEventEmitter.event;

  public constructor(
    private readonly output: vscode.OutputChannel,
    private readonly logger?: ExtensionLogger
  ) {
    this.cleanupTimer = setInterval(() => this.cleanupIdleConnections(), 60 * 1000);
    this.cleanupTimer.unref();
  }

  public async runShell(config: RemoteGitConfig, command: string, signal?: AbortSignal): Promise<string> {
    if (!config.host) {
      return await this.runLocalShell(command, config.projectPath, signal);
    }
    return await this.runRemoteShell(config, command, signal);
  }

  public async runGit(config: RemoteGitConfig, gitArgs: string[], signal?: AbortSignal): Promise<string> {
    if (!config.host) {
      return await this.runLocalGit(gitArgs, config.projectPath, signal);
    }
    return await this.runRemoteShell(config, this.buildGitCommand(config, gitArgs), signal);
  }

  public async readFile(config: RemoteGitConfig, relativePath: string, signal?: AbortSignal): Promise<string> {
    if (!config.host) {
      const base = vscode.Uri.file(config.projectPath);
      const uri = vscode.Uri.joinPath(base, ...relativePath.split("/"));
      this.throwIfAborted(signal);
      const content = await vscode.workspace.fs.readFile(uri);
      this.throwIfAborted(signal);
      return Buffer.from(content).toString("utf8");
    }
    const remoteCommand = `cd ${shellEscape(config.projectPath)} && cat ${shellEscape(relativePath)}`;
    return await this.runRemoteShell(config, remoteCommand, signal);
  }

  public async readPrivateKey(path: string): Promise<string> {
    return await fs.readFile(path, "utf8");
  }

  public async resetConnections(): Promise<void> {
    this.closeAllConnections("manual-reset");
  }

  public dispose(): void {
    clearInterval(this.cleanupTimer);
    this.closeAllConnections("dispose");
  }

  public buildGitCommand(config: RemoteGitConfig, gitArgs: string[]): string {
    const cd = `cd ${shellEscape(config.projectPath)}`;
    const git = `git ${gitArgs.map(shellEscape).join(" ")}`;
    return `${cd} && ${git}`;
  }

  private async runLocalGit(gitArgs: string[], cwd: string, signal?: AbortSignal): Promise<string> {
    this.output.appendLine(`git ${gitArgs.join(" ")}`);
    this.logger?.info("执行本地 Git 命令", { cwd, gitArgs });
    return await new Promise<string>((resolve, reject) => {
      const child = cp.spawn("git", gitArgs, { cwd, windowsHide: true });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const onAbort = (): void => {
        child.kill();
        reject(this.createAbortError());
      };

      if (signal?.aborted) {
        child.kill();
        reject(this.createAbortError());
        return;
      }

      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
      child.on("error", reject);
      child.on("close", (code) => {
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) {
          reject(this.createAbortError());
          return;
        }
        const stderrText = Buffer.concat(stderr).toString("utf8").trim();
        if (code !== 0) {
          reject(new Error(stderrText || `git exited with code ${code ?? "unknown"}`));
          return;
        }
        resolve(Buffer.concat(stdout).toString("utf8"));
      });
    });
  }

  private async runLocalShell(command: string, cwd: string, signal?: AbortSignal): Promise<string> {
    this.output.appendLine(command);
    this.logger?.info("执行本地命令", { cwd, command });
    return await new Promise<string>((resolve, reject) => {
      const child = cp.spawn(command, { cwd, shell: true, windowsHide: true });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const onAbort = (): void => {
        child.kill();
        reject(this.createAbortError());
      };

      if (signal?.aborted) {
        child.kill();
        reject(this.createAbortError());
        return;
      }

      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
      child.on("error", reject);
      child.on("close", (code) => {
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) {
          reject(this.createAbortError());
          return;
        }
        const stderrText = Buffer.concat(stderr).toString("utf8").trim();
        if (code !== 0) {
          reject(new Error(stderrText || `command exited with code ${code ?? "unknown"}`));
          return;
        }
        resolve(Buffer.concat(stdout).toString("utf8"));
      });
    });
  }

  private async runRemoteShell(config: RemoteGitConfig, remoteCommand: string, signal?: AbortSignal): Promise<string> {
    this.output.appendLine(`ssh ${config.username}@${config.host}: ${remoteCommand}`);
    this.logger?.info("执行远程命令", {
      host: config.host,
      port: config.port,
      username: config.username,
      projectPath: config.projectPath,
      command: remoteCommand
    });

    const connection = await this.getConnection(config);

    try {
      return await new Promise<string>((resolve, reject) => {
        let finished = false;
        let timeoutHandle: NodeJS.Timeout | undefined;

        const settle = (handler: () => void): void => {
          if (finished) {
            return;
          }
          finished = true;
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
          handler();
        };

        connection.exec(remoteCommand, (error: Error | undefined, stream: any) => {
          if (error) {
            settle(() => reject(error));
            return;
          }

          const stdout: Buffer[] = [];
          const stderr: Buffer[] = [];

          const onAbort = (): void => {
            try {
              stream.close?.();
            } catch {
              // ignore
            }
            settle(() => reject(this.createAbortError()));
          };

          if (signal?.aborted) {
            onAbort();
            return;
          }

          signal?.addEventListener("abort", onAbort, { once: true });
          timeoutHandle = setTimeout(() => {
            this.logger?.error("远程命令执行超时", {
              command: remoteCommand,
              timeoutMs: this.commandTimeoutMs
            });
            this.emitConnectionEvent(config, "timeout", "命令执行超时");
            try {
              stream.close?.();
            } catch {
              // ignore
            }
            this.dropConnection(config, "timeout");
            settle(() => reject(new Error(`远程命令执行超时，超过 ${this.commandTimeoutMs} ms`)));
          }, this.commandTimeoutMs);

          stream.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
          stream.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
          stream.on("close", (code: number | undefined) => {
            signal?.removeEventListener("abort", onAbort);
            if (signal?.aborted) {
              settle(() => reject(this.createAbortError()));
              return;
            }
            const stderrText = Buffer.concat(stderr).toString("utf8").trim();
            if ((code ?? 0) !== 0) {
              settle(() => reject(new Error(stderrText || `ssh exited with code ${code ?? "unknown"}`)));
              return;
            }
            const stdoutText = Buffer.concat(stdout).toString("utf8");
            this.logger?.info("远程命令执行完成", {
              command: remoteCommand,
              stdoutLength: Buffer.byteLength(stdoutText, "utf8")
            });
            settle(() => resolve(stdoutText));
          });
        });
      });
    } catch (error) {
      this.logger?.error("远程命令异常，准备丢弃当前连接", error);
      this.dropConnection(config, "command-error");
      throw error;
    }
  }

  private async getConnection(config: RemoteGitConfig): Promise<Client> {
    const key = this.getConnectionKey(config);
    const existing = this.connections.get(key);
    if (existing) {
      existing.lastUsedAt = Date.now();
      this.logger?.info("复用 SSH 连接", { key });
      return await existing.ready;
    }

    this.emitConnectionEvent(config, "connecting");
    const client = new Client();
    const privateKey = config.privateKeyPath
      ? await this.readPrivateKey(config.privateKeyPath)
      : undefined;

    const ready = new Promise<Client>((resolve, reject) => {
      let settled = false;

      const fail = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.connections.delete(key);
        this.emitConnectionEvent(config, "error", error.message);
        reject(error);
      };

      client
        .on("ready", () => {
          if (settled) {
            return;
          }
          settled = true;
          this.emitConnectionEvent(config, "connected");
          resolve(client);
        })
        .on("close", () => {
          this.connections.delete(key);
          this.emitConnectionEvent(config, "disconnected", "SSH 连接已关闭");
        })
        .on("error", (error: Error) => {
          fail(error);
        })
        .connect({
          host: config.host,
          port: config.port,
          username: config.username,
          password: config.password,
          privateKey,
          hostVerifier: config.strictHostKeyChecking ? undefined : () => true
        });
    });

    this.connections.set(key, {
      client,
      ready,
      key,
      lastUsedAt: Date.now(),
      summary: {
        host: config.host,
        port: config.port,
        username: config.username
      }
    });
    this.logger?.info("创建新的 SSH 连接", {
      host: config.host,
      port: config.port,
      username: config.username
    });

    return await ready;
  }

  private getConnectionKey(config: RemoteGitConfig): string {
    const auth = config.privateKeyPath
      ? `key:${config.privateKeyPath}`
      : `password:${config.password ? "set" : "empty"}`;
    return `${config.host}|${config.port}|${config.username}|${config.strictHostKeyChecking}|${auth}`;
  }

  private dropConnection(config: RemoteGitConfig, reason: string): void {
    const key = this.getConnectionKey(config);
    const entry = this.connections.get(key);
    if (!entry) {
      return;
    }
    this.logger?.warn("主动丢弃 SSH 连接", { key, reason });
    entry.client.end();
    this.connections.delete(key);
    this.emitConnectionEvent(config, "disconnected", reason);
  }

  private closeAllConnections(reason: string): void {
    for (const entry of this.connections.values()) {
      entry.client.end();
    }
    this.connections.clear();
    this.logger?.info("关闭全部 SSH 连接", { reason });
  }

  private cleanupIdleConnections(): void {
    const threshold = Date.now() - this.idleTimeoutMs;
    for (const [key, entry] of this.connections.entries()) {
      if (entry.lastUsedAt < threshold) {
        this.logger?.info("清理空闲 SSH 连接", { key });
        entry.client.end();
        this.connections.delete(key);
        this.connectionEventEmitter.fire({
          type: "disconnected",
          key,
          host: entry.summary.host,
          port: entry.summary.port,
          username: entry.summary.username,
          reason: "idle-timeout"
        });
      }
    }
  }

  private emitConnectionEvent(
    config: RemoteGitConfig,
    type: SshConnectionEventType,
    reason?: string
  ): void {
    this.connectionEventEmitter.fire({
      type,
      key: this.getConnectionKey(config),
      host: config.host,
      port: config.port,
      username: config.username,
      reason
    });
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw this.createAbortError();
    }
  }

  private createAbortError(): Error {
    const error = new Error("Request aborted");
    error.name = "AbortError";
    return error;
  }
}
