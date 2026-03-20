import OpenAI from 'openai';
import { AnnotationCache } from '../AnnotationCache';
import { FunctionSnapshot } from './SnapshotExtractor';

export class EmbeddingService {
  constructor(
    private client: OpenAI | null,
    private cache: AnnotationCache,
    private model: string = "minimaxai/minimax-m2.5" // Default to existing model if haiku is unavailable
  ) {}

  public async embed(snapshot: FunctionSnapshot, functionName: string): Promise<number[]> {
    const cacheKey = `embed:${snapshot.sha}:${functionName}`;
    const cached = this.cache.getEmbedding(cacheKey);
    if (cached) return cached;

    if (!this.client) return new Array(32).fill(0);

    const prompt = `Analyze this function and respond ONLY with a JSON array of exactly 32 
floats between -1.0 and 1.0. Each float encodes one semantic dimension:
[0-3]   purpose: data-transform, side-effect, validation, orchestration 
[4-7]   complexity: cyclomatic, cognitive, coupling, cohesion 
[8-11]  domain: auth, data, ui, infra 
[12-15] pattern: crud, pipeline, event, utility 
[16-19] stability: change-freq, interface-stability, dep-count, test-coverage-signal 
[20-23] risk: error-handling, mutation, async, external-io 
[24-27] abstraction-level: concrete, abstract, generic, specific 
[28-31] intent-clarity: named-well, documented, obvious, surprising 

Function to analyze: 
${snapshot.sourceCode} 

Respond with ONLY the JSON array. No explanation. No markdown.`;

    let retries = 1;
    while (retries >= 0) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 12000);

        const response = await this.client.chat.completions.create({
          model: "claude-3-haiku-20240307",
          messages: [{ role: 'user', content: prompt }],
          temperature: 0,
          max_tokens: 256,
        }, { signal: controller.signal });

        clearTimeout(timeoutId);

        const content = response.choices[0]?.message?.content?.trim() || '';
        const vector = JSON.parse(content);

        if (Array.isArray(vector) && vector.length === 32 && vector.every(v => typeof v === 'number')) {
          this.cache.setEmbedding(cacheKey, vector);
          return vector;
        }
        throw new Error('Invalid vector format');
      } catch (error) {
        if (retries === 0) {
          console.warn(`Embedding failed for ${snapshot.sha}:`, error);
          return new Array(32).fill(0);
        }
        retries--;
      }
    }
    return new Array(32).fill(0);
  }
}
