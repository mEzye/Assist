import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  init,
  db,
  id,
  list,
  get,
  put,
  remove,
  ensureUser,
  userById,
  saveUser,
  comparePut,
  compareRemove,
} from './store.js';
import {
  authUrl,
  exchange,
  googleRequest,
  syncBoard,
  pushTask,
} from './google.js';
import { startWorker } from './worker.js';
import { lockUser } from './locks.js';

await init();
const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 });
await app.register(cookie);
const secure = process.env.NODE_ENV === 'production';
const cookieOpts = {
  httpOnly: true,
  secure,
  sameSite: 'lax' as const,
  path: '/',
};
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const demoEnabled = process.env.ENABLE_DEMO === 'true';
async function current(req: any) {
  const sid = req.cookies.assist_session;
  if (!sid) return null;
  const r = await db.query('SELECT * FROM sessions WHERE id=$1', [hash(sid)]);
  if (!r.rows[0] || Number(r.rows[0].expires) < Date.now()) return null;
  return userById(r.rows[0].user_id);
}
async function requireUser(req: any, reply: any) {
  const user = await current(req);
  if (!user) {
    reply.code(401).send({ error: 'Sign in required' });
    return null;
  }
  return user;
}
async function login(reply: any, user: any) {
  const sid = randomBytes(32).toString('base64url');
  await db.query(
    'INSERT INTO sessions (id,user_id,expires) VALUES ($1,$2,$3)',
    [hash(sid), user.id, Date.now() + 30 * 86400000],
  );
  reply.setCookie('assist_session', sid, { ...cookieOpts, maxAge: 30 * 86400 });
}
app.addHook('onRequest', async (req, reply) => {
  if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method)) {
    const origin = req.headers.origin;
    const expected =
      process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
    if (origin && origin !== expected)
      return reply.code(403).send({ error: 'Invalid origin' });
  }
});
app.addHook('preHandler', async (req: any) => {
  if (/^\/api\/(workspace|tasks(?:\/|$)|google\/connect)/.test(req.url)) {
    const u = await current(req);
    if (u) req.assistRelease = await lockUser(u.id);
  }
});
app.addHook('onResponse', async (req: any) => {
  req.assistRelease?.();
});
app.get('/api/session', async (req) => {
  const u = await current(req);
  return {
    user: u ? { name: u.name, email: u.email } : null,
    demo: demoEnabled,
    pushKey: process.env.VAPID_PUBLIC_KEY || undefined,
  };
});
app.post('/api/demo', async (_req, reply) => {
  if (!demoEnabled) return reply.code(404).send({ error: 'Not found' });
  const u = await ensureUser('demo', {
    name: 'Демо',
    email: 'demo@assist.local',
  });
  if (!u.demoSeeded) {
    const boards = await list(u.id, 'boards');
    const today = boards[0];
    const work = { id: id(), title: 'Робота', color: '#7c8cf8' };
    const personal = { id: id(), title: 'Особисте', color: '#eab9a4' };
    await put(u.id, 'boards', work);
    await put(u.id, 'boards', personal);
    const date = new Date().toISOString().slice(0, 10);
    const samples = [
      {
        boardId: today.id,
        title: 'Ранкова кава та плани',
        start: 540,
        end: 570,
        done: true,
      },
      {
        boardId: today.id,
        title: 'Зосереджена робота',
        start: 600,
        end: 690,
        done: false,
      },
      {
        boardId: work.id,
        title: 'Командна зустріч',
        start: 720,
        end: 765,
        done: false,
      },
      {
        boardId: personal.id,
        title: 'Прогулянка',
        start: 1020,
        end: 1080,
        done: false,
      },
      {
        boardId: today.id,
        title: 'Підготувати ідеї на завтра',
        start: null,
        end: null,
        done: false,
      },
    ];
    for (const sample of samples)
      await put(u.id, 'tasks', { id: id(), date, remind: false, ...sample });
    await put(u.id, 'notes', {
      id: id(),
      boardId: today.id,
      title: 'Плани на тиждень',
      body: '# Плани на тиждень\n\n- [ ] Завершити важливе\n- [ ] Знайти час на відпочинок\n\nІдеї та нотатки живуть тут.',
      revision: 1,
    });
    u.demoSeeded = true;
    await saveUser(u.id, u);
  }
  await login(reply, u);
  return { ok: true };
});
app.get('/auth/google', async (_req, reply) => {
  if (!process.env.GOOGLE_CLIENT_ID)
    return reply.code(503).send({ error: 'Google sign-in is not configured' });
  const state = randomBytes(24).toString('base64url');
  reply.setCookie('oauth_state', state, { ...cookieOpts, maxAge: 600 });
  reply.setCookie('oauth_kind', 'login', { ...cookieOpts, maxAge: 600 });
  return reply.redirect(authUrl(state));
});
app.get('/auth/tasks', async (req, reply) => {
  const u = await requireUser(req, reply);
  if (!u) return;
  const state = randomBytes(24).toString('base64url');
  reply.setCookie('oauth_state', state, { ...cookieOpts, maxAge: 600 });
  reply.setCookie('oauth_kind', 'tasks', { ...cookieOpts, maxAge: 600 });
  return reply.redirect(authUrl(state, true));
});
app.get('/auth/google/callback', async (req: any, reply) => {
  const { code, state } = req.query;
  if (!code || !state || state !== req.cookies.oauth_state)
    return reply.code(400).send({ error: 'Invalid OAuth state' });
  try {
    const { tokens, profile } = await exchange(code);
    let u = await ensureUser(profile.subject, {
      name: profile.name,
      email: profile.email,
    });
    if (req.cookies.oauth_kind === 'tasks') {
      const signed = await current(req);
      if (!signed || signed.id !== u.id)
        return reply.code(403).send({ error: 'Use the same Google account' });
      if (!tokens.refresh_token && !u.googleRefresh)
        return reply
          .code(400)
          .send({ error: 'Google did not grant offline access' });
      u.googleRefresh = tokens.refresh_token || u.googleRefresh;
      await saveUser(u.id, u);
    } else await login(reply, u);
    reply.clearCookie('oauth_state', { path: '/' });
    reply.clearCookie('oauth_kind', { path: '/' });
    return reply.redirect('/');
  } catch (e: any) {
    req.log.error(e);
    return reply.code(400).send({ error: 'Google authorization failed' });
  }
});
app.all('/auth/logout', async (req: any, reply) => {
  if (req.cookies.assist_session)
    await db.query('DELETE FROM sessions WHERE id=$1', [
      hash(req.cookies.assist_session),
    ]);
  reply.clearCookie('assist_session', { path: '/' });
  return reply.redirect('/');
});
app.get('/api/workspace', async (req, reply) => {
  const u = await requireUser(req, reply);
  if (!u) return;
  const boards = await list(u.id, 'boards');
  if (u.googleRefresh)
    for (const b of boards) {
      try {
        await syncBoard(u, b);
      } catch (e) {
        req.log.warn(e);
      }
    }
  return {
    boards,
    tasks: await list(u.id, 'tasks'),
    notes: await list(u.id, 'notes'),
    googleConnected: !!u.googleRefresh,
  };
});
const allowed: any = {
  boards: ['title', 'color', 'layout'],
  tasks: ['boardId', 'title', 'date', 'start', 'end', 'done', 'remind'],
  notes: ['boardId', 'title', 'body'],
};
function clean(kind: string, b: any) {
  const result: any = {};
  for (const k of allowed[kind]) if (Object.hasOwn(b, k)) result[k] = b[k];
  return result;
}
function valid(kind: string, v: any) {
  if (typeof v.title !== 'string' || v.title.length > 500 || !v.title.trim())
    return false;
  if (
    kind === 'notes' &&
    (typeof v.body !== 'string' || v.body.length > 500000)
  )
    return false;
  if (
    kind === 'tasks' &&
    (!(
      v.date === null ||
      (typeof v.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.date))
    ) ||
      ![v.start, v.end].every(
        (x: any) => x === null || (Number.isInteger(x) && x >= 0 && x < 1440),
      ) ||
      typeof v.done !== 'boolean' ||
      typeof v.remind !== 'boolean')
  )
    return false;
  return true;
}
for (const kind of ['boards', 'tasks', 'notes']) {
  app.post(`/api/${kind}`, async (req: any, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const b = req.body || {};
    let record: any = {
      id: id(),
      ...(kind === 'tasks'
        ? { date: null, start: null, end: null, done: false, remind: false }
        : kind === 'notes'
          ? { body: '', revision: 1 }
          : {}),
      ...clean(kind, b),
    };
    if (!valid(kind, record))
      return reply.code(400).send({ error: 'Invalid record' });
    if (kind !== 'boards' && !(await get(u.id, 'boards', record.boardId)))
      return reply.code(404).send({ error: 'Board not found' });
    if (kind === 'tasks' && b.google) {
      const board = await get(u.id, 'boards', record.boardId);
      if (!board.googleListId || !u.googleRefresh)
        return reply
          .code(400)
          .send({ error: 'Google Tasks is not connected to this board' });
      try {
        record.googleId = await pushTask(u, board, record, 'POST');
      } catch (e) {
        req.log.error(e);
        return reply.code(502).send({ error: 'Google Tasks unavailable' });
      }
    }
    await put(u.id, kind, record);
    return record;
  });
  app.patch(`/api/${kind}/:id`, async (req: any, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const old = await get(u.id, kind, req.params.id);
    if (!old) return reply.code(404).send({ error: 'Not found' });
    const record = { ...old, ...clean(kind, req.body || {}) };
    if (!valid(kind, record))
      return reply.code(400).send({ error: 'Invalid record' });
    if (kind !== 'boards' && !(await get(u.id, 'boards', record.boardId)))
      return reply.code(404).send({ error: 'Board not found' });
    if (kind === 'notes') {
      if (
        req.body?.revision !== undefined &&
        req.body.revision !== old.revision
      )
        return reply.code(409).send({ error: 'Conflict', note: old });
      record.revision = (old.revision || 0) + 1;
    }
    if (kind === 'tasks' && old.googleId) {
      const board = await get(u.id, 'boards', old.boardId);
      if (record.boardId !== old.boardId)
        return reply.code(400).send({ error: 'Cannot move a linked task' });
      try {
        await pushTask(u, board, record, 'PATCH', req.body || {});
      } catch (e) {
        req.log.error(e);
        return reply.code(502).send({ error: 'Google Tasks unavailable' });
      }
    }
    if (kind === 'notes') {
      if (!(await comparePut(u.id, kind, old.id, old, record)))
        return reply
          .code(409)
          .send({ error: 'Conflict', note: await get(u.id, kind, old.id) });
    } else await put(u.id, kind, record);
    return record;
  });
  app.delete(`/api/${kind}/:id`, async (req: any, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const old = await get(u.id, kind, req.params.id);
    if (!old) return reply.code(404).send({ error: 'Not found' });
    if (kind === 'tasks' && old.googleId) {
      const b = await get(u.id, 'boards', old.boardId);
      try {
        await googleRequest(
          u,
          `/lists/${encodeURIComponent(b.googleListId)}/tasks/${encodeURIComponent(old.googleId)}`,
          { method: 'DELETE' },
        );
      } catch (e) {
        req.log.error(e);
        return reply.code(502).send({ error: 'Google Tasks unavailable' });
      }
    }
    if (kind === 'boards')
      for (const k of ['tasks', 'notes'])
        for (const x of await list(u.id, k))
          if (x.boardId === old.id) await remove(u.id, k, x.id);
    await remove(u.id, kind, old.id);
    return {};
  });
}
app.patch('/api/preferences', async (req: any, reply) => {
  const u = await requireUser(req, reply);
  if (!u) return;
  try {
    new Intl.DateTimeFormat('en', { timeZone: req.body?.timeZone });
  } catch {
    return reply.code(400).send({ error: 'Invalid time zone' });
  }
  u.timeZone = req.body.timeZone;
  await saveUser(u.id, u);
  return {};
});
app.get('/api/google/lists', async (req, reply) => {
  const u = await requireUser(req, reply);
  if (!u) return;
  try {
    const r = await googleRequest(u, '/users/@me/lists?maxResults=100');
    return {
      lists: (r.items || []).map((x: any) => ({ id: x.id, title: x.title })),
    };
  } catch {
    return reply.code(502).send({ error: 'Google Tasks unavailable' });
  }
});
app.post('/api/google/connect', async (req: any, reply) => {
  const u = await requireUser(req, reply);
  if (!u) return;
  const b = await get(u.id, 'boards', req.body?.boardId);
  if (!b) return reply.code(404).send({ error: 'Board not found' });
  try {
    const r = await googleRequest(u, '/users/@me/lists?maxResults=100');
    if (!r.items?.some((x: any) => x.id === req.body?.listId))
      return reply.code(400).send({ error: 'List not found' });
    b.googleListId = req.body.listId;
    await put(u.id, 'boards', b);
    await syncBoard(u, b);
    return b;
  } catch {
    return reply.code(502).send({ error: 'Google Tasks unavailable' });
  }
});
app.post('/api/push', async (req: any, reply) => {
  const u = await requireUser(req, reply);
  if (!u) return;
  const s = req.body;
  if (!s?.endpoint || !s?.keys?.p256dh || !s?.keys?.auth)
    return reply.code(400).send({ error: 'Invalid subscription' });
  try {
    const endpoint = new URL(s.endpoint);
    if (
      endpoint.protocol !== 'https:' ||
      ![
        'fcm.googleapis.com',
        'updates.push.services.mozilla.com',
        'web.push.apple.com',
        'notify.windows.com',
      ].some(
        (host) =>
          endpoint.hostname === host || endpoint.hostname.endsWith('.' + host),
      )
    )
      throw new Error();
  } catch {
    return reply.code(400).send({ error: 'Invalid push endpoint' });
  }
  await put(u.id, 'subscriptions', { id: hash(s.endpoint), subscription: s });
  return {};
});
app.post('/api/obsidian/pair', async (req: any, reply) => {
  const u = await requireUser(req, reply);
  if (!u) return;
  const b = await get(u.id, 'boards', req.body?.boardId);
  if (!b) return reply.code(404).send({ error: 'Board not found' });
  const code = randomBytes(6).toString('hex').toUpperCase();
  await db.query(
    'INSERT INTO pair_codes (code,user_id,board_id,expires) VALUES ($1,$2,$3,$4)',
    [hash(code), u.id, b.id, Date.now() + 600000],
  );
  return { code };
});
app.post('/api/obsidian/claim', async (req: any, reply) => {
  const code = String(req.body?.code || '').toUpperCase();
  const r = await db.query('DELETE FROM pair_codes WHERE code=$1 RETURNING *', [
    hash(code),
  ]);
  const p = r.rows[0];
  if (!p || Number(p.expires) < Date.now())
    return reply.code(400).send({ error: 'Invalid or expired code' });
  const token = randomBytes(32).toString('base64url');
  await db.query(
    'INSERT INTO devices (token,user_id,board_id) VALUES ($1,$2,$3)',
    [hash(token), p.user_id, p.board_id],
  );
  return { token, boardId: p.board_id };
});
async function device(req: any, reply: any) {
  const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
  const r = await db.query('SELECT * FROM devices WHERE token=$1', [
    hash(token),
  ]);
  if (!r.rows[0]) {
    reply.code(401).send({ error: 'Invalid device' });
    return null;
  }
  return r.rows[0];
}
app.get('/api/obsidian/notes', async (req, reply) => {
  const d = await device(req, reply);
  if (!d) return;
  return {
    notes: (await list(d.user_id, 'notes')).filter(
      (n: any) => n.boardId === d.board_id,
    ),
  };
});
app.post('/api/obsidian/notes', async (req: any, reply) => {
  const d = await device(req, reply);
  if (!d) return;
  const n = {
    id: id(),
    boardId: d.board_id,
    title: req.body?.title,
    body: req.body?.body,
    revision: 1,
  };
  if (!valid('notes', n))
    return reply.code(400).send({ error: 'Invalid note' });
  return put(d.user_id, 'notes', n);
});
app.patch('/api/obsidian/notes/:id', async (req: any, reply) => {
  const d = await device(req, reply);
  if (!d) return;
  const n = await get(d.user_id, 'notes', req.params.id);
  if (!n || n.boardId !== d.board_id)
    return reply.code(404).send({ error: 'Not found' });
  if (n.revision !== req.body?.revision)
    return reply.code(409).send({ error: 'Conflict', note: n });
  const updated = {
    ...n,
    title: req.body.title,
    body: req.body.body,
    revision: n.revision + 1,
  };
  if (!valid('notes', updated))
    return reply.code(400).send({ error: 'Invalid note' });
  if (!(await comparePut(d.user_id, 'notes', n.id, n, updated)))
    return reply
      .code(409)
      .send({ error: 'Conflict', note: await get(d.user_id, 'notes', n.id) });
  return updated;
});
app.delete('/api/obsidian/notes/:id', async (req: any, reply) => {
  const d = await device(req, reply);
  if (!d) return;
  const n = await get(d.user_id, 'notes', req.params.id);
  if (!n || n.boardId !== d.board_id)
    return reply.code(404).send({ error: 'Not found' });
  if (Number(req.query?.revision) !== n.revision)
    return reply.code(409).send({ error: 'Conflict', note: n });
  if (!(await compareRemove(d.user_id, 'notes', n.id, n)))
    return reply
      .code(409)
      .send({ error: 'Conflict', note: await get(d.user_id, 'notes', n.id) });
  return {};
});
const dist = resolve('dist/client');
if (existsSync(dist)) {
  await app.register(fastifyStatic, { root: dist });
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith('/api/')
      ? reply.code(404).send({ error: 'Not found' })
      : reply.sendFile('index.html'),
  );
}
startWorker();
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT || 3000) });
