import * as fs from 'fs';
import * as path from 'path';

export interface FileContext {
  primary: { filePath: string; content: string };
  dependencies: { filePath: string; content: string }[];
}

export function buildContext(activeFilePath: string, workspaceRoot: string): FileContext {
  let primaryContent: string;
  try {
    primaryContent = fs.readFileSync(activeFilePath, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read file "${activeFilePath}": ${(err as Error).message}`);
  }
  const dependencies = resolveDependencies(activeFilePath, primaryContent, workspaceRoot);
  return { primary: { filePath: activeFilePath, content: primaryContent }, dependencies };
}

function resolveDependencies(
  filePath: string,
  content: string,
  workspaceRoot: string
): { filePath: string; content: string }[] {
  const deps: { filePath: string; content: string }[] = [];
  const fileDir = path.dirname(filePath);
  const fileName = path.basename(filePath, path.extname(filePath));

  // For *Impl.java → look for the interface in the same package
  if (fileName.endsWith('Impl')) {
    const interfaceName = fileName.replace(/Impl$/, '');
    const interfacePath = path.join(fileDir, `${interfaceName}.java`);
    if (fs.existsSync(interfacePath)) {
      try {
        deps.push({ filePath: interfacePath, content: fs.readFileSync(interfacePath, 'utf8') });
      } catch (err) { console.warn('[Docs Agent] Cannot read dependency:', interfacePath, err); }
    }
  }

  // Resolve same-project imports (DTOs, enums, models)
  const importPattern = /import\s+(com\.example\.\S+);/g;
  let match: RegExpExecArray | null;

  while ((match = importPattern.exec(content)) !== null) {
    const fqn = match[1];
    const relativePath = fqn.replace(/\./g, '/') + '.java';
    const candidate = path.join(workspaceRoot, 'src/main/java', relativePath);

    if (fs.existsSync(candidate) && candidate !== filePath && !deps.find(d => d.filePath === candidate)) {
      try {
        deps.push({ filePath: candidate, content: fs.readFileSync(candidate, 'utf8') });
      } catch (err) { console.warn('[Docs Agent] Cannot read dependency:', candidate, err); }
    }
  }

  return deps;
}

function formatSection(filePath: string, content: string): string {
  return `// FILE: ${filePath}\n<source_code>\n${content}\n</source_code>`;
}

export function formatContextBundle(ctx: FileContext): string {
  const sections: string[] = [];

  sections.push(formatSection(ctx.primary.filePath, ctx.primary.content));

  for (const dep of ctx.dependencies) {
    sections.push(formatSection(dep.filePath, dep.content));
  }

  return sections.join('\n\n// ---\n\n');
}
