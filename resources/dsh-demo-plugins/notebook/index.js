import path from 'node:path';
import process from 'node:process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
export const name = 'worldlinebox-demo-notebook';
export const inject = ['tools'];
export function apply(ctx) {
  const home = process.env.DSH_HOME;
  if (!home || !path.isAbsolute(home)) throw Error('A native DSH home is required.');
  const directory = path.join(home, 'plugin-data', 'worldlinebox-demo-notebook'), file = path.join(directory, 'notes.json');
  let pending = Promise.resolve();
  ctx.tools.register({ name: 'demo_notebook', description: 'Read or set a small note in this native profile only. Keys are labels, never file paths; an absent text reads the key.',
    parameters: { type: 'object', properties: { key: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,80}$' }, text: { type: 'string', maxLength: 4000 } }, required: ['key'], additionalProperties: false },
    output: { schema: { type: 'object', properties: { key: { type: 'string' }, text: { type: 'string' }, found: { type: 'boolean' }, written: { type: 'boolean' } }, required: ['key', 'text', 'found', 'written'], additionalProperties: false },
      render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    execute: ({ key, text }) => {
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(key) || text !== undefined && (typeof text !== 'string' || text.length > 4000)) throw Error('Invalid private note.');
      const operation = pending.then(async () => {
        let notes = Object.create(null);
        try { notes = Object.assign(Object.create(null), JSON.parse(await readFile(file, 'utf8'))); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (text !== undefined) {
          if (!Object.hasOwn(notes, key) && Object.keys(notes).length >= 100) throw Error('The demo notebook contains 100 notes.');
          notes[key] = text; await mkdir(directory, { recursive: true });
          const temporary = file + '.' + randomUUID() + '.tmp'; await writeFile(temporary, JSON.stringify(notes)); await rename(temporary, file);
        }
        return { key, text: Object.hasOwn(notes, key) ? String(notes[key]) : '', found: Object.hasOwn(notes, key), written: text !== undefined };
      });
      pending = operation.catch(() => undefined); return operation;
    } });
}
