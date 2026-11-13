// Tests for the secret scanner. Fake keys are built at run time so this file does not contain anything key shaped.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findDangerousEnvNames, findSecrets, runScan } from './check-secrets.mjs';

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (role) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ iss: 'supabase', role })}.${'s'.repeat(24)}`;
const publishable = ['sb', 'publishable', 'a1B2c3D4e5F6g7H8'].join('_');
const secret = ['sb', 'secret', 'z9Y8x7W6v5U4t3S2r1Q0'].join('_');

describe('findSecrets', () => {
  it('finds secret keys and service role keys', () => {
    expect(findSecrets(`const k = "${secret}";`)).toHaveLength(1);
    expect(findSecrets(`const k = "${jwt('service_role')}";`)).toHaveLength(1);
  });

  it('leaves publishable and anon keys alone', () => {
    expect(findSecrets(`a="${publishable}"; b="${jwt('anon')}"`)).toEqual([]);
  });

  it('ignores the words themselves and short prefixes', () => {
    expect(findSecrets('Never use a sb_secret_ key or the service_role key in the browser.')).toEqual([]);
  });

  it('never returns the whole key', () => {
    const [hit] = findSecrets(secret);
    expect(hit.excerpt).not.toContain(secret);
    expect(hit.excerpt.length).toBeLessThan(secret.length);
  });
});

describe('findDangerousEnvNames', () => {
  it('flags VITE_ names that suggest a secret', () => {
    expect(findDangerousEnvNames(['VITE_SUPABASE_SERVICE_ROLE_KEY', 'VITE_SECRET_THING', 'VITE_SERVICE-ROLE'])).toHaveLength(3);
  });

  it('allows the normal settings', () => {
    expect(findDangerousEnvNames(['VITE_BACKEND', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY'])).toEqual([]);
  });
});

describe('runScan', () => {
  function project(files) {
    const root = mkdtempSync(join(tmpdir(), 'scan-'));
    for (const [path, text] of Object.entries(files)) {
      const full = join(root, path);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, text);
    }
    return root;
  }

  it('passes a clean project', () => {
    const root = project({
      'dist/assets/app.js': `var u="https://x.supabase.co",k="${publishable}";`,
      'src/a.ts': 'export const a = 1;',
      '.env.local': `VITE_BACKEND=supabase\nVITE_SUPABASE_PUBLISHABLE_KEY=${publishable}\n`,
    });
    const result = runScan(root);
    expect(result.problems).toEqual([]);
    rmSync(root, { recursive: true });
  });

  it('fails when a secret key is in the built site', () => {
    const root = project({ 'dist/assets/app.js': `var k="${secret}";` });
    const result = runScan(root);
    expect(result.problems.join('\n')).toMatch(/dist[\\/]assets[\\/]app\.js/);
    expect(result.problems.join('\n')).not.toContain(secret);
    rmSync(root, { recursive: true });
  });

  it('fails when a service role key is pasted into source', () => {
    const root = project({ 'src/oops.ts': `export const key = "${jwt('service_role')}";` });
    expect(runScan(root).problems).toHaveLength(1);
    rmSync(root, { recursive: true });
  });

  it('fails when a VITE_ setting holds a secret or has a secret looking name', () => {
    const root = project({ '.env.local': `VITE_SUPABASE_PUBLISHABLE_KEY=${secret}\nVITE_SERVICE_ROLE_KEY=abc\n` });
    expect(runScan(root).problems.length).toBeGreaterThanOrEqual(2);
    rmSync(root, { recursive: true });
  });

  it('does not mind a secret in a setting that Vite never publishes', () => {
    const root = project({ '.env.local': `SUPABASE_SECRET_KEY=${secret}\n` });
    expect(runScan(root).problems).toEqual([]);
    rmSync(root, { recursive: true });
  });
});
