// Fonte única da versão: o "version" do package.json.
// Este script copia essa versão para os manifestos Rust (app Tauri e servidor).
//
//   node scripts/sync-version.mjs          grava a versão nos arquivos
//   node scripts/sync-version.mjs --check  só confere; sai com erro se algo divergir
//
// Roda sozinho no `npm version <major|minor|patch>` (script "version" do package.json).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Versão inválida no package.json: "${version}" (use MAIOR.MENOR.CORREÇÃO, ex: 0.2.0)`);
  process.exit(1);
}

// Cada padrão captura: (antes da versão)(versão)(depois)
const packageVersion = /^(\[package\][\s\S]*?^version\s*=\s*")([^"]+)(")/m;
const lockVersion = (name) => new RegExp(`(\\[\\[package\\]\\]\\r?\\nname = "${name}"\\r?\\nversion = ")([^"]+)(")`);

const targets = [
  ['src-tauri/Cargo.toml', packageVersion],
  ['src-tauri/Cargo.lock', lockVersion('tauri-app')],
  ['server/Cargo.toml', packageVersion],
  ['server/Cargo.lock', lockVersion('dascord-server')],
];

let mismatches = 0;
for (const [file, pattern] of targets) {
  const path = join(root, file);
  const content = readFileSync(path, 'utf8');
  const match = content.match(pattern);
  if (!match) {
    console.error(`✗ ${file}: linha de versão não encontrada`);
    process.exit(1);
  }

  const current = match[2];
  if (current === version) {
    console.log(`✓ ${file} (${version})`);
  } else if (checkOnly) {
    console.error(`✗ ${file}: ${current}, esperado ${version}`);
    mismatches++;
  } else {
    // Função em vez de "$1...": uma versão começando com dígito viraria "$10"
    writeFileSync(path, content.replace(pattern, (_, before, _old, after) => before + version + after));
    console.log(`↻ ${file}: ${current} → ${version}`);
  }
}

if (mismatches > 0) {
  console.error('\nVersões fora de sincronia. Rode "npm run version:sync".');
  process.exit(1);
}
