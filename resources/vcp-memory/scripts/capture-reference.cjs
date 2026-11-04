#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..', 'references', 'official');
const sources = ['vcp-whitepaper.md', 'teaching-docs.md', 'rivermemo-topology-v3.md', 'compact-prompt-layout-guide.md'];
function literalAt(source, offset) {
  const delimiter = source[offset];
  if (!['`', '"', "'"].includes(delimiter)) throw new Error('Expected a static string literal');
  let output = '';
  for (let i = offset + 1; i < source.length; i++) {
    const char = source[i];
    if (char === delimiter) return output;
    if (char === '$' && source[i + 1] === '{' && delimiter === '`') throw new Error('Dynamic interpolation is not accepted');
    if (char !== '\\') { output += char; continue; }
    const escape = source[++i];
    const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };
    if (Object.hasOwn(simple, escape)) output += simple[escape];
    else if (escape === 'u' || escape === 'x') {
      const count = escape === 'u' ? 4 : 2;
      output += String.fromCharCode(parseInt(source.slice(i + 1, i + 1 + count), 16)); i += count;
    } else if (escape !== '\n' && escape !== '\r') output += escape;
  }
  throw new Error('Unterminated reference string');
}
(async () => {
  fs.mkdirSync(root, { recursive: true });
  const landing = await fetch('https://www.vcptoolbox.com/?page=learn-vcp');
  const html = await landing.text();
  const asset = html.match(/<script[^>]+src="([^"]+)"/)[1];
  const assetUrl = new URL(asset, landing.url).href;
  const cacheArg = process.argv.indexOf('--asset');
  const script = cacheArg >= 0 ? fs.readFileSync(process.argv[cacheArg + 1], 'utf8')
    : await (await fetch(assetUrl)).text();
  const entries = [];
  for (const name of sources) {
    const reference = './docs/' + name;
    const moduleName = script.match(new RegExp('"' + reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '":([A-Za-z0-9_$]+)'))?.[1];
    if (!moduleName) throw new Error('Reference not found in official bundle: ' + reference);
    const definition = script.slice(script.indexOf(moduleName + '=Object.freeze'));
    const variable = definition.match(/default:([A-Za-z0-9_$]+)/)?.[1];
    const variableIndex = script.indexOf(variable + '=');
    if (!variable || variableIndex < 0) throw new Error('Static document binding unavailable: ' + name);
    const bytes = Buffer.from(literalAt(script, variableIndex + variable.length + 1));
    fs.writeFileSync(path.join(root, name), bytes);
    entries.push({ file: name, url: 'https://www.vcptoolbox.com/?page=learn-vcp', embeddedReference: reference, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  }
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
    capturedAt: new Date().toISOString(), landingPage: 'https://www.vcptoolbox.com/?page=learn-vcp',
    assetUrl, assetSha256: crypto.createHash('sha256').update(script).digest('hex'),
    note: 'Official site embeds Markdown as static JS strings; /docs/*.md is not a public endpoint. Extracted with a static string decoder (no evaluation). Implementation authority remains the local repository snapshot.', files: entries,
  }, null, 2) + '\n');
  process.stdout.write(JSON.stringify(entries.map(({ file, bytes }) => ({ file, bytes }))) + '\n');
})().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
