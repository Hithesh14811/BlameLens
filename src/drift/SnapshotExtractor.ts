import { exec } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import * as path from 'path';

const execAsync = promisify(exec);

export interface FunctionSnapshot {
  sha: string;
  date: string;          // ISO 8601
  author: string;
  commitMessage: string;
  sourceCode: string;    // full function body at this commit
  linesAdded: number;
  linesRemoved: number;
}

export class SnapshotExtractor {
  private getCwd(): string | null {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return null;
    }
    return workspaceFolders[0].uri.fsPath;
  }

  public async extract(filePath: string, functionName: string): Promise<FunctionSnapshot[]> {
    const cwd = this.getCwd();
    if (!cwd) return [];

    try {
      // 1. Get all commits that touched the file
      const logCommand = `git log --follow --format="%H|%ai|%an|%s" -- "${filePath}"`;
      const { stdout: logOutput } = await execAsync(logCommand, { cwd });
      const logLines = logOutput.split('\n').filter(line => line.trim() !== '');

      // 2. Sample if more than 50 commits
      let sampledLines = logLines;
      if (logLines.length > 50) {
        const step = logLines.length / 50;
        sampledLines = [];
        for (let i = 0; i < 50; i++) {
          sampledLines.push(logLines[Math.floor(i * step)]);
        }
      }

      const snapshots: FunctionSnapshot[] = [];

      for (const line of sampledLines) {
        const [sha, date, author, subject] = line.split('|');
        if (!sha) continue;

        try {
          // 3. Get the full file at this snapshot
          const showFileCommand = `git show ${sha}:"${filePath}"`;
          const { stdout: fileContent } = await execAsync(showFileCommand, { cwd });

          // 4. Extract function body using brace-depth parser
          const sourceCode = this.extractFunction(fileContent, functionName);
          if (!sourceCode) continue;

          // 5. Get linesAdded/linesRemoved
          const statCommand = `git show --stat --format="" ${sha} -- "${filePath}"`;
          const { stdout: statOutput } = await execAsync(statCommand, { cwd });
          const statMatch = statOutput.match(/(\d+) insertion[s]?\(\+\), (\d+) deletion[s]?\(-\)/);
          const linesAdded = statMatch ? parseInt(statMatch[1], 10) : 0;
          const linesRemoved = statMatch ? parseInt(statMatch[2], 10) : 0;

          snapshots.push({
            sha,
            date,
            author,
            commitMessage: subject,
            sourceCode,
            linesAdded,
            linesRemoved
          });
        } catch (error) {
          console.error(`Error processing snapshot ${sha}:`, error);
        }
      }

      return snapshots;
    } catch (error) {
      console.error('Error in SnapshotExtractor:', error);
      return [];
    }
  }

  private extractFunction(content: string, functionName: string): string | null {
    const lines = content.split('\n');
    // Regex for function/method/class/interface declaration
    const functionRegex = new RegExp(`(function\\s+${functionName}|${functionName}\\s*[:=]\\s*(async\\s+)?function|${functionName}\\s*\\(.*\\)\\s*\\{|class\\s+${functionName}|interface\\s+${functionName})`);
    
    let startIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (functionRegex.test(lines[i])) {
        startIndex = i;
        break;
      }
    }

    if (startIndex === -1) return null;

    let braceCount = 0;
    let started = false;
    const resultLines: string[] = [];

    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i];
      resultLines.push(line);

      for (const char of line) {
        if (char === '{') {
          braceCount++;
          started = true;
        } else if (char === '}') {
          braceCount--;
        }
      }

      if (started && braceCount === 0) {
        return resultLines.join('\n');
      }
    }

    return null;
  }
}
