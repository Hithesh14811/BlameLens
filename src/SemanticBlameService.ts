
import OpenAI from 'openai';
import { GitService } from './GitService';
import { CommitContext, SemanticAnnotation } from './types';
import * as vscode from 'vscode';
import { AnnotationCache } from './AnnotationCache';

export class SemanticBlameService {
  public client: OpenAI | null = null;
  public gitService: GitService;
  public cache: AnnotationCache;
  private baseUrl: string;
  private model: string;
  private customInstructions: string = '';

  constructor(apiKey: string, context: vscode.ExtensionContext, baseUrl: string, model: string, gitService: GitService) {
    this.gitService = gitService;
    this.cache = new AnnotationCache(context);
    this.baseUrl = baseUrl;
    this.model = model;
    this.updateConfig(apiKey, baseUrl, model, '');
  }

  public updateConfig(apiKey: string, baseUrl: string, model: string, customInstructions: string) {
    this.baseUrl = baseUrl;
    this.model = model;
    this.customInstructions = customInstructions;
    if (apiKey) {
      this.client = new OpenAI({ apiKey, baseURL: baseUrl });
    } else {
      this.client = null;
    }
  }

  public hasApiKey(): boolean {
    return this.client !== null;
  }

  public getModel(): string {
    return this.model;
  }

  private assemblePrompt(commitContext: CommitContext, surroundingContext: string, priorCommits: string): string {
    return `COMMIT: ${commitContext.sha}
AUTHOR: ${commitContext.author}
DATE: ${commitContext.date}
MESSAGE: "${commitContext.message}"

DIFF THAT INTRODUCED THIS CODE:
${commitContext.diff}

SURROUNDING CONTEXT (±20 lines):
${surroundingContext}

PRIOR COMMITS TOUCHING THIS FILE (last 5):
${priorCommits}`;
  }

  public async getSemanticBlame(file: string, line: number): Promise<SemanticAnnotation | null> {
    const gitLine = line + 1;
    const blameHunk = await this.gitService.blame(file, gitLine);
    if (!blameHunk) {
      return null;
    }

    const cacheKey = `${blameHunk.sha}:${file}:${blameHunk.startLine}:${blameHunk.endLine}`;
    const cachedAnnotation = this.cache.get(cacheKey);
    if (cachedAnnotation) {
      return cachedAnnotation;
    }

    const commitContext = await this.gitService.getCommitContext(blameHunk.sha);
    if (!commitContext) {
      return null;
    }

    const document = await vscode.workspace.openTextDocument(file);
    const startLine = Math.max(0, line - 20);
    const endLine = Math.min(document.lineCount - 1, line + 20);
    const endCharacter = document.lineAt(endLine).text.length;
    const surroundingContext = document.getText(new vscode.Range(startLine, 0, endLine, endCharacter));

    const priorCommits = await this.gitService.getPriorCommits(file, blameHunk.sha);

    const prompt = this.assemblePrompt(commitContext, surroundingContext, priorCommits);

    if (!this.client) {
      return null;
    }

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        max_tokens: 1024,
        messages: [
          {
            role: 'system',
            content: `You are a world-class code historian and senior architect. Your goal is to explain WHY a specific piece of code exists by analyzing its git history.
Focus on the business logic, bug fixes, or architectural requirements that necessitated this change.
Be extremely specific. Avoid generic phrases like "added code" or "fixed bug".
If the commit message mentions a JIRA/GitHub issue ID, incorporate that context.

ADDITIONAL USER INSTRUCTIONS:
${this.customInstructions || 'None provided.'}

Your response MUST be a valid JSON object with the following fields:
{
  "one_liner": "A punchy, single-sentence summary of why this code exists (max 25 words).",
  "intent": "The technical or business goal the author aimed to achieve.",
  "trigger": "The specific event (bug report, feature request, refactor) that caused this change.",
  "risk": "What would break if this code was removed or modified in an unexpected way.",
  "confidence": 0.0-1.0
}
Only return the JSON. No other text.`
          },
          { role: 'user', content: prompt }
        ],
        temperature: 0,
      }, { timeout: 8000 });

      const result = response.choices[0]?.message?.content ?? '';
      if (!result) {
        return null;
      }
      const jsonPayload = result.match(/\{[\s\S]*\}/)?.[0] ?? '';
      if (!jsonPayload) {
        return null;
      }
      const annotation = JSON.parse(jsonPayload) as SemanticAnnotation;
      this.cache.set(cacheKey, annotation);
      return annotation;
    } catch (error) {
      return null;
    }
  }
}
