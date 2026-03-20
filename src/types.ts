
export interface BlameHunk {
  sha: string;
  startLine: number;
  endLine: number;
}

export interface CommitContext {
  sha: string;
  author: string;
  date: string;
  message: string;
  diff: string;
}

export interface SemanticAnnotation {
  one_liner: string;
  intent: string;
  trigger: string;
  risk: string | null;
  confidence: number;
}
