export const name = 'worldlinebox-demo-text-statistics';
export const inject = ['tools'];
export function apply(ctx) {
  ctx.tools.register({ name: 'demo_text_statistics', description: 'Count Unicode code points, whitespace-separated words and lines of supplied text. No filesystem or network access.',
    parameters: { type: 'object', properties: { text: { type: 'string', maxLength: 20000 } }, required: ['text'], additionalProperties: false },
    output: { schema: { type: 'object', properties: { characters: { type: 'integer' }, words: { type: 'integer' }, lines: { type: 'integer' } }, required: ['characters', 'words', 'lines'], additionalProperties: false },
      render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    execute: async ({ text }) => {
      if (typeof text !== 'string' || text.length > 20000) throw Error('Text exceeds the demo limit.');
      return { characters: Array.from(text).length, words: text.trim() ? text.trim().split(/\s+/u).length : 0, lines: text ? text.split(/\r\n|\r|\n/u).length : 0 };
    } });
}
