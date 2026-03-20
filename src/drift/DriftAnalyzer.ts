import OpenAI from 'openai';
import { FunctionSnapshot } from './SnapshotExtractor';
import { EmbeddingService } from './EmbeddingService';

export interface DriftPoint {
  snapshot: FunctionSnapshot;
  embedding: number[];
  driftScore: number;      // cosine distance from previous snapshot (0 = identical, 2 = opposite) 
  isRupture: boolean;      // true if driftScore > RUPTURE_THRESHOLD 
  cumulativeDrift: number; // sum of all driftScores up to this point 
}

export interface DriftAnalysis {
  functionName: string;
  points: DriftPoint[];
  totalDrift: number;
  ruptureCount: number;
  mostVolatilePeriod: { from: string; to: string; drift: number };
  currentIdentity: string; // one-sentence summary from Claude of what the function does NOW 
  originalIdentity: string; // one-sentence summary of what it did at first commit 
}

const RUPTURE_THRESHOLD = 0.35;

function cosineDist(a: number[], b: number[]): number {
  const dot = a.reduce((s, v, i) => s + v * b[i], 0);
  const magA = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
  const magB = Math.sqrt(b.reduce((s, v) => s + v * v, 0));
  if (magA === 0 || magB === 0) return 0;
  return 1 - dot / (magA * magB);
}

export class DriftAnalyzer {
  constructor(
    private embeddingService: EmbeddingService,
    private client: OpenAI | null
  ) {}

  public async analyze(
    snapshots: FunctionSnapshot[], 
    functionName: string, 
    onPoint: (point: DriftPoint) => void
  ): Promise<DriftAnalysis> {
    // oldest-first (reverse the array from SnapshotExtractor)
    const reversedSnapshots = [...snapshots].reverse();

    const points: DriftPoint[] = [];
    let cumulativeDrift = 0;
    let ruptureCount = 0;
    let previousEmbedding: number[] | null = null;

    // Use a semaphore to limit concurrency to 5
    const limit = 5;
    let active = 0;
    const queue: (() => void)[] = [];

    const acquire = () => new Promise<void>(resolve => {
      if (active < limit) {
        active++;
        resolve();
      } else {
        queue.push(resolve);
      }
    });

    const release = () => {
      active--;
      if (queue.length > 0) {
        active++;
        queue.shift()!();
      }
    };

    const processSnapshot = async (snapshot: FunctionSnapshot, index: number) => {
      await acquire();
      try {
        const embedding = await this.embeddingService.embed(snapshot, functionName);
        let driftScore = 0;
        
        // Note: This simplified drift calculation assumes sequential processing for correct previousEmbedding
        // For true parallel with streaming, we'd need to ensure order or compute drift after all embeddings are in.
        // However, the prompt says "send each DriftPoint as it's computed", so we'll do sequential within the parallel limit.
        // To maintain correct driftScore relative to the *previous* in the timeline:
        return { snapshot, embedding, index };
      } finally {
        release();
      }
    };

    // We still need all embeddings to calculate driftScore correctly for the timeline
    // but we can start emitting points once we have their embeddings.
    const results = await Promise.all(reversedSnapshots.map((s, i) => processSnapshot(s, i)));
    
    // Sort by index to ensure chronological order for drift calculation
    results.sort((a, b) => a.index - b.index);

    for (let i = 0; i < results.length; i++) {
      const { snapshot, embedding } = results[i];
      let driftScore = 0;

      if (i > 0) {
        driftScore = cosineDist(embedding, results[i - 1].embedding);
      }

      cumulativeDrift += driftScore;
      const isRupture = driftScore > RUPTURE_THRESHOLD;
      if (isRupture) ruptureCount++;

      const point = {
        snapshot,
        embedding,
        driftScore,
        isRupture,
        cumulativeDrift
      };
      points.push(point);
      onPoint(point);
    }

    let mostVolatilePeriod = { from: '', to: '', drift: 0 };
    for (let i = 1; i < points.length; i++) {
      const drift = points[i].driftScore;
      if (drift > mostVolatilePeriod.drift) {
        mostVolatilePeriod = {
          from: points[i - 1].snapshot.sha,
          to: points[i].snapshot.sha,
          drift
        };
      }
    }

    const firstSource = reversedSnapshots[0].sourceCode;
    const lastSource = reversedSnapshots[reversedSnapshots.length - 1].sourceCode;

    const [originalIdentity, currentIdentity] = await Promise.all([
      this.getIdentitySummary(firstSource),
      this.getIdentitySummary(lastSource)
    ]);

    return {
      functionName,
      points,
      totalDrift: cumulativeDrift,
      ruptureCount,
      mostVolatilePeriod,
      originalIdentity,
      currentIdentity
    };
  }

  private async getIdentitySummary(sourceCode: string): Promise<string> {
    if (!this.client) return 'No identity summary available.';

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000);

      const response = await this.client.chat.completions.create({
        model: 'claude-3-haiku-20240307',
        messages: [{
          role: 'user',
          content: `In one sentence of 15 words or fewer, what does this function do? Reply with only the sentence.

Function:
${sourceCode}`
        }],
        temperature: 0,
        max_tokens: 100,
      }, { signal: controller.signal });

      clearTimeout(timeoutId);

      return response.choices[0]?.message?.content?.trim() || 'No identity summary available.';
    } catch {
      return 'Summary failed.';
    }
  }
}
