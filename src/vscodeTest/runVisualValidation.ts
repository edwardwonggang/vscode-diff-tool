import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";

const PROJECT_PATH = "X:\\src\\dmu\\hvli\\trunk";
const KNOWN_CHANGES = [
  "hvdcli/mcs/src/apps/productApp/businessObject/bcmu/bo_bcmu.c",
  "hvdcli/mcs/src/apps/productApp/businessObject/bcmu/bmu_manage.c",
  "hvdcli/mcs/src/include/pdtbdapi/data_agent_sid_struct.h",
  "hvdcli/mcs/src/include/pdtbdapi/pdt_data_for_valid.h"
];
const LOG_ROOT = path.join(process.env.APPDATA ?? "", "Code", "User", "globalStorage", "local.remote-git-diff-tool");
const VISUAL_LOG_PATH = path.join(LOG_ROOT, "visual-validation.log");
const EXTENSION_LOG_PATH = path.join(LOG_ROOT, "logs", "remote-git-diff.log");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function appendResult(line: string): Promise<void> {
  await fs.mkdir(path.dirname(VISUAL_LOG_PATH), { recursive: true });
  await fs.appendFile(VISUAL_LOG_PATH, `[${new Date().toISOString()}] ${line}\n`, "utf8");
}

async function runCommand(name: string, callback: () => Promise<void>): Promise<void> {
  await appendResult(`START ${name}`);
  try {
    await callback();
    await appendResult(`PASS ${name}`);
  } catch (error) {
    const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
    await appendResult(`FAIL ${name} ${message}`);
    throw error;
  }
}

async function waitForTab(labelIncludes: string, timeoutMs = 8000): Promise<void> {
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

async function getExtensionLog(): Promise<string> {
  try {
    return await fs.readFile(EXTENSION_LOG_PATH, "utf8");
  } catch {
    return "";
  }
}

function getRecentLogContent(content: string, startedAtIso: string): string {
  return content
    .split(/\r?\n/)
    .filter((line) => line.includes("["))
    .filter((line) => {
      const match = line.match(/^\[([^\]]+)\]/);
      return Boolean(match?.[1] && match[1] >= startedAtIso);
    })
    .join("\n");
}

async function waitForLog(pattern: RegExp, startedAtIso: string, timeoutMs = 15000): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const content = await getExtensionLog();
    const recent = getRecentLogContent(content, startedAtIso);
    if (pattern.test(recent)) {
      return recent;
    }
    await sleep(250);
  }
  throw new Error(`等待日志命中失败: ${pattern}`);
}

async function assertNoFailureLog(startedAtIso: string, patterns: RegExp[]): Promise<void> {
  const content = await getExtensionLog();
  const recent = getRecentLogContent(content, startedAtIso);

  for (const pattern of patterns) {
    if (pattern.test(recent)) {
      throw new Error(`发现失败日志: ${pattern}\n${recent}`);
    }
  }
}

function asChange(pathValue: string) {
  return {
    status: " M",
    code: "M" as const,
    path: pathValue
  };
}

export async function run(): Promise<void> {
  await fs.mkdir(path.dirname(EXTENSION_LOG_PATH), { recursive: true });
  await appendResult("VISUAL VALIDATION BOOT");
  assert.ok(vscode.workspace.workspaceFolders?.some((folder) => folder.uri.fsPath.toLowerCase() === PROJECT_PATH.toLowerCase()));

  await runCommand("show remote git diff view", async () => {
    await vscode.commands.executeCommand("workbench.view.extension.remoteGitDiff");
    await sleep(1200);
  });

  await runCommand("refresh changes", async () => {
    const startedAtIso = new Date().toISOString();
    await vscode.commands.executeCommand("remoteGitDiff.refresh");
    await waitForLog(/刷新远程变更完成|刷新远程变更失败/, startedAtIso, 20000);
    await assertNoFailureLog(startedAtIso, [/刷新远程变更失败/, /authentication methods failed/i, /不是有效的 Git 仓库/]);
  });

  for (const targetPath of KNOWN_CHANGES) {
    await runCommand(`open diff ${targetPath}`, async () => {
      const startedAtIso = new Date().toISOString();
      await vscode.commands.executeCommand("remoteGitDiff.openDiff", asChange(targetPath));
      await waitForLog(/触发 VS Code 原生左右对比|改用补丁差异视图|打开对比失败/, startedAtIso, 20000);
      const fileName = targetPath.split("/").at(-1) ?? targetPath;
      await waitForTab(fileName, 12000);
      await assertNoFailureLog(startedAtIso, [/打开对比失败/, /authentication methods failed/i]);
    });
  }

  await runCommand("disconnect", async () => {
    await vscode.commands.executeCommand("remoteGitDiff.disconnect");
    await sleep(1000);
  });

  await runCommand("reconnect", async () => {
    const startedAtIso = new Date().toISOString();
    await vscode.commands.executeCommand("remoteGitDiff.reconnect");
    await waitForLog(/刷新远程变更完成|刷新远程变更失败/, startedAtIso, 20000);
    await assertNoFailureLog(startedAtIso, [/刷新远程变更失败/, /authentication methods failed/i]);
  });

  await runCommand("rapid diff switching", async () => {
    const queue = KNOWN_CHANGES.map((targetPath) =>
      vscode.commands.executeCommand("remoteGitDiff.openDiff", asChange(targetPath))
    );
    await Promise.allSettled(queue);
    await sleep(2500);
  });

  await runCommand("open log file", async () => {
    await vscode.commands.executeCommand("remoteGitDiff.openLogFile");
    await waitForTab("remote-git-diff.log", 8000);
  });

  await appendResult("VISUAL VALIDATION COMPLETE");
}
