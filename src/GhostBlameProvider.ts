
import * as vscode from 'vscode';
import { SemanticBlameService } from './SemanticBlameService';

export class GhostBlameProvider {
  private decorationType: vscode.TextEditorDecorationType;
  private disposables: vscode.Disposable[] = [];
  private currentTimeout: NodeJS.Timeout | undefined;

  constructor(private semanticBlameService: SemanticBlameService) {
    this.decorationType = vscode.window.createTextEditorDecorationType({
      after: {
        margin: '0 0 0 3em',
        color: new vscode.ThemeColor('editorCodeLens.foreground'),
        fontStyle: 'italic',
      },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
    });

    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((e) => this.onSelectionChange(e)),
      vscode.window.onDidChangeActiveTextEditor((e) => this.onActiveEditorChange(e))
    );

    if (vscode.window.activeTextEditor) {
      this.update(vscode.window.activeTextEditor);
    }
  }

  private onSelectionChange(e: vscode.TextEditorSelectionChangeEvent) {
    if (e.selections.length > 0) {
      this.update(e.textEditor);
    }
  }

  private onActiveEditorChange(editor: vscode.TextEditor | undefined) {
    if (editor) {
      this.update(editor);
    }
  }

  private update(editor: vscode.TextEditor) {
    if (this.currentTimeout) {
      clearTimeout(this.currentTimeout);
    }

    // Clear previous decoration immediately
    editor.setDecorations(this.decorationType, []);

    this.currentTimeout = setTimeout(async () => {
      const position = editor.selection.active;
      const line = position.line;
      const fileName = editor.document.fileName;

      if (!this.semanticBlameService.hasApiKey()) {
        return;
      }

      const annotation = await this.semanticBlameService.getSemanticBlame(fileName, line);
      if (annotation && editor === vscode.window.activeTextEditor && editor.selection.active.line === line) {
        const range = new vscode.Range(line, editor.document.lineAt(line).text.length, line, editor.document.lineAt(line).text.length);
        
        const decoration: vscode.DecorationOptions = {
          range,
          renderOptions: {
            after: {
              contentText: `$(git-commit) ${annotation.one_liner}`,
            },
          },
        };

        editor.setDecorations(this.decorationType, [decoration]);
      }
    }, 500); // 500ms debounce for gold-standard smoothness
  }

  public dispose() {
    this.disposables.forEach((d) => d.dispose());
    this.decorationType.dispose();
  }
}
