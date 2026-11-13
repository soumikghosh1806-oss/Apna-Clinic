// Starts a throwaway Postgres, rebuilds the schema the connected project already had, applies the Cliniq migrations
// in order, and gives tests a way to act as a signed in user, the public, or the server, the way the API does.
//
// Nothing here touches a real Supabase project.

import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PASSWORD = 'pw';

export const MIGRATIONS_DIR = path.join(here, '..', 'migrations');

export function migrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

export async function startDb({ port = 54340, withMigrations = true } = {}) {
  const dir = `/tmp/cliniq-pgdata-${process.pid}-${port}`;
  fs.rmSync(dir, { recursive: true, force: true });
  const server = new EmbeddedPostgres({
    databaseDir: dir, user: 'postgres', password: PASSWORD, port, persistent: false, onLog: () => {}, onError: () => {},
    // A hosted Supabase database is UTF8. Without this the local one would be plain ASCII and names in other scripts would break.
    initdbFlags: ['--encoding=UTF8', '--locale=C.UTF-8'],
  });
  await server.initialise();
  await server.start();
  await server.createDatabase('cliniq');

  const connect = async () => {
    const c = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', password: PASSWORD, database: 'cliniq' });
    await c.connect();
    return c;
  };
  const admin = await connect();

  const run = (file) => fs.readFileSync(file, 'utf8');
  await admin.query(run(path.join(here, 'fixtures', '00_supabase_shim.sql')));
  await admin.query(run(path.join(here, 'fixtures', '01_existing_project_schema.sql')));

  const applied = [];
  if (withMigrations) {
    for (const f of migrationFiles()) {
      await admin.query(run(path.join(MIGRATIONS_DIR, f)));
      applied.push(f);
    }
    // Tests move the clock through this table. Production's private.clock() is plain now().
    await admin.query(`
      create table private.test_clock (now timestamptz);
      create or replace function private.clock() returns timestamptz language sql stable set search_path = '' as
        $$ select coalesce((select t.now from private.test_clock t limit 1), now()) $$;
    `);
  }

  async function withRole(role, uid, fn) {
    const c = await connect();
    try {
      await c.query('begin');
      await c.query(`set local role ${role}`);
      const claims = JSON.stringify(uid ? { sub: uid, role } : { role });
      await c.query(`select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true), set_config('request.jwt.claim.role', $3, true)`,
        [claims, uid ?? '', role]);
      const result = await fn(c);
      await c.query('commit');
      return result;
    } catch (error) {
      await c.query('rollback').catch(() => {});
      throw error;
    } finally {
      await c.end();
    }
  }

  const toParam = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v);

  /** Calls public.<fn> with named arguments, as PostgREST does. */
  async function rpc(who, fn, args = {}) {
    const keys = Object.keys(args);
    const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
    return withRole(who.role, who.uid, async (c) => (await c.query(sql, keys.map((k) => toParam(args[k])))).rows[0].r);
  }

  /** Runs a query as that user. Returns the rows. */
  async function query(who, sql, params = []) {
    return withRole(who.role, who.uid, async (c) => (await c.query(sql, params)).rows);
  }

  const as = (uid) => ({ role: 'authenticated', uid });
  const anon = { role: 'anon', uid: null };
  const service = { role: 'service_role', uid: null };

  async function createUser(email, fullName) {
    const r = await admin.query('insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id', [
      email, JSON.stringify(fullName ? { full_name: fullName } : {}),
    ]);
    return r.rows[0].id;
  }

  async function setNow(iso) {
    await admin.query('delete from private.test_clock');
    if (iso) await admin.query('insert into private.test_clock (now) values ($1)', [iso]);
  }

  async function stop() {
    await admin.end().catch(() => {});
    await server.stop().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return { admin, connect, rpc, query, as, anon, service, createUser, setNow, stop, applied, withRole };
}

/** Runs a promise that should fail and returns the database error. Fails the test if it succeeds. */
export async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the database to refuse this, but it succeeded.');
}
