// Fails the build when something that looks like a Supabase secret key could reach the public website.
//
// It checks three places:
//  1. the built site in dist/ (what visitors download),
//  2. the source files (a key pasted into code by mistake),
//  3. the VITE_ settings in .env files and the environment (Vite copies every VITE_ value into the site).
//
// Run it with: npm run check:secrets. It also runs at the end of npm run build.
// It never prints a key. It prints the file, the kind of key and the first few characters only.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SECRET_KEY = /sb_secret_[A-Za-z0-9_-]{16,}/g;
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const DANGEROUS_ENV_NAME = /^VITE_.*(SECRET|SERVICE[_-]?ROLE)/i;
const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.css', '.html', '.json', '.map', '.txt', '.svg', '.md']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'e2e']);

function redact(value) {
  return `${value.slice(0, 8)}... (${value.length} characters)`;
}

function jwtRole(token) {
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
    return typeof payload.role === 'string' ? payload.role : null;
  } catch {
    return null;
  }
}

/** Finds secret keys in a block of text. Publishable and anon keys are fine and are not reported. */
export function findSecrets(text) {
  const found = [];
  for (const match of text.matchAll(SECRET_KEY)) found.push({ kind: 'secret key', excerpt: redact(match[0]) });
  for (const match of text.matchAll(JWT)) {
    if (jwtRole(match[0]) === 'service_role') found.push({ kind: 'service role key', excerpt: redact(match[0]) });
  }
  return found;
}

/** VITE_ variable names that suggest a secret. Vite would publish their values. */
export function findDangerousEnvNames(names) {
  return names.filter((name) => DANGEROUS_ENV_NAME.test(name));
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    const info = statSync(path);
    if (info.isDirectory()) yield* walk(path);
    else if (TEXT_EXTENSIONS.has(extname(name))) yield path;
  }
}

function scanFiles(root, folders, problems) {
  let scanned = 0;
  for (const folder of folders) {
    const dir = join(root, folder);
    if (!existsSync(dir)) continue;
    for (const file of walk(dir)) {
      scanned += 1;
      for (const hit of findSecrets(readFileSync(file, 'utf8'))) {
        problems.push(`${relative(root, file)}: ${hit.kind} (${hit.excerpt})`);
      }
    }
  }
  return scanned;
}

function envAssignments(root) {
  const pairs = [];
  for (const name of readdirSync(root)) {
    if (!name.startsWith('.env')) continue;
    for (const line of readFileSync(join(root, name), 'utf8').split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (match) pairs.push({ file: name, name: match[1], value: match[2].trim().replace(/^["']|["']$/g, '') });
    }
  }
  for (const [name, value] of Object.entries(process.env)) pairs.push({ file: 'environment', name, value: value ?? '' });
  return pairs;
}

export function runScan(root) {
  const problems = [];
  const scanned = scanFiles(root, ['dist', 'src', 'public', 'scripts'], problems);
  if (existsSync(join(root, 'index.html'))) {
    for (const hit of findSecrets(readFileSync(join(root, 'index.html'), 'utf8'))) {
      problems.push(`index.html: ${hit.kind} (${hit.excerpt})`);
    }
  }

  const publicVars = envAssignments(root).filter(({ name }) => name.startsWith('VITE_'));
  for (const variable of publicVars) {
    if (variable.value && findDangerousEnvNames([variable.name]).length > 0) {
      problems.push(`${variable.file}: ${variable.name} looks like a secret but VITE_ variables are published with the site`);
    }
    for (const hit of findSecrets(variable.value)) {
      problems.push(`${variable.file}: ${variable.name} holds a ${hit.kind} (${hit.excerpt})`);
    }
  }
  return { problems, scanned, publicVars: publicVars.length };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const { problems, scanned, publicVars } = runScan(process.cwd());
  if (problems.length > 0) {
    console.error('Secret scan FAILED. Remove these, then rotate any key that was exposed:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  const distNote = existsSync(join(process.cwd(), 'dist')) ? 'including the built site' : 'dist/ not built yet, so only source files';
  console.log(`Secret scan passed: ${scanned} files checked (${distNote}), ${publicVars} VITE_ settings checked.`);
}
