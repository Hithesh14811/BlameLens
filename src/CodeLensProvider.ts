
import * as vscode from 'vscode';
import { SemanticBlameService } from './SemanticBlameService';

export class CodeLensProvider implements vscode.CodeLensProvider {
  private semanticBlameService: SemanticBlameService;

  constructor(semanticBlameService: SemanticBlameService) {
    this.semanticBlameService = semanticBlameService;
  }

  public async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
    if (!this.semanticBlameService.hasApiKey()) {
      return [];
    }

    const config = vscode.workspace.getConfiguration('blameLens');
    if (!config.get<boolean>('enableCodeLens')) {
      return [];
    }

    const codeLenses: vscode.CodeLens[] = [];
    
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      document.uri
    );

    if (!symbols) {
      return [];
    }

    const processSymbols = async (symbols: vscode.DocumentSymbol[]) => {
      for (const symbol of symbols) {
        if (token.isCancellationRequested) {
          return;
        }

        if (
          symbol.kind === vscode.SymbolKind.Function ||
          symbol.kind === vscode.SymbolKind.Method ||
          symbol.kind === vscode.SymbolKind.Class ||
          symbol.kind === vscode.SymbolKind.Interface
        ) {
          const range = new vscode.Range(symbol.range.start.line, 0, symbol.range.start.line, 0);
          const annotation = await this.semanticBlameService.getSemanticBlame(document.fileName, symbol.range.start.line);
          
          if (annotation) {
            const command = {
              title: `$(git-commit) ${annotation.one_liner}`,
              command: 'blameLens.noop',
              tooltip: annotation.intent
            };
            codeLenses.push(new vscode.CodeLens(range, command));
          }
        }

        if (symbol.children && symbol.children.length > 0) {
          await processSymbols(symbol.children);
        }
      }
    };

    await processSymbols(symbols);
    return codeLenses;
  }
}
