import * as webpush from 'web-push';
import { comparePut, db, list, remove, userById } from './store.js';
import { syncBoard } from './google.js';
import { lockUser } from './locks.js';

async function syncGoogle() {
  const users = await db.query('SELECT id FROM users');
  for (const { id } of users.rows) {
    const release = await lockUser(id);
    try {
      const user = await userById(id);
      if (!user?.googleRefresh) continue;
      for (const board of await list(id, 'boards')) {
        try {
          await syncBoard(user, board);
        } catch (error) {
          console.error('Google sync:', error);
        }
      }
    } finally {
      release();
    }
  }
}

async function reminders() {
  const users = await db.query('SELECT id FROM users');
  for (const { id } of users.rows) {
    const user = await userById(id);
    if (!user) continue;
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: user.timeZone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    const parts = Object.fromEntries(
      formatter
        .formatToParts(new Date())
        .map((part) => [part.type, part.value]),
    );
    const today = parts.year + '-' + parts.month + '-' + parts.day;
    const minutes = Number(parts.hour) * 60 + Number(parts.minute);
    const subscriptions = await list(id, 'subscriptions');
    if (!subscriptions.length) continue;
    for (const task of await list(id, 'tasks')) {
      if (
        !task.remind ||
        task.done ||
        task.googleId ||
        !task.date ||
        task.start === null
      )
        continue;
      const due = task.date + ':' + task.start;
      if (
        task.notifiedFor === due ||
        task.date > today ||
        (task.date === today && minutes < task.start)
      )
        continue;
      const sent = new Set<string>(
        task.notifiedProgress?.due === due
          ? task.notifiedProgress.subscriptions
          : [],
      );
      for (const item of subscriptions) {
        if (sent.has(item.id)) continue;
        try {
          await webpush.sendNotification(
            item.subscription,
            JSON.stringify({
              title: 'Нагадування',
              body: task.title,
              tag: task.id + ':' + due,
            }),
            { timeout: 8000 },
          );
          sent.add(item.id);
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            await remove(id, 'subscriptions', item.id);
            sent.add(item.id);
          }
        }
      }
      const complete = subscriptions.every((item: { id: string }) =>
        sent.has(item.id),
      );
      await comparePut(id, 'tasks', task.id, task, {
        ...task,
        notifiedFor: complete ? due : task.notifiedFor,
        notifiedProgress: complete ? null : { due, subscriptions: [...sent] },
      });
    }
  }
}

function schedule(label: string, work: () => Promise<void>) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await work();
    } catch (error) {
      console.error(label, error);
    } finally {
      running = false;
    }
  };
  void tick();
  setInterval(tick, 60000).unref();
}

export function startWorker() {
  schedule('Google sync:', syncGoogle);
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
  schedule('Reminder worker:', reminders);
}
