import pg from 'pg';
import { newDb } from 'pg-mem';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';

const secret = process.env.APP_SECRET || 'development-only-change-me';
if (
  process.env.NODE_ENV === 'production' &&
  (!process.env.APP_SECRET || secret.length < 32)
)
  throw new Error('APP_SECRET must be at least 32 characters');
const key = createHash('sha256').update(secret).digest();
export function seal(value: unknown) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(value)), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]).toString('base64url');
}
export function open<T = any>(value: string): T {
  const b = Buffer.from(value, 'base64url');
  const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([d.update(b.subarray(28)), d.final()]).toString(),
  );
}
const mem = !process.env.DATABASE_URL;
if (mem && process.env.NODE_ENV === 'production')
  throw new Error('DATABASE_URL is required in production');
const Pool = mem ? newDb().adapters.createPg().Pool : pg.Pool;
export const db = new Pool(
  mem ? {} : { connectionString: process.env.DATABASE_URL },
);
export const id = () => randomUUID();
export async function init() {
  await db.query(
    `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, subject TEXT UNIQUE NOT NULL, data TEXT NOT NULL)`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires BIGINT NOT NULL)`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL)`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS records_owner ON records (user_id, kind)`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS pair_codes (code TEXT PRIMARY KEY, user_id TEXT NOT NULL, board_id TEXT NOT NULL, expires BIGINT NOT NULL)`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS devices (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, board_id TEXT NOT NULL)`,
  );
}
export async function userById(uid: string) {
  const r = await db.query('SELECT * FROM users WHERE id=$1', [uid]);
  return r.rows[0] ? { id: uid, ...open<any>(r.rows[0].data) } : null;
}
export async function saveUser(uid: string, data: any) {
  const { id: _, ...rest } = data;
  await db.query('UPDATE users SET data=$1 WHERE id=$2', [seal(rest), uid]);
}
export async function list(uid: string, kind: string) {
  const r = await db.query(
    'SELECT id,data FROM records WHERE user_id=$1 AND kind=$2',
    [uid, kind],
  );
  return r.rows.map((x: any) => ({ id: x.id, ...open<any>(x.data) }));
}
export async function get(uid: string, kind: string, rid: string) {
  const r = await db.query(
    'SELECT data FROM records WHERE user_id=$1 AND kind=$2 AND id=$3',
    [uid, kind, rid],
  );
  return r.rows[0] ? { id: rid, ...open<any>(r.rows[0].data) } : null;
}
export async function put(uid: string, kind: string, value: any) {
  const { id: rid, ...data } = value;
  const current = await get(uid, kind, rid);
  if (current)
    await db.query(
      'UPDATE records SET data=$1 WHERE user_id=$2 AND kind=$3 AND id=$4',
      [seal(data), uid, kind, rid],
    );
  else
    await db.query(
      'INSERT INTO records (id,user_id,kind,data) VALUES ($1,$2,$3,$4)',
      [rid, uid, kind, seal(data)],
    );
  return value;
}
export async function remove(uid: string, kind: string, rid: string) {
  await db.query('DELETE FROM records WHERE user_id=$1 AND kind=$2 AND id=$3', [
    uid,
    kind,
    rid,
  ]);
}
export async function ensureUser(subject: string, profile: any) {
  let r = await db.query('SELECT * FROM users WHERE subject=$1', [subject]);
  if (r.rows[0]) return userById(r.rows[0].id);
  const uid = id();
  await db.query('INSERT INTO users (id,subject,data) VALUES ($1,$2,$3)', [
    uid,
    subject,
    seal({ ...profile, timeZone: 'UTC' }),
  ]);
  await put(uid, 'boards', { id: id(), title: 'Сьогодні', color: '#7c8cf8' });
  return userById(uid);
}
// Compare the exact encrypted value so concurrent changes cannot be silently overwritten.
export async function comparePut(
  uid: string,
  kind: string,
  rid: string,
  old: any,
  next: any,
) {
  const row = await db.query(
    'SELECT data FROM records WHERE user_id=$1 AND kind=$2 AND id=$3',
    [uid, kind, rid],
  );
  if (!row.rows[0]) return false;
  const current = { id: rid, ...open<any>(row.rows[0].data) };
  if (JSON.stringify(current) !== JSON.stringify(old)) return false;
  const { id: _, ...data } = next;
  const r = await db.query(
    'UPDATE records SET data=$1 WHERE user_id=$2 AND kind=$3 AND id=$4 AND data=$5 RETURNING id',
    [seal(data), uid, kind, rid, row.rows[0].data],
  );
  return !!r.rows.length;
}
export async function compareRemove(
  uid: string,
  kind: string,
  rid: string,
  old: any,
) {
  const row = await db.query(
    'SELECT data FROM records WHERE user_id=$1 AND kind=$2 AND id=$3',
    [uid, kind, rid],
  );
  if (
    !row.rows[0] ||
    JSON.stringify({ id: rid, ...open<any>(row.rows[0].data) }) !==
      JSON.stringify(old)
  )
    return false;
  const r = await db.query(
    'DELETE FROM records WHERE user_id=$1 AND kind=$2 AND id=$3 AND data=$4 RETURNING id',
    [uid, kind, rid, row.rows[0].data],
  );
  return !!r.rows.length;
}
