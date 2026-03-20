
import * as vscode from 'vscode';
import { SemanticBlameService } from './SemanticBlameService';
import { CodeLensProvider } from './CodeLensProvider';
import { GhostBlameProvider } from './GhostBlameProvider';
import { SemanticHistoryProvider } from './SemanticHistoryProvider';
import { GitService } from './GitService';
import { DriftCommand } from './drift/DriftCommand';

export function activate(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration('blameLens');
  const apiKey = config.get<string>('apiKey') || '';
  const baseUrl = config.get<string>('baseUrl') || 'https://integrate.api.nvidia.com/v1';
  const model = config.get<string>('model') || 'minimaxai/minimax-m2.5';
  const customInstructions = config.get<string>('customInstructions') || '';

  const gitService = new GitService();
  const semanticBlameService = new SemanticBlameService(apiKey, context, baseUrl, model, gitService);
  semanticBlameService.updateConfig(apiKey, baseUrl, model, customInstructions);
  const ghostBlameProvider = new GhostBlameProvider(semanticBlameService);

  const semanticHistoryProvider = new SemanticHistoryProvider(semanticBlameService);
  const sidePanelView = vscode.window.registerWebviewViewProvider('blameLensHistory', semanticHistoryProvider);

  const driftCommand = new DriftCommand(context, semanticBlameService);
  driftCommand.register();

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(statusBarItem);

  const updateStatusBar = () => {
    if (semanticBlameService.hasApiKey()) {
      statusBarItem.text = `$(git-commit) BlameLens: Active`;
      statusBarItem.tooltip = `Using model: ${semanticBlameService.getModel()}`;
      statusBarItem.command = 'blameLens.openSettings';
      statusBarItem.backgroundColor = undefined;
    } else {
      statusBarItem.text = `$(warning) BlameLens: API Key Missing`;
      statusBarItem.tooltip = 'Click to set your API Key';
      statusBarItem.command = 'blameLens.setApiKey';
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    }
    statusBarItem.show();
  };

  updateStatusBar();

  const openSettingsCommand = vscode.commands.registerCommand('blameLens.openSettings', () => {
    vscode.commands.executeCommand('workbench.action.openSettings', 'blameLens');
  });
  const setApiKeyCommand = vscode.commands.registerCommand('blameLens.setApiKey', async () => {
    const currentConfig = vscode.workspace.getConfiguration('blameLens');
    const currentValue = currentConfig.get<string>('apiKey') || '';
    const nextValue = await vscode.window.showInputBox({
      title: 'BlameLens API Key',
      prompt: 'Enter your provider API key',
      placeHolder: 'nvapi-...',
      password: true,
      value: currentValue
    });
    if (typeof nextValue === 'string') {
      await currentConfig.update('apiKey', nextValue.trim(), vscode.ConfigurationTarget.Global);
      semanticBlameService.updateConfig(
        nextValue.trim(),
        currentConfig.get<string>('baseUrl') || 'https://integrate.api.nvidia.com/v1',
        semanticBlameService.getModel(),
        currentConfig.get<string>('customInstructions') || ''
      );
      updateStatusBar();
      vscode.window.showInformationMessage('BlameLens API key updated.');
    }
  });
  const noopCommand = vscode.commands.registerCommand('blameLens.noop', () => {});

  if (!apiKey) {
    vscode.window.showInformationMessage(
      'Welcome to BlameLens! To get started, configure your API Key and Model in Settings.',
      'Configure Now',
      'Open Settings'
    ).then(selection => {
      if (selection === 'Configure Now') {
        vscode.commands.executeCommand('blameLens.setApiKey');
      } else if (selection === 'Open Settings') {
        vscode.commands.executeCommand('blameLens.openSettings');
      }
    });
  }

  const hoverProvider = vscode.languages.registerHoverProvider(
    { scheme: 'file', language: '*', },
    {
      async provideHover(document, position, _token) {
        if (!semanticBlameService.hasApiKey()) {
          return null;
        }
        const annotation = await semanticBlameService.getSemanticBlame(document.fileName, position.line);
        if (annotation) {
          const markdown = new vscode.MarkdownString();
          markdown.appendMarkdown(`**${annotation.one_liner}**\n\n`);
          markdown.appendMarkdown(`${annotation.intent}\n\n`);
          markdown.appendMarkdown(`*Trigger: ${annotation.trigger}*\n\n`);
          if (annotation.risk) {
            markdown.appendMarkdown(`**Risk:** ${annotation.risk}\n\n`);
          }
          markdown.appendMarkdown(`*Confidence: ${annotation.confidence * 100}%*`);
          return new vscode.Hover(markdown);
        }
        return null;
      },
    }
  );

  const codeLensProvider = vscode.languages.registerCodeLensProvider(
    { scheme: 'file', language: '*', },
    new CodeLensProvider(semanticBlameService)
  );

  context.subscriptions.push(
    hoverProvider,
    codeLensProvider,
    ghostBlameProvider,
    sidePanelView,
    openSettingsCommand,
    setApiKeyCommand,
    noopCommand,
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('blameLens')) {
        const newConfig = vscode.workspace.getConfiguration('blameLens');
        const newApiKey = newConfig.get<string>('apiKey') || '';
        const newBaseUrl = newConfig.get<string>('baseUrl') || 'https://integrate.api.nvidia.com/v1';
        const newModel = newConfig.get<string>('model') || 'minimaxai/minimax-m2.5';
        const newCustomInstructions = newConfig.get<string>('customInstructions') || '';
        semanticBlameService.updateConfig(newApiKey, newBaseUrl, newModel, newCustomInstructions);
        updateStatusBar();
      }
    })
  );
}

export function deactivate() {}
