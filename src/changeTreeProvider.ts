import * as vscode from "vscode";
import { RemoteGitChange } from "./types";

function toResourceUri(relativePath: string | undefined, isFolder: boolean): vscode.Uri | undefined {
  if (!relativePath) {
    return undefined;
  }
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const suffix = isFolder ? "/" : "";
  return vscode.Uri.file(`/${normalized}${suffix}`);
}

function getChangeStatusLabel(change: RemoteGitChange): string {
  switch (change.code) {
    case "M":
      return "已修改";
    case "A":
      return "已新增";
    case "D":
      return "已删除";
    case "R":
      return "已重命名";
    case "C":
      return "已复制";
    case "U":
      return "有冲突";
    default:
      return "已变更";
  }
}

type TreeNode = FolderNode | ChangeNode;

interface FolderNode {
  type: "folder";
  path: string;
  name: string;
  children: TreeNode[];
}

interface ChangeNode {
  type: "change";
  change: RemoteGitChange;
}

export class ChangeItem extends vscode.TreeItem {
  public constructor(public readonly change: RemoteGitChange) {
    const parts = change.path.split("/");
    super(parts[parts.length - 1], vscode.TreeItemCollapsibleState.None);
    this.tooltip = change.originalPath
      ? `${change.originalPath} -> ${change.path}\n状态：${getChangeStatusLabel(change)}`
      : `${change.path}\n状态：${getChangeStatusLabel(change)}`;
    this.contextValue = "remoteGitDiff.change";
    this.resourceUri = toResourceUri(change.path, false);
    this.command = {
      command: "remoteGitDiff.openDiff",
      title: "打开差异对比",
      arguments: [change]
    };
  }
}

export class FolderItem extends vscode.TreeItem {
  public constructor(public readonly node: FolderNode) {
    super(node.name, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "remoteGitDiff.folder";
    this.tooltip = node.path;
    this.resourceUri = toResourceUri(node.path, true);
  }
}

export class ChangeTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  private rootNodes: TreeNode[] = [];

  public readonly onDidChangeTreeData = this.emitter.event;

  public setChanges(changes: RemoteGitChange[]): void {
    this.rootNodes = this.buildTree([...changes].sort((left, right) => left.path.localeCompare(right.path)));
    this.emitter.fire();
  }

  public clear(): void {
    this.rootNodes = [];
    this.emitter.fire();
  }

  public getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    const nodes = element instanceof FolderItem
      ? element.node.children
      : this.rootNodes;
    return nodes.map((node) => node.type === "folder" ? new FolderItem(node) : new ChangeItem(node.change));
  }

  private buildTree(changes: RemoteGitChange[]): TreeNode[] {
    const roots: FolderNode[] = [];

    for (const change of changes) {
      const parts = change.path.split("/");
      const fileName = parts.pop();
      if (!fileName) {
        continue;
      }

      let children = roots as TreeNode[];
      let currentPath = "";

      for (const part of parts) {
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        let folder = children.find(
          (node): node is FolderNode => node.type === "folder" && node.name === part
        );
        if (!folder) {
          folder = {
            type: "folder",
            path: currentPath,
            name: part,
            children: []
          };
          children.push(folder);
        }
        children = folder.children;
      }

      children.push({
        type: "change",
        change
      });
    }

    return roots;
  }
}
