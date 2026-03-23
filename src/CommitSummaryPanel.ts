import * as vscode from 'vscode';

export class CommitSummaryPanel {
  public static currentPanel: CommitSummaryPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri, sha: string, summary: string) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (CommitSummaryPanel.currentPanel) {
      CommitSummaryPanel.currentPanel._panel.reveal(column);
      CommitSummaryPanel.currentPanel._update(sha, summary);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'commitSummary',
      `Commit Summary - ${sha.substring(0, 7)}`,
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [extensionUri]
      }
    );

    CommitSummaryPanel.currentPanel = new CommitSummaryPanel(panel, extensionUri, sha, summary);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, sha: string, summary: string) {
    this._panel = panel;
    this._extensionUri = extensionUri;

    this._update(sha, summary);

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  private _update(sha: string, summary: string) {
    this._panel.title = `Commit Summary - ${sha.substring(0, 7)}`;
    this._panel.webview.html = this._getHtmlForWebview(summary);
  }

  public dispose() {
    CommitSummaryPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }

  private _getHtmlForWebview(summary: string) {
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 20px; }
          h1 { font-size: 1.4em; margin-bottom: 16px; }
          p { line-height: 1.6; }
        </style>
      </head>
      <body>
        <h1>Commit Summary</h1>
        <p>${summary.replace(/\n/g, '<br>')}</p>
      </body>
      </html>
    `;
  }
}
