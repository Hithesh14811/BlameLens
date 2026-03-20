
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

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'search':
          const editor = vscode.window.activeTextEditor;
          if (editor) {
            const results = await this.semanticBlameService.searchHistory(editor.document.fileName, message.query);
            webviewView.webview.postMessage({ type: 'searchResults', results });
          }
          break;
        case 'getContributors':
          const activeEditor = vscode.window.activeTextEditor;
          if (activeEditor) {
            const stats = await this.semanticBlameService.getSemanticAuthorImpact(activeEditor.document.fileName);
            webviewView.webview.postMessage({ type: 'contributorStats', stats });
          }
          break;
      }
    });

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
          body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0; margin: 0; }
          .tabs { display: flex; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); position: sticky; top: 0; z-index: 10; }
          .tab { padding: 8px 12px; cursor: pointer; opacity: 0.6; font-size: 0.85em; text-transform: uppercase; }
          .tab.active { opacity: 1; border-bottom: 2px solid var(--vscode-panelTitle-activeBorder); font-weight: bold; }
          .content-section { padding: 10px; display: none; }
          .content-section.active { display: block; }
          
          .card { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 12px; margin-bottom: 12px; }
          .title { font-weight: bold; font-size: 1.1em; color: var(--vscode-symbolIcon-functionForeground); margin-bottom: 8px; }
          .intent { color: var(--vscode-descriptionForeground); margin-bottom: 8px; font-size: 0.9em; }
          .label { font-size: 0.8em; text-transform: uppercase; opacity: 0.7; margin-top: 12px; }
          .value { font-size: 0.9em; margin-bottom: 8px; }
          .confidence-bar { height: 4px; background: var(--vscode-editor-lineHighlightBackground); border-radius: 2px; margin-top: 4px; }
          .confidence-fill { height: 100%; background: var(--vscode-charts-green); border-radius: 2px; }
          
          .search-box { display: flex; gap: 8px; margin-bottom: 16px; }
          input { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 4px 8px; flex: 1; border-radius: 2px; }
          button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 12px; cursor: pointer; border-radius: 2px; }
          
          .result-item { padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); cursor: pointer; }
          .result-item:hover { background: var(--vscode-list-hoverBackground); }
          .result-sha { font-family: var(--vscode-editor-font-family); font-size: 0.8em; opacity: 0.5; }
          .result-msg { font-size: 0.9em; margin: 4px 0; }
          .relevance-tag { font-size: 0.75em; padding: 2px 4px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 2px; }
          
          .contributor-item { margin-bottom: 16px; }
          .contributor-header { display: flex; justify-content: space-between; align-items: baseline; }
          .contributor-name { font-weight: bold; color: var(--vscode-textLink-foreground); }
          .contributor-persona { font-size: 0.8em; font-style: italic; opacity: 0.8; }
          .impact-bar-bg { height: 8px; background: var(--vscode-editor-lineHighlightBackground); border-radius: 4px; margin: 6px 0; overflow: hidden; }
          .impact-bar-fill { height: 100%; background: linear-gradient(90deg, var(--vscode-charts-blue), var(--vscode-charts-purple)); }
          .contributor-stats { font-size: 0.8em; opacity: 0.6; }
          
          .loading { opacity: 0.5; font-style: italic; padding: 10px; }
        </style>
      </head>
      <body>
        <div class="tabs">
          <div class="tab active" onclick="showTab('line')">Line</div>
          <div class="tab" onclick="showTab('search')">Search</div>
          <div class="tab" onclick="showTab('authors')">Authors</div>
        </div>

        <div id="line-section" class="content-section active">
          <div id="line-content">
            <div class="loading">Select a line to see its semantic story...</div>
          </div>
        </div>

        <div id="search-section" class="content-section">
          <div class="search-box">
            <input type="text" id="search-input" placeholder="Natural language search (e.g. 'auth fix')">
            <button onclick="doSearch()">Search</button>
          </div>
          <div id="search-results"></div>
        </div>

        <div id="authors-section" class="content-section">
          <div id="authors-content">
            <button onclick="refreshAuthors()" style="width: 100%">Calculate Semantic Impact</button>
          </div>
        </div>

        <script>
          const vscode = acquireVsCodeApi();
          const lineContent = document.getElementById('line-content');
          const searchResults = document.getElementById('search-results');
          const authorsContent = document.getElementById('authors-content');

          function showTab(tabId) {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.content-section').forEach(s => s.classList.remove('active'));
            
            event.target.classList.add('active');
            document.getElementById(tabId + '-section').classList.add('active');
            
            if (tabId === 'authors' && authorsContent.children.length <= 1) {
              refreshAuthors();
            }
          }

          function doSearch() {
            const query = document.getElementById('search-input').value;
            if (!query) return;
            searchResults.innerHTML = '<div class="loading">Searching history...</div>';
            vscode.postMessage({ type: 'search', query });
          }

          function refreshAuthors() {
            authorsContent.innerHTML = '<div class="loading">Analyzing author impact...</div>';
            vscode.postMessage({ type: 'getContributors' });
          }

          window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
              case 'loading':
                lineContent.innerHTML = '<div class="loading">Analyzing history...</div>';
                break;
              case 'update':
                const d = message.data;
                lineContent.innerHTML = \`
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
                lineContent.innerHTML = '<div class="loading">No semantic data found for this line.</div>';
                break;
              case 'searchResults':
                if (message.results.length === 0) {
                  searchResults.innerHTML = '<div class="loading">No relevant commits found.</div>';
                } else {
                  searchResults.innerHTML = message.results.map(r => \`
                    <div class="result-item">
                      <div class="contributor-header">
                        <span class="result-sha">\${r.sha.substring(0, 7)}</span>
                        <span class="relevance-tag">Relevance: \${Math.round(r.relevance * 100)}%</span>
                      </div>
                      <div class="result-msg">\${r.message}</div>
                    </div>
                  \`).join('');
                }
                break;
              case 'contributorStats':
                authorsContent.innerHTML = \`
                  <button onclick="refreshAuthors()" style="width: 100%; margin-bottom: 16px;">Refresh Analysis</button>
                  \${message.stats.map(s => \`
                    <div class="contributor-item">
                      <div class="contributor-header">
                        <span class="contributor-name">\${s.name}</span>
                        <span class="contributor-persona">\${s.persona}</span>
                      </div>
                      <div class="impact-bar-bg">
                        <div class="impact-bar-fill" style="width: \${s.impactScore}%"></div>
                      </div>
                      <div class="intent" style="font-size: 0.85em; margin-bottom: 4px;">\${s.summary}</div>
                      <div class="contributor-stats">
                        \${s.commits} commits · +\${s.added}/-\${s.removed} lines · Impact: \${s.impactScore}%
                      </div>
                    </div>
                  \`).join('')}
                \`;
                break;
            }
          });
        </script>
      </body>
      </html>
    `;
  }
}
