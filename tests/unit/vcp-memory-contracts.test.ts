import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { embeddingConfiguration, normalizeNote } = require(path.resolve('src/main/vcp-memory/runtime.cjs')) as {
  embeddingConfiguration(input: unknown): { apiUrl: string; queryApiUrl?: string; modelSignature: string };
  normalizeNote(input: unknown): unknown;
};

describe('VCP memory host input boundaries', () => {
  it('normalizes OpenAI compatible document and query roots without changing semantic input', () => {
    expect(embeddingConfiguration({ baseUrl: 'https://host.invalid/document/v1/', queryBaseUrl: 'https://host.invalid/query/v1',
      model: 'embedding-model', dimension: 768 })).toMatchObject({ apiUrl: 'https://host.invalid/document', queryApiUrl: 'https://host.invalid/query', modelSignature: 'embedding-model' });
  });
  it('rejects unsupported dimensions and injected tag metadata before mutation', () => {
    expect(() => embeddingConfiguration({ baseUrl: 'https://host.invalid', model: 'model', dimension: 4097 })).toThrow(/dimension/iu);
    expect(() => normalizeNote({ id: 'note', content: 'fact', tags: ['safe\nTag: injected'] })).toThrow(/Tags/u);
    expect(() => normalizeNote({ id: 'note', content: 'fact', tags: [], occurredAt: 'not-a-date' })).toThrow(/date/u);
  });
});
