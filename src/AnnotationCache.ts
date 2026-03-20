
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SemanticAnnotation } from './types';

export class AnnotationCache {
  private cachePath: string;
  private records: Record<string, { annotation: SemanticAnnotation; createdAt: number }>;
  private embeddings: Record<string, { vector: number[]; createdAt: number }>;

  constructor(context: vscode.ExtensionContext) {
    const storagePath = context.globalStorageUri.fsPath;
    if (!fs.existsSync(storagePath)) {
      fs.mkdirSync(storagePath, { recursive: true });
    }
    this.cachePath = path.join(storagePath, 'semantic-blame-cache.json');
    this.records = {};
    this.embeddings = {};
    this.load();
  }

  public get(key: string): SemanticAnnotation | null {
    const row = this.records[key];
    if (row) {
      return row.annotation;
    }
    return null;
  }

  public set(key: string, annotation: SemanticAnnotation): void {
    this.records[key] = {
      annotation,
      createdAt: Date.now(),
    };
    this.save();
  }

  public getEmbedding(key: string): number[] | null {
    const row = this.embeddings[key];
    if (row) {
      return row.vector;
    }
    return null;
  }

  public setEmbedding(key: string, vector: number[]): void {
    this.embeddings[key] = {
      vector,
      createdAt: Date.now(),
    };
    this.save();
  }

  private load(): void {
    if (!fs.existsSync(this.cachePath)) {
      return;
    }
    try {
      const raw = fs.readFileSync(this.cachePath, 'utf8');
      const data = JSON.parse(raw);
      if (data.records) {
        this.records = data.records;
        this.embeddings = data.embeddings || {};
      } else {
        // Old format: root object is the records
        this.records = data;
        this.embeddings = {};
      }
    } catch {
      this.records = {};
      this.embeddings = {};
    }
  }

  private save(): void {
    fs.writeFileSync(this.cachePath, JSON.stringify({
      records: this.records,
      embeddings: this.embeddings
    }), 'utf8');
  }
}
