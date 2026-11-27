import { createRemoteJWKSet, jwtVerify } from 'jose';
import { saveUser, list, put, remove, id } from './store.js';
const base = 'https://oauth2.googleapis.com/token';
const client = () => process.env.GOOGLE_CLIENT_ID || '';
export const redirect = () =>
  `${process.env.APP_URL || 'http://localhost:3000'}/auth/google/callback`;
export const authUrl = (state: string, tasks = false) => {
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.search = new URLSearchParams({
    client_id: client(),
    redirect_uri: redirect(),
    response_type: 'code',
    scope: tasks
      ? 'openid email profile https://www.googleapis.com/auth/tasks'
      : 'openid email profile',
    state,
    access_type: 'offline',
    prompt: tasks ? 'consent' : 'select_account',
    include_granted_scopes: 'true',
  }).toString();
  return u.toString();
};
async function token(params: Record<string, string>) {
  const r = await fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      ...params,
      client_id: client(),
      client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
    }),
  });
  const j: any = await r.json();
  if (!r.ok) throw new Error(j.error || 'Google token error');
  return j;
}
export async function exchange(code: string) {
  const t = await token({
    code,
    redirect_uri: redirect(),
    grant_type: 'authorization_code',
  });
  const { payload } = await jwtVerify(
    t.id_token,
    createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs')),
    {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: client(),
    },
  );
  if (!payload.email_verified || !payload.sub)
    throw new Error('Google email not verified');
  return {
    tokens: t,
    profile: {
      subject: payload.sub,
      name: String(payload.name || payload.email || ''),
      email: String(payload.email || ''),
    },
  };
}
export async function access(user: any) {
  if (!user.googleRefresh) throw new Error('Google Tasks is not connected');
  const t = await token({
    refresh_token: user.googleRefresh,
    grant_type: 'refresh_token',
  });
  return t.access_token as string;
}
export async function googleRequest(
  user: any,
  path: string,
  options: RequestInit = {},
) {
  const t = await access(user);
  const r = await fetch(`https://tasks.googleapis.com/tasks/v1${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${t}`,
      'content-type': 'application/json',
      ...options.headers,
    },
  });
  if (!r.ok) throw new Error(`Google Tasks: ${r.status}`);
  return r.status === 204 ? {} : (r.json() as Promise<any>);
}
export async function syncBoard(user: any, board: any) {
  if (!board.googleListId || !user.googleRefresh) return;
  const items: any[] = [];
  let page = '';
  do {
    const result = await googleRequest(
      user,
      `/lists/${encodeURIComponent(board.googleListId)}/tasks?showCompleted=true&showHidden=true&showDeleted=true&maxResults=100${page ? '&pageToken=' + encodeURIComponent(page) : ''}`,
    );
    items.push(...(result.items || []));
    page = result.nextPageToken || '';
  } while (page);
  const local = await list(user.id, 'tasks');
  for (const g of items) {
    const old = local.find(
      (x: any) => x.boardId === board.id && x.googleId === g.id,
    );
    if (g.deleted) {
      if (old) await remove(user.id, 'tasks', old.id);
      continue;
    }
    const value = {
      ...(old || {
        id: id(),
        boardId: board.id,
        start: null,
        end: null,
        remind: false,
      }),
      title: g.title || '',
      date: g.due?.slice(0, 10) || null,
      done: g.status === 'completed',
      googleId: g.id,
    };
    await put(user.id, 'tasks', value);
  }
}
export async function pushTask(
  user: any,
  board: any,
  task: any,
  method = 'PATCH',
  changes: any = task,
) {
  const path = `/lists/${encodeURIComponent(board.googleListId)}/tasks${task.googleId ? '/' + encodeURIComponent(task.googleId) : ''}`;
  const payload: any = {};
  if (method === 'POST' || Object.hasOwn(changes, 'title'))
    payload.title = task.title;
  if (method === 'POST' || Object.hasOwn(changes, 'done'))
    payload.status = task.done ? 'completed' : 'needsAction';
  if (method === 'POST' || Object.hasOwn(changes, 'date'))
    payload.due = task.date ? `${task.date}T00:00:00.000Z` : null;
  if (!Object.keys(payload).length) return task.googleId;
  const g = await googleRequest(user, path, {
    method,
    body: JSON.stringify(payload),
  });
  return g.id;
}
