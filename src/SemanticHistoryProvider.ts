
import * as vscode from 'vscode';
import { SemanticBlameService } from './SemanticBlameService';

export class SemanticHistoryProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

  constructor(private readonly semanticBlameService: SemanticBlameService) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Update view when selection changes
    vscode.window.onDidChangeTextEditorSelection((e) => {
      this.update(e.textEditor);
    });

    if (vscode.window.activeTextEditor) {
      this.update(vscode.window.activeTextEditor);
    }
  }

  public async update(editor: vscode.TextEditor) {
    if (!this._view) { return; }

    const position = editor.selection.active;
    const line = position.line;
    const fileName = editor.document.fileName;

    this._view.webview.postMessage({ type: 'loading' });

    const annotation = await this.semanticBlameService.getSemanticBlame(fileName, line);
    if (annotation) {
      this._view.webview.postMessage({
        type: 'update',
        data: annotation
      });
    } else {
      this._view.webview.postMessage({ type: 'empty' });
    }
  }

  private _getHtmlForWebview(_webview: vscode.Webview) {
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 10px; }
          .card { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 12px; margin-bottom: 12px; }
          .title { font-weight: bold; font-size: 1.1em; color: var(--vscode-symbolIcon-functionForeground); margin-bottom: 8px; }
          .intent { color: var(--vscode-descriptionForeground); margin-bottom: 8px; font-size: 0.9em; }
          .label { font-size: 0.8em; text-transform: uppercase; opacity: 0.7; margin-top: 12px; }
          .value { font-size: 0.9em; margin-bottom: 8px; }
          .confidence-bar { height: 4px; background: var(--vscode-editor-lineHighlightBackground); border-radius: 2px; margin-top: 4px; }
          .confidence-fill { height: 100%; background: var(--vscode-charts-green); border-radius: 2px; }
          .loading { opacity: 0.5; font-style: italic; }
        </style>
      </head>
      <body>
        <div id="content">
          <div class="loading">Select a line to see its semantic story...</div>
        </div>
        <script>
          const vscode = acquireVsCodeApi();
          const content = document.getElementById('content');

          window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
              case 'loading':
                content.innerHTML = '<div class="loading">Analyzing history...</div>';
                break;
              case 'update':
                const d = message.data;
                content.innerHTML = \`
                  <div class="card">
                    <div class="title">\${d.one_liner}</div>
                    <div class="intent">\${d.intent}</div>
                    
                    <div class="label">The Trigger</div>
                    <div class="value">\${d.trigger}</div>
                    
                    <div class="label">The Risk</div>
                    <div class="value">\${d.risk || 'No significant risk identified.'}</div>
                    
                    <div class="label">Confidence Score: \${Math.round(d.confidence * 100)}%</div>
                    <div class="confidence-bar">
                      <div class="confidence-fill" style="width: \${d.confidence * 100}%"></div>
                    </div>
                  </div>
                \`;
                break;
              case 'empty':
                content.innerHTML = '<div class="loading">No semantic data found for this line.</div>';
                break;
            }
          });
        </script>
      </body>
      </html>
    `;
  }
}
