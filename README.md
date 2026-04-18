# 远程 Git Diff

这个 VS Code 插件通过 SSH 连接远程 Linux 服务器，读取远程仓库中的 tracked 文件变更，并在 VS Code 内直接打开左右对比。

## 功能

- 通过 `git status --porcelain=v1 -z` 读取远程仓库中的 tracked 文件变更
- 以目录树形式展示修改、新增、删除、重命名、复制和冲突文件
- 点击文件后，使用远程 `HEAD` 内容与远程工作区当前内容做左右对比
- 所有 Git 判断都在 Linux 上执行，避免 Windows 换行符和文件属性误判

## 设置页面

可通过命令面板执行“打开远程 Git Diff 设置”，也可以在首次刷新时自动弹出设置页。

设置页支持：

- 保存 `host`、`port`、`username`、Linux 仓库路径、密码和私钥路径
- 持久化保存到 VS Code，只需填写一次
- 保存前先测试 SSH 连接
- 一步完成“保存并连接”
- 根据当前 Windows 挂载工作区自动推断 Linux 仓库路径

## 路径规则

- 如果项目本身就是通过 VS Code `Remote - SSH` 打开的，请将 `remoteGitDiff.host` 留空，插件会直接使用当前 Linux 工作区路径。
- 如果设置了 `remoteGitDiff.host`，那么 `remoteGitDiff.projectPath` 必须填写该服务器上的 Linux 路径，例如 `/home/wanggang/src/dmu/hvli/trunk`。
- 不要把 `X:\src\dmu\hvli\trunk` 这种 Windows 路径直接当作远程仓库路径。
- 如果当前 Windows 工作区类似 `X:\src\dmu\hvli\trunk`，设置页会默认建议 `/home/<username>/src/dmu/hvli/trunk`。

## 变更视图

变更文件以目录树形式展示，而不是平铺列表。点击文件后，会打开远程 `HEAD` 与远程工作区当前文件内容的左右对比。

## 刷新行为

- 插件会长期保存连接配置，并在需要时自动重连。
- 当 VS Code 重新获得焦点，或 `远程 Git Diff` 视图重新显示时，可自动刷新。
- 默认始终优先打开左右对比。
- 如果你希望超大文件改为打开 patch 文本，可启用 `remoteGitDiff.openPatchOnLargeDiff`。
- 默认会将当前工作区的 `diffEditor.maxComputationTime` 设为 `0`，避免出现“差异算法已提前停止(在 5000 ms 之后)”提示。

## 构建

```bash
npm install
npm run build
```

在 VS Code 中按 `F5` 即可启动扩展调试宿主。
