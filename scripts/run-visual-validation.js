const path = require("node:path");
const os = require("node:os");
const cp = require("node:child_process");
const fs = require("node:fs/promises");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureDir(targetPath) {
  await fs.mkdir(targetPath, { recursive: true });
}

async function readRecentLog(logPath, startedAtIso) {
  try {
    const content = await fs.readFile(logPath, "utf8");
    return content
      .split(/\r?\n/)
      .filter((line) => line.startsWith("["))
      .filter((line) => {
        const match = line.match(/^\[([^\]]+)\]/);
        return Boolean(match && match[1] >= startedAtIso);
      })
      .join("\n");
  } catch {
    return "";
  }
}

function extractJsonFromLine(line) {
  const marker = " | ";
  const index = line.indexOf(marker);
  if (index < 0) {
    return undefined;
  }

  const jsonText = line.slice(index + marker.length).trim();
  if (!jsonText.startsWith("{")) {
    return undefined;
  }

  try {
    return JSON.parse(jsonText);
  } catch {
    return undefined;
  }
}

function parseSelfTestLog(logText, runId) {
  const lines = logText.split(/\r?\n/).filter(Boolean);
  const completionLine = lines.find(
    (line) => line.includes("[SELF-TEST] 启动自测完成") && line.includes(`"runId":"${runId}"`)
  );
  const failureLine = lines.find(
    (line) => line.includes("[SELF-TEST] 启动自测失败") && line.includes(`"runId":"${runId}"`)
  );
  const summaryLine = lines.find(
    (line) => line.includes("[SELF-TEST] 项目级汇总") && line.includes(`"runId":"${runId}"`)
  );
  const detailsLine = lines.find(
    (line) => line.includes("[SELF-TEST] 项目级明细") && line.includes(`"runId":"${runId}"`)
  );

  return {
    completionLine,
    failureLine,
    summary: summaryLine ? extractJsonFromLine(summaryLine) : undefined,
    details: detailsLine ? extractJsonFromLine(detailsLine) : undefined
  };
}

async function waitForSelfTest(logPath, startedAtIso, runId, timeoutMs) {
  const startedAt = Date.now();
  let lastProgressAt = Date.now();
  let lastRecent = "";
  while (Date.now() - startedAt < timeoutMs) {
    const recent = await readRecentLog(logPath, startedAtIso);
    if (recent && recent !== lastRecent) {
      lastRecent = recent;
      lastProgressAt = Date.now();
    }
    const parsed = parseSelfTestLog(recent, runId);
    if (parsed.failureLine) {
      throw new Error(parsed.failureLine);
    }
    if (parsed.completionLine) {
      return {
        recentLog: recent,
        parsed
      };
    }
    if (Date.now() - lastProgressAt > 45_000) {
      throw new Error(`自测日志长时间无进展，疑似卡死: ${runId}`);
    }
    await sleep(1000);
  }
  throw new Error(`等待启动自测完成超时: ${runId}`);
}

async function killProcessTree(pid) {
  if (!pid) {
    return;
  }

  await new Promise((resolve) => {
    const child = cp.spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });
}

async function listProcessIdsByUserDataDir(userDataDir) {
  const escaped = userDataDir.replace(/'/g, "''");
  const script = [
    `$target = '${escaped}'`,
    "Get-CimInstance Win32_Process |",
    "  Where-Object { $_.CommandLine -and $_.CommandLine -like ('*' + $target + '*') } |",
    "  Select-Object -ExpandProperty ProcessId"
  ].join(" ");

  return await new Promise((resolve) => {
    const child = cp.spawn("powershell.exe", ["-NoProfile", "-Command", script], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.on("error", () => resolve([]));
    child.on("close", () => {
      const ids = stdout
        .split(/\r?\n/)
        .map((line) => Number(line.trim()))
        .filter((value) => Number.isInteger(value) && value > 0);
      resolve(ids);
    });
  });
}

async function killProcessesByUserDataDir(userDataDir) {
  const pids = await listProcessIdsByUserDataDir(userDataDir);
  for (const pid of pids) {
    await killProcessTree(pid);
  }
}

async function listProcessIdsByExecutablePath(executablePath) {
  const escaped = executablePath.replace(/'/g, "''");
  const script = [
    `$target = '${escaped}'`,
    "Get-CimInstance Win32_Process |",
    "  Where-Object { $_.ExecutablePath -and $_.ExecutablePath -eq $target } |",
    "  Select-Object -ExpandProperty ProcessId"
  ].join(" ");

  return await new Promise((resolve) => {
    const child = cp.spawn("powershell.exe", ["-NoProfile", "-Command", script], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.on("error", () => resolve([]));
    child.on("close", () => {
      const ids = stdout
        .split(/\r?\n/)
        .map((line) => Number(line.trim()))
        .filter((value) => Number.isInteger(value) && value > 0);
      resolve(ids);
    });
  });
}

async function killProcessesByExecutablePath(executablePath) {
  const pids = await listProcessIdsByExecutablePath(executablePath);
  for (const pid of pids) {
    await killProcessTree(pid);
  }
}

function buildMarkdownReport(report) {
  const summary = report.summary ?? {};
  const results = Array.isArray(report.details?.results) ? report.details.results : [];
  const slowest = [...results]
    .sort((left, right) => Number(right.durationMs ?? 0) - Number(left.durationMs ?? 0))
    .slice(0, 10);

  const lines = [
    "# 可视化验证报告",
    "",
    `- 运行时间: ${report.startedAt} -> ${report.endedAt}`,
    `- 运行 ID: ${report.runId}`,
    `- 工作区: ${report.workspacePath}`,
    `- 临时用户目录: ${report.userDataDir}`,
    `- 日志文件: ${report.logPath}`,
    `- 结果: ${report.status}`,
    "",
    "## 项目级汇总",
    "",
    `- 变更总数: ${summary.totalChanges ?? 0}`,
    `- 已测文件数: ${summary.testedChanges ?? 0}`,
    `- 文本文件数: ${summary.textCount ?? 0}`,
    `- 二进制文件数: ${summary.binaryCount ?? 0}`,
    `- 平均打开耗时: ${summary.avgDurationMs ?? 0} ms`,
    `- 最大打开耗时: ${summary.maxDurationMs ?? 0} ms`,
    `- 最慢文件: ${summary.slowestPath ?? ""}`,
    "",
    "## 最慢文件 Top 10",
    "",
    "| 文件 | 类型 | 耗时(ms) | 新增 | 删除 |",
    "| --- | --- | ---: | ---: | ---: |"
  ];

  for (const item of slowest) {
    lines.push(
      `| ${item.path ?? ""} | ${item.kind ?? ""} | ${Number(item.durationMs ?? 0)} | ${Number(item.added ?? 0)} | ${Number(item.deleted ?? 0)} |`
    );
  }

  if (report.error) {
    lines.push("", "## 失败信息", "", "```text", String(report.error), "```");
  }

  lines.push("", "## 近期日志", "", "```text", report.recentLog || "(无)", "```");
  return lines.join("\n");
}

async function writeReports(reportRoot, report) {
  await ensureDir(reportRoot);
  await fs.writeFile(path.join(reportRoot, "visual-report.json"), JSON.stringify(report, null, 2), "utf8");
  await fs.writeFile(path.join(reportRoot, "visual-report.md"), buildMarkdownReport(report), "utf8");
}

async function main() {
  const workspacePath = "X:\\src\\dmu\\hvli\\trunk";
  const extensionDevelopmentPath = path.resolve(__dirname, "..");
  const vscodeInstallRoot = path.resolve(__dirname, "..", ".vscode-test", "vscode-win32-x64-archive-1.116.0");
  const vscodeExePath = path.resolve(vscodeInstallRoot, "Code.exe");
  const vscodeCliPath = path.resolve(
    vscodeInstallRoot,
    "bin",
    "code.cmd"
  );
  const startedAtIso = new Date().toISOString();
  const runId = `selftest-${Date.now()}`;
  const userDataDir = path.join(os.tmpdir(), `remote-git-diff-selftest-${Date.now()}`);
  const logPath = path.join(
    userDataDir,
    "User",
    "globalStorage",
    "local.remote-git-diff-tool",
    "logs",
    "remote-git-diff.log"
  );
  const reportRoot = path.resolve(__dirname, "..", "test-results");

  const args = [
    "--new-window",
    "--skip-welcome",
    "--skip-release-notes",
    "--disable-workspace-trust",
    `--user-data-dir=${userDataDir}`,
    `--extensionDevelopmentPath=${extensionDevelopmentPath}`,
    workspacePath
  ];

  let child;
  const report = {
    runId,
    startedAt: startedAtIso,
    endedAt: "",
    workspacePath,
    userDataDir,
    logPath,
    status: "running",
    summary: undefined,
    details: undefined,
    recentLog: "",
    error: ""
  };

  try {
    child = cp.spawn("cmd.exe", ["/c", vscodeCliPath, ...args], {
      env: {
        ...process.env,
        REMOTE_GIT_DIFF_HOST: "10.239.98.198",
        REMOTE_GIT_DIFF_PORT: "22",
        REMOTE_GIT_DIFF_USERNAME: "wanggang",
        REMOTE_GIT_DIFF_PASSWORD: "Power123#12345678!",
        REMOTE_GIT_DIFF_PROJECT_PATH: "/home/wanggang/src/dmu/hvli/trunk",
        REMOTE_GIT_DIFF_STRICT_HOST_KEY_CHECKING: "true",
        REMOTE_GIT_DIFF_SELF_TEST: "1",
        REMOTE_GIT_DIFF_SELF_TEST_RUN_ID: runId
      },
      stdio: "ignore",
      shell: false,
      detached: false
    });

    const result = await waitForSelfTest(logPath, startedAtIso, runId, 30 * 60 * 1000);
    report.status = "passed";
    report.summary = result.parsed.summary;
    report.details = result.parsed.details;
    report.recentLog = result.recentLog;
  } catch (error) {
    report.status = "failed";
    report.error = error instanceof Error ? `${error.message}\n${error.stack ?? ""}`.trim() : String(error);
    report.recentLog = await readRecentLog(logPath, startedAtIso);
    throw error;
  } finally {
    report.endedAt = new Date().toISOString();
    await writeReports(reportRoot, report);
    await killProcessTree(child?.pid);
    await killProcessesByUserDataDir(userDataDir);
    await killProcessesByExecutablePath(vscodeExePath);
  }

  console.log(JSON.stringify(report.summary ?? {}, null, 2));
  console.log(`报告已写入: ${path.join(reportRoot, "visual-report.md")}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
