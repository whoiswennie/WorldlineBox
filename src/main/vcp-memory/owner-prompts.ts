import path from 'node:path';
import { readFile } from 'node:fs/promises';

/** Bootstrap only: take the exact frozen upstream defaults without executing
 * source. Runtime provider prompts must subsequently come from owner files. */
export async function loadInitialTimelinePrompts(vendorRoot: string): Promise<{ timeline: string; summary: string }> {
  const source = await readFile(path.join(vendorRoot, 'Plugin/VCPTimeLine/VCPTimeLine.js'), 'utf8');
  const extract = (method: string, summary = false) => {
    const signature = `    async ${method}(`, start = source.indexOf(signature);
    if (start < 0) throw new Error('The frozen upstream timeline prompt signature has changed.');
    const body = source.slice(start, source.indexOf('\n    async ', start + signature.length));
    const literal = (summary ? /const prompt = custom \|\| `([^`]+)`;/u : /const prompt = `([^`]+)`;/u).exec(body)?.[1];
    if (!literal) throw new Error('The frozen upstream timeline prompt cannot be initialized safely.');
    const template = literal.replaceAll('${agentName}', '{{agentName}}').replaceAll('${month}', '{{month}}');
    if (template.includes('${')) throw new Error('The frozen upstream timeline prompt has unknown interpolation.');
    return template;
  };
  return { timeline: extract('summarizeMonth'), summary: extract('generateOneLineSummary', true) };
}
