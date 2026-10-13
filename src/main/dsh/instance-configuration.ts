import path from 'node:path';
import { parseDocument } from 'yaml';

const pathKey = /(?:^|[._$-])(?:path|paths|root|roots|dir|dirs|directory|directories|home|cwd|workspace|include|patch)(?:$|[._-])|(?:Path|Paths|Root|Roots|Dir|Dirs|Directory|Directories|Home)$/i;
const windowsAbsolute = /^(?:[a-z]:[\\/]|\\\\)/i;
function inside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Reject data redirection that would bypass the environment and make two instances share mutable state. */
export function auditInstanceConfiguration(text: string, file: string, root: string, runtimeRoot: string): void {
  const inspectPath = (key: string, raw: string) => {
    if (!pathKey.test(key) || !raw.trim() || /^(?:https?:|data:|npm:)/i.test(raw)) return;
    const value = raw.trim().replace(/^['"]|['"]$/g, '');
    // DSH's own variables are assigned by this launcher. Arbitrary interpolation can hide an external data root.
    if (/\$\{/.test(value)) {
      const variable = /^(\$\{(?:DSH_HOME|DSH_AGENTS_HOME|HOME|USERPROFILE)\})([\\/].*)?$/.exec(value);
      if (!variable || (variable[2] && !inside(root, path.resolve(root, 'workspace', variable[2].slice(1))))) throw new Error(`Configuration ${file} uses an unverified data path variable in ${key}.`);
      return;
    }
    const absolute = windowsAbsolute.test(value) || path.isAbsolute(value);
    if (absolute) {
      const mutable = /(?:storage|session|agentsHome|dshHome|dataDir|dataRoot|credentials)/i.test(key);
      if (!inside(root, value) && (mutable || !inside(runtimeRoot, value))) throw new Error(`Configuration ${file} redirects ${key} outside this isolated instance. Use its Home, agents or workspace directory.`);
    } else if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value)) {
      if (!inside(root, path.resolve(root, 'workspace', value))) throw new Error(`Configuration ${file} contains a data path that escapes this isolated instance: ${key}.`);
    }
  };
  const ancestors = new Set<object>(); let nodes = 0;
  const inspect = (value: unknown, key: string, depth = 0): void => {
    if (++nodes > 50_000 || depth > 100) throw new Error(`Configuration ${file} exceeds the safe audit limits.`);
    if (typeof value === 'string') inspectPath(key, value);
    else if (value && typeof value === 'object') {
      if (ancestors.has(value)) throw new Error(`Configuration ${file} contains recursive aliases.`);
      ancestors.add(value);
      if (Array.isArray(value)) for (const item of value) inspect(item, key, depth + 1);
      else for (const [child, item] of Object.entries(value)) inspect(item, key ? `${key}.${child}` : child, depth + 1);
      ancestors.delete(value);
    }
  };
  if (/\.json$/i.test(file)) { inspect(JSON.parse(text), ''); return; }
  if (/\.ya?ml$/i.test(file)) {
    // YAML's standard schema never evaluates JavaScript tags. Aliases are resolved with a bounded expansion.
    const document = parseDocument(text, { uniqueKeys: true, prettyErrors: false });
    if (document.errors.length) throw new Error(`Configuration ${file} is not valid YAML: ${document.errors[0]!.message}`);
    inspect(document.toJS({ maxAliasCount: 100 }), '');
    return;
  }
  const stack: Array<{ indent: number; key: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const field = /^\s*(?:-\s+)?["']?([a-zA-Z0-9_$.-]+)["']?\s*[:=]\s*(.*)$/.exec(line);
    if (field?.[1]) {
      const key = field[1]; const value = field[2]?.replace(/\s+#.*$/, '').trim() ?? '';
      if (value) {
        const fullKey = [...stack.map(parent => parent.key), key].join('.');
        inspectPath(fullKey, value);
        if (value.startsWith('[') && value.endsWith(']')) for (const element of value.slice(1, -1).split(',')) inspectPath(fullKey, element);
      }
      stack.push({ indent, key });
    } else if (stripped.startsWith('- ') && stack.length) inspectPath(stack.map(parent => parent.key).join('.'), stripped.slice(2).replace(/\s+#.*$/, ''));
  }
}

export function rebaseInstanceConfiguration(text: string, oldRoot: string, root: string): string {
  // Replace JSON-escaped roots first: a normal Windows root is a prefix of some escaped spellings.
  const replacements = [[oldRoot.replaceAll('\\', '\\\\'), root.replaceAll('\\', '\\\\')],
    [oldRoot.replaceAll('\\', '/'), root.replaceAll('\\', '/')], [oldRoot, root]] as const;
  let rewritten = text;
  for (const [from, to] of replacements) rewritten = rewritten.split(from).join(to);
  return rewritten;
}
