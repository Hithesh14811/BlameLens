
import { exec } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { BlameHunk, CommitContext } from './types';

const execAsync = promisify(exec);

export class GitService {
  private getCwd(): string | null {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return null;
    }
    return workspaceFolders[0].uri.fsPath;
  }

  public async blame(file: string, line: number): Promise<BlameHunk | null> {
    const cwd = this.getCwd();
    if (!cwd) {
      return null;
    }

    try {
      const command = `git blame -L ${line},${line} --porcelain -- "${file}"`;
      const { stdout } = await execAsync(command, { cwd });
      
      const lines = stdout.split('\n');
      if (lines.length === 0) {
        return null;
      }

      const [sha, originalLineStr, finalLineStr, numLinesStr] = lines[0].split(' ');

      if (!sha || sha.length !== 40) {
        return null;
      }
      
      const startLine = parseInt(finalLineStr, 10);
      const numLines = parseInt(numLinesStr, 10);

      return {
        sha,
        startLine,
        endLine: startLine + numLines - 1,
      };
    } catch (error) {
      return null;
    }
  }

  public async getCommitContext(sha: string): Promise<CommitContext | null> {
    const cwd = this.getCwd();
    if (!cwd) {
      return null;
    }

    try {
      const command = `git show --quiet --format=%H%n%an%n%ai%n%s%n%b ${sha}`;
      const { stdout } = await execAsync(command, { cwd });
      const parts = stdout.split('\n');
      const [commitSha, author, date, message, ...body] = parts;

      const diffCommand = `git show ${sha}`;
      const { stdout: diff } = await execAsync(diffCommand, { cwd });

      return {
        sha: commitSha,
        author,
        date,
        message: message + '\n' + body.join('\n'),
        diff,
      };
    } catch (error) {
      return null;
    }
  }

  public async getPriorCommits(file: string, excludeSha: string, count: number = 5): Promise<string> {
    const cwd = this.getCwd();
    if (!cwd) {
      return '';
    }

    try {
      const command = `git log --follow --oneline -${count + 1} -- "${file}"`;
      const { stdout } = await execAsync(command, { cwd });
      const lines = stdout.split('\n').filter(line => line.trim() !== '');
      
      const priorCommits = lines
        .filter(line => !line.startsWith(excludeSha.substring(0, 7)))
        .slice(0, count)
        .join('\n');
        
      return priorCommits || 'No prior commits found.';
    } catch (error) {
      return 'No history available.';
    }
  }

  public async getFullFileHistory(file: string): Promise<{sha: string, message: string, date: string}[]> {
    const cwd = this.getCwd();
    if (!cwd) return [];

    try {
      const command = `git log --follow --format="%H|%s|%ai" -- "${file}"`;
      const { stdout } = await execAsync(command, { cwd });
      return stdout.split('\n').filter(l => l.trim()).map(line => {
        const [sha, message, date] = line.split('|');
        return { sha, message, date };
      });
    } catch (error) {
      return [];
    }
  }

  public async getAuthorStats(file: string): Promise<Record<string, { commits: number, added: number, removed: number }>> {
    const cwd = this.getCwd();
    if (!cwd) return {};

    try {
      // Get all commits for the file with author and stats
      const command = `git log --follow --format="%an" --numstat -- "${file}"`;
      const { stdout } = await execAsync(command, { cwd });
      const stats: Record<string, { commits: number, added: number, removed: number }> = {};
      
      const lines = stdout.split('\n');
      let currentAuthor = '';
      
      for (const line of lines) {
        if (!line.trim()) continue;
        if (line.match(/^\d+\s+\d+\s+/)) {
          // This is a stat line (added removed file)
          const [added, removed] = line.split(/\s+/);
          if (currentAuthor) {
            stats[currentAuthor].added += parseInt(added) || 0;
            stats[currentAuthor].removed += parseInt(removed) || 0;
          }
        } else {
          // This is an author line
          currentAuthor = line.trim();
          if (!stats[currentAuthor]) {
            stats[currentAuthor] = { commits: 0, added: 0, removed: 0 };
          }
          stats[currentAuthor].commits++;
        }
      }
      return stats;
    } catch (error) {
      return {};
    }
  }
}
