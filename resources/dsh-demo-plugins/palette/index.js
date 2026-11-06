export const name = 'worldlinebox-demo-palette';
export const inject = ['tools'];
export function apply(ctx) {
  ctx.tools.register({ name: 'demo_palette', description: 'Inspect a six digit hex colour. Returns RGB and its complementary colour; no filesystem or network access.',
    parameters: { type: 'object', properties: { hex: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' } }, required: ['hex'], additionalProperties: false },
    output: { schema: { type: 'object', properties: { hex: { type: 'string' }, rgb: { type: 'array', items: { type: 'integer' } }, complement: { type: 'string' } }, required: ['hex', 'rgb', 'complement'], additionalProperties: false },
      render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    execute: async ({ hex }) => {
      if (!/^#[0-9a-fA-F]{6}$/.test(hex)) throw Error('A six digit hex colour is required.');
      const rgb = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
      return { hex: hex.toUpperCase(), rgb, complement: '#' + rgb.map(value => (255 - value).toString(16).padStart(2, '0')).join('').toUpperCase() };
    } });
}
