export type Board = {
  id: string;
  title: string;
  color: string;
  layout?: Record<string, unknown>;
};
export type Task = {
  id: string;
  boardId: string;
  title: string;
  date: string | null;
  start: number | null;
  end: number | null;
  done: boolean;
  remind: boolean;
  googleId?: string | null;
};
export type Note = {
  id: string;
  boardId: string;
  title: string;
  body: string;
  revision?: number;
};
export type Workspace = {
  boards: Board[];
  tasks: Task[];
  notes: Note[];
  googleConnected: boolean;
};
export type Session = {
  user: { name: string; email: string } | null;
  demo: boolean;
  pushKey?: string;
};
export type TaskDraft = Omit<Task, 'id' | 'googleId'> & { google?: boolean };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  method = 'GET',
  data?: unknown,
): Promise<T> {
  const response = await fetch('/api' + path, {
    method,
    headers:
      data === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      response.status,
      result?.message || result?.error || 'Не вдалося виконати дію.',
    );
  return result as T;
}

export function dateKey(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}
export const localDate = (key: string) => new Date(key + 'T12:00:00');
export const moveDay = (key: string, delta: number) => {
  const date = localDate(key);
  date.setDate(date.getDate() + delta);
  return dateKey(date);
};
export const clockText = (minutes: number) =>
  String(Math.floor(minutes / 60)).padStart(2, '0') +
  ':' +
  String(minutes % 60).padStart(2, '0');

export function timeValue(value: string) {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

export const TIMELINE_SCALE = 1.65;

export function taskWidth(task: Task) {
  if (task.start === null || task.end === null || task.end === task.start)
    return 139;
  return Math.max(36, (task.end - task.start) * TIMELINE_SCALE - 3);
}

export function lanesFor(tasks: Task[]) {
  const occupiedUntil: number[] = [];
  const sorted = tasks
    .filter((task) => task.start !== null)
    .sort(
      (a, b) =>
        a.start! - b.start! ||
        (b.end ?? b.start!) - (a.end ?? a.start!) ||
        a.id.localeCompare(b.id),
    );
  const entries = sorted.map((task) => {
    const start = task.start!;
    let lane = occupiedUntil.findIndex((until) => until <= start);
    if (lane < 0) lane = occupiedUntil.length;
    occupiedUntil[lane] = start + (taskWidth(task) + 3) / TIMELINE_SCALE;
    return { task, lane };
  });
  return { entries, count: Math.max(2, occupiedUntil.length) };
}
