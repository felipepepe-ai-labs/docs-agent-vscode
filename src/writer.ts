import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export function getDocsFolder(): string {
  const cfg = vscode.workspace.getConfiguration('docsAgent');
  return cfg.get<string>('docsFolder', 'docs');
}

export function writeDoc(
  content: string,
  sourceFilePath: string,
  workspaceRoot: string
): string {
  const docsFolder = getDocsFolder();
  const relative = path.relative(workspaceRoot, sourceFilePath);
  const outputPath = path.join(workspaceRoot, docsFolder, `${relative}.md`);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, content, 'utf8');

  return outputPath;
}

export async function openDoc(outputPath: string): Promise<void> {
  const uri = vscode.Uri.file(outputPath);
  await vscode.commands.executeCommand('markdown.showPreviewToSide', uri);
}
