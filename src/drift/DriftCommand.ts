import * as vscode from 'vscode';
import { SnapshotExtractor } from './SnapshotExtractor';
import { EmbeddingService } from './EmbeddingService';
import { DriftAnalyzer } from './DriftAnalyzer';
import { DriftTimelinePanel } from './DriftTimelinePanel';
import { SemanticBlameService } from '../SemanticBlameService';

export class DriftCommand {
  private snapshotExtractor: SnapshotExtractor;
  private embeddingService: EmbeddingService;
  private driftAnalyzer: DriftAnalyzer;

  /**
   * Creates an instance of DriftCommand.
   * @param context The extension context.
   * @param semanticBlameService The semantic blame service.
   */
  constructor(
    private context: vscode.ExtensionContext,
    private semanticBlameService: SemanticBlameService
  ) {
    this.snapshotExtractor = new SnapshotExtractor();
    this.embeddingService = new EmbeddingService(
      this.semanticBlameService.client,
      this.semanticBlameService.cache
    );
    this.driftAnalyzer = new DriftAnalyzer(this.embeddingService, this.semanticBlameService.client);
  }

  public async register() {
    const command = vscode.commands.registerCommand('blameLens.showDriftTimeline', async () => {
      try {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const filePath = editor.document.uri.fsPath;
        const gitService = this.semanticBlameService.gitService;
        const blameHunk = await gitService.blame(filePath, editor.selection.active.line + 1);
        if (!blameHunk) {
          vscode.window.showErrorMessage('Drift Timeline only works for files inside a Git repository.');
          return;
        }

        const position = editor.selection.active;
        const functionName = await this.extractFunctionNameAtCursor(editor, position);

        if (!functionName) {
          vscode.window.showWarningMessage('Place your cursor inside a function first.');
          return;
        }

        await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: `Building drift timeline for ${functionName}…`,
          cancellable: false
        }, async (progress) => {
          progress.report({ message: 'Extracting snapshots…' });
          const snapshots = await this.snapshotExtractor.extract(filePath, functionName);

          if (snapshots.length < 3) {
            vscode.window.showInformationMessage(`Not enough history for ${functionName} (need at least 3 commits).`);
            return;
          }

          progress.report({ message: `Embedding ${snapshots.length} snapshots…`, increment: 30 });
          
          // Create the panel early to stream points
          const panel = DriftTimelinePanel.createOrShow(this.context.extensionUri, functionName, filePath, this.semanticBlameService);
          
          const analysis = await this.driftAnalyzer.analyze(snapshots, functionName, (point) => {
            panel.addPoint(point);
          });

          progress.report({ message: 'Rendering timeline…', increment: 60 });
          panel.update(analysis);
        });
      } catch (error: any) {
        vscode.window.showErrorMessage(`Drift Timeline failed: ${error.message}`);
      }
    });

    this.context.subscriptions.push(command);
  }

  private async extractFunctionNameAtCursor(editor: vscode.TextEditor, position: vscode.Position): Promise<string | null> {
    const document = editor.document;
    
    // Walk upward to find function declaration - increased range to 100 lines
    const functionRegex = /(function\s+(\w+)|(\w+)\s*[:=]\s*(async\s+)?function|(\w+)\s*\(.*\)\s*\{|class\s+(\w+)|interface\s+(\w+))/;
    
    for (let i = position.line; i >= Math.max(0, position.line - 100); i--) {
      const lineText = document.lineAt(i).text;
      const match = lineText.match(functionRegex);
      if (match) {
        // match[2] for function name, match[3] for property name, match[5] for method name, match[6] for class, match[7] for interface
        return match[2] || match[3] || match[5] || match[6] || match[7] || null;
      }
    }

    return null;
  }
}
