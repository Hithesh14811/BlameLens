
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
      const annotation = JSON.parse(jsonPayload) as Omit<SemanticAnnotation, 'author'>;
      const finalAnnotation = { ...annotation, author: commitContext.author };
      this.cache.set(cacheKey, finalAnnotation);
      return finalAnnotation;
    } catch (error) {
      return null;
    }
  }

  public async searchHistory(file: string, query: string): Promise<{sha: string, message: string, date: string, relevance: number}[]> {
    const history = await this.gitService.getFullFileHistory(file);
    if (history.length === 0 || !this.client) return [];

    // Sample history if too large for prompt
    const sampledHistory = history.slice(0, 50); 
    const historyText = sampledHistory.map(h => `[${h.sha.substring(0, 7)}] ${h.date}: ${h.message}`).join('\n');

    const prompt = `QUERY: "${query}"

COMMIT HISTORY:
${historyText}

Based on the query, rank the most relevant commits from the history above.
Return a JSON array of objects, each containing:
{
  "sha": "full 40-char sha",
  "relevance": 0.0-1.0,
  "reason": "Brief explanation of why this commit is relevant to the query."
}
Only return the top 10 most relevant commits. Return ONLY the JSON array.`;

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
      });

      const result = response.choices[0]?.message?.content ?? '';
      const jsonPayload = result.match(/\[[\s\S]*\]/)?.[0] ?? '';
      if (!jsonPayload) return [];
      
      const rankings = JSON.parse(jsonPayload) as {sha: string, relevance: number, reason: string}[];
      
      return rankings.map(r => {
        const original = history.find(h => h.sha === r.sha);
        return {
          sha: r.sha,
          message: original?.message || 'Unknown',
          date: original?.date || 'Unknown',
          relevance: r.relevance
        };
      }).sort((a, b) => b.relevance - a.relevance);
    } catch (error) {
      return [];
    }
  }

  public async getSemanticAuthorImpact(file: string): Promise<any[]> {
    const stats = await this.gitService.getAuthorStats(file);
    if (Object.keys(stats).length === 0 || !this.client) return [];

    const authorsData = Object.entries(stats).map(([name, data]) => {
      return `AUTHOR: ${name}\nCOMMITS: ${data.commits}\nLINES: +${data.added}/-${data.removed}`;
    }).join('\n\n');

    const prompt = `Analyze the contribution of these authors to the file "${file}".
Based on their commit counts and line changes, provide a "Semantic Impact Score" (0-100) and a one-sentence "Contribution Persona" (e.g., "The Architect", "The Bug Fixer", "The Refactorer").

AUTHORS:
${authorsData}

Return a JSON array of objects:
{
  "name": "Author Name",
  "impactScore": 0-100,
  "persona": "Short title",
  "summary": "One sentence summary of their impact."
}
Return ONLY the JSON array.`;

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
      });

      const result = response.choices[0]?.message?.content ?? '';
      const jsonPayload = result.match(/\[[\s\S]*\]/)?.[0] ?? '';
      if (!jsonPayload) return [];
      
      const impacts = JSON.parse(jsonPayload);
      return impacts.map((imp: any) => ({
        ...imp,
        ...stats[imp.name]
      })).sort((a: any, b: any) => b.impactScore - a.impactScore);
    } catch (error) {
      return [];
    }
  }

  public async summarizeCommit(sha: string): Promise<string | null> {
    if (!this.client) return null;

    const commitContext = await this.gitService.getCommitContext(sha);
    if (!commitContext) return 'Could not find commit.';

    const prompt = `Provide a human-readable summary of the following commit. Focus on the high-level changes and the overall intent. Use markdown for formatting.\n\nCOMMIT: ${commitContext.sha}\nAUTHOR: ${commitContext.author}\nDATE: ${commitContext.date}\nMESSAGE: "${commitContext.message}"\n\nDIFF:\n${commitContext.diff}`;

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
      });

      return response.choices[0]?.message?.content ?? 'No summary available.';
    } catch (error) {
      return 'Failed to generate summary.';
    }
  }
}
