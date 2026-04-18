import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}\n${error.stack ?? ""}`.trim();
  }
  return String(error);
}

export class ExtensionLogger {
  private logFilePath = "";
  private initPromise: Promise<void> | undefined;

  public constructor(
    private readonly output: vscode.OutputChannel,
    private readonly context: vscode.ExtensionContext
  ) {}

  public async ready(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.initialize();
    }
    await this.initPromise;
  }

  public info(message: string, details?: unknown): void {
    this.write("INFO", message, details);
  }

  public warn(message: string, details?: unknown): void {
    this.write("WARN", message, details);
  }

  public error(message: string, error?: unknown): void {
    this.write("ERROR", message, error);
  }

  public getLogFilePath(): string {
    return this.logFilePath;
  }

  private async initialize(): Promise<void> {
    const logDir = path.join(this.context.globalStorageUri.fsPath, "logs");
    await fs.mkdir(logDir, { recursive: true });
    this.logFilePath = path.join(logDir, "remote-git-diff.log");
    await fs.appendFile(this.logFilePath, `\n[${new Date().toISOString()}] [INFO] 日志系统已启动\n`, "utf8");
  }

  private write(level: "INFO" | "WARN" | "ERROR", message: string, details?: unknown): void {
    const line = `[${new Date().toISOString()}] [${level}] ${message}${details === undefined ? "" : ` | ${this.formatDetails(details)}`}`;
    this.output.appendLine(line);
    void this.ready().then(async () => {
      if (!this.logFilePath) {
        return;
      }
      await fs.appendFile(this.logFilePath, `${line}\n`, "utf8");
    }).catch(() => {
      // Avoid recursive logging on logger failures.
    });
  }

  private formatDetails(details: unknown): string {
    if (details instanceof Error) {
      return stringifyError(details);
    }
    if (typeof details === "string") {
      return details;
    }
    try {
      return JSON.stringify(details);
    } catch {
      return String(details);
    }
  }
}
