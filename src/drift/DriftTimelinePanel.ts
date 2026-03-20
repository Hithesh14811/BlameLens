import * as vscode from 'vscode';
import { DriftAnalysis, DriftPoint } from './DriftAnalyzer';
import { SemanticBlameService } from '../SemanticBlameService';

export class DriftTimelinePanel {
  public static currentPanel: DriftTimelinePanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri, functionName: string, filePath: string, semanticBlameService: SemanticBlameService) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (DriftTimelinePanel.currentPanel) {
      DriftTimelinePanel.currentPanel._panel.reveal(column);
      DriftTimelinePanel.currentPanel._panel.title = `Drift timeline — ${functionName}`;
      return DriftTimelinePanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      'driftTimeline',
      `Drift timeline — ${functionName}`,
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri]
      }
    );

    DriftTimelinePanel.currentPanel = new DriftTimelinePanel(panel, extensionUri, functionName, filePath, semanticBlameService);
    return DriftTimelinePanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel, 
    extensionUri: vscode.Uri, 
    private functionName: string, 
    private filePath: string,
    private semanticBlameService: SemanticBlameService
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;

    // Set full HTML immediately so it can receive messages
    this._panel.webview.html = this._getHtmlForWebview();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.type) {
          case 'getAnnotation':
            const annotation = await this.semanticBlameService.getSemanticBlame(this.filePath, message.line || 0);
            this._panel.webview.postMessage({ type: 'annotation', data: annotation, sha: message.sha });
            break;
          case 'openDiff':
            vscode.commands.executeCommand('vscode.diff', 
              vscode.Uri.parse(`git-show:${message.sha}^:${this.filePath}`),
              vscode.Uri.parse(`git-show:${message.sha}:${this.filePath}`),
              `Diff: ${message.sha.substring(0, 7)}`
            );
            break;
        }
      },
      null,
      this._disposables
    );
  }

  public update(analysis: DriftAnalysis) {
    this._panel.webview.postMessage({ type: 'updateAnalysis', data: analysis });
  }

  public addPoint(point: DriftPoint) {
    this._panel.webview.postMessage({ type: 'addPoint', data: point });
  }

  public dispose() {
    DriftTimelinePanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }

  private _getHtmlForWebview() {
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body {
            font-family: system-ui, -apple-system, sans-serif;
            color: var(--vscode-editor-foreground);
            background: var(--vscode-editor-background);
            padding: 20px;
            margin: 0;
          }
          #loading-overlay {
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: var(--vscode-editor-background);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1000;
            font-style: italic;
            opacity: 0.7;
          }
          #content { display: none; }
          #content.visible { display: block; }
          code { font-family: var(--vscode-editor-font-family); }
          .summary-bar {
            background: var(--vscode-editor-lineHighlightBackground);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 16px;
            margin-bottom: 24px;
          }
          .summary-line { margin-bottom: 8px; font-size: 0.95em; }
          .summary-label { opacity: 0.7; font-size: 0.85em; text-transform: uppercase; margin-right: 8px; }
          .summary-stats { font-weight: bold; color: var(--vscode-textLink-foreground); }
          
          #canvas-container {
            width: 100%;
            height: 400px;
            position: relative;
            margin-bottom: 24px;
            overflow: hidden;
          }
          canvas {
            width: 100%;
            height: 100%;
            cursor: crosshair;
          }
          
          .commit-card {
            background: var(--vscode-editor-lineHighlightBackground);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 16px;
            display: none;
            animation: slideUp 0.2s ease-out;
          }
          @keyframes slideUp {
            from { transform: translateY(10px); opacity: 0; }
            to { transform: translateY(0); opacity: 1; }
          }
          .card-header { display: flex; justify-content: space-between; margin-bottom: 12px; }
          .card-sha { font-family: var(--vscode-editor-font-family); opacity: 0.7; }
          .card-author { font-weight: bold; }
          .card-message { margin-bottom: 12px; font-style: italic; }
          .card-drift { font-weight: bold; margin-bottom: 8px; }
          .rupture-tag { color: var(--vscode-charts-red); font-weight: bold; }
          .card-stats { opacity: 0.7; font-size: 0.9em; margin-bottom: 16px; }
          .card-actions { display: flex; gap: 12px; }
          button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 6px 12px;
            border-radius: 2px;
            cursor: pointer;
          }
          button:hover { background: var(--vscode-button-hoverBackground); }
          
          .annotation-result {
            margin-top: 12px;
            padding: 12px;
            background: var(--vscode-editor-background);
            border-left: 3px solid var(--vscode-textLink-foreground);
            font-size: 0.9em;
          }
        </style>
      </head>
      <body>
        <div id="loading-overlay">Analyzing history and building drift timeline...</div>
        
        <div id="content">
          <div class="summary-bar">
            <div class="summary-line"><span class="summary-label">Originally:</span> <span id="originalIdentity">...</span></div>
            <div class="summary-line"><span class="summary-label">Now:</span> <span id="currentIdentity">...</span></div>
            <div class="summary-line">
              Total drift: <span id="totalDrift" class="summary-stats">0</span> across 
              <span id="commitCount" class="summary-stats">0</span> commits 
              [<span id="ruptureCount" class="summary-stats">0</span> ruptures]
            </div>
          </div>

          <div id="canvas-container">
            <canvas id="driftCanvas"></canvas>
          </div>

          <div id="commitCard" class="commit-card">
            <div class="card-header">
              <span id="cardSha" class="card-sha"></span>
              <span id="cardAuthor" class="card-author"></span>
              <span id="cardDate" class="card-date"></span>
            </div>
            <div id="cardMessage" class="card-message"></div>
            <div id="cardDrift" class="card-drift"></div>
            <div id="cardStats" class="card-stats"></div>
            <div class="card-actions">
              <button onclick="openDiff()">Show source diff</button>
              <button onclick="getAnnotation()">Show semantic annotation</button>
            </div>
            <div id="annotationResult" class="annotation-result" style="display:none"></div>
          </div>
        </div>

        <script>
          const vscode = acquireVsCodeApi();
          let points = [];
          const canvas = document.getElementById('driftCanvas');
          const ctx = canvas.getContext('2d');
          const card = document.getElementById('commitCard');
          const content = document.getElementById('content');
          const overlay = document.getElementById('loading-overlay');
          
          let selectedPoint = null;
          let hoverPoint = null;

          window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
              case 'addPoint':
                points.push(message.data);
                if (points.length === 1) {
                  overlay.style.display = 'none';
                  content.classList.add('visible');
                  initCanvas();
                }
                draw();
                break;
              case 'updateAnalysis':
                const analysis = message.data;
                document.getElementById('originalIdentity').textContent = analysis.originalIdentity;
                document.getElementById('currentIdentity').textContent = analysis.currentIdentity;
                document.getElementById('totalDrift').textContent = analysis.totalDrift.toFixed(2);
                document.getElementById('commitCount').textContent = analysis.points.length;
                document.getElementById('ruptureCount').textContent = analysis.ruptureCount;
                points = analysis.points;
                draw();
                break;
              case 'annotation':
                if (selectedPoint && message.sha === selectedPoint.snapshot.sha) {
                  const d = message.data;
                  if (d) {
                    document.getElementById('annotationResult').innerHTML = \`
                      <div style="font-weight:bold;margin-bottom:4px">\${d.one_liner}</div>
                      <div>\${d.intent}</div>
                    \`;
                  } else {
                    document.getElementById('annotationResult').textContent = 'No annotation available for this commit.';
                  }
                }
                break;
            }
          });

          function initCanvas() {
            const container = document.getElementById('canvas-container');
            if (container && container.clientWidth) {
              canvas.width = container.clientWidth;
              canvas.height = container.clientHeight;
              draw();
            }
          }

          function draw() {
            if (points.length === 0 || !canvas.width) return;
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            
            const padding = 40;
            const w = canvas.width - padding * 2;
            const h = canvas.height - padding * 2;
            
            const maxDrift = Math.max(...points.map(p => p.cumulativeDrift), 1);
            
            // Draw axes
            ctx.strokeStyle = 'rgba(128, 128, 128, 0.3)';
            ctx.beginPath();
            ctx.moveTo(padding, padding);
            ctx.lineTo(padding, canvas.height - padding);
            ctx.lineTo(canvas.width - padding, canvas.height - padding);
            ctx.stroke();

            // Draw line
            ctx.strokeStyle = 'var(--vscode-textLink-foreground)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            points.forEach((p, i) => {
              const x = padding + (i / Math.max(1, points.length - 1)) * w;
              const y = canvas.height - padding - (p.cumulativeDrift / maxDrift) * h;
              if (i === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            });
            ctx.stroke();

            // Draw points
            points.forEach((p, i) => {
              const x = padding + (i / Math.max(1, points.length - 1)) * w;
              const y = canvas.height - padding - (p.cumulativeDrift / maxDrift) * h;
              
              const linesChanged = p.snapshot.linesAdded + p.snapshot.linesRemoved;
              const radius = Math.max(4, Math.min(12, 4 + linesChanged / 10));
              
              let color = 'var(--vscode-charts-green)';
              if (p.driftScore > 0.35) color = 'var(--vscode-charts-red)';
              else if (p.driftScore > 0.1) color = 'var(--vscode-charts-yellow)';
              
              ctx.fillStyle = color;
              ctx.beginPath();
              ctx.arc(x, y, radius, 0, Math.PI * 2);
              ctx.fill();

              if (p.isRupture) {
                ctx.strokeStyle = color;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.arc(x, y, radius + 4, 0, Math.PI * 2);
                ctx.stroke();
              }

              if (p === selectedPoint) {
                ctx.strokeStyle = 'var(--vscode-editor-foreground)';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(x, y, radius + 6, 0, Math.PI * 2);
                ctx.stroke();
              }
            });
          }

          canvas.addEventListener('mousemove', (e) => {
            if (points.length === 0) return;
            const rect = canvas.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            
            const padding = 40;
            const w = canvas.width - padding * 2;
            const h = canvas.height - padding * 2;
            const maxDrift = Math.max(...points.map(p => p.cumulativeDrift), 1);

            let found = null;
            points.forEach((p, i) => {
              const x = padding + (i / Math.max(1, points.length - 1)) * w;
              const y = canvas.height - padding - (p.cumulativeDrift / maxDrift) * h;
              const dist = Math.sqrt((x - mouseX)**2 + (y - mouseY)**2);
              if (dist < 15) found = p;
            });

            if (found !== hoverPoint) {
              hoverPoint = found;
              canvas.style.cursor = hoverPoint ? 'pointer' : 'crosshair';
              draw();
            }
          });

          canvas.addEventListener('click', () => {
            if (hoverPoint) {
              selectedPoint = hoverPoint;
              showCard(selectedPoint);
              draw();
            }
          });

          function showCard(p) {
            card.style.display = 'block';
            document.getElementById('cardSha').textContent = p.snapshot.sha.substring(0, 7);
            document.getElementById('cardAuthor').textContent = p.snapshot.author;
            document.getElementById('cardDate').textContent = p.snapshot.date;
            document.getElementById('cardMessage').textContent = p.snapshot.commitMessage;
            
            let driftText = 'Drift from previous: ' + p.driftScore.toFixed(2);
            if (p.isRupture) driftText += ' <span class="rupture-tag">[RUPTURE]</span>';
            document.getElementById('cardDrift').innerHTML = driftText;
            
            document.getElementById('cardStats').textContent = '+' + p.snapshot.linesAdded + ' / -' + p.snapshot.linesRemoved + ' lines';
            document.getElementById('annotationResult').style.display = 'none';
          }

          function openDiff() {
            if (selectedPoint) {
              vscode.postMessage({ type: 'openDiff', sha: selectedPoint.snapshot.sha });
            }
          }

          function getAnnotation() {
            if (selectedPoint) {
              document.getElementById('annotationResult').style.display = 'block';
              document.getElementById('annotationResult').textContent = 'Analyzing commit...';
              vscode.postMessage({ 
                type: 'getAnnotation', 
                sha: selectedPoint.snapshot.sha
              });
            }
          }

          window.addEventListener('resize', initCanvas);
          setTimeout(initCanvas, 100);
        </script>
      </body>
      </html>
    `;
  }
}
