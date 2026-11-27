const tails = new Map<string, Promise<void>>();
export async function lockUser(id: string) {
  const previous = tails.get(id) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  tails.set(id, tail);
  await previous;
  return () => {
    release();
    if (tails.get(id) === tail) tails.delete(id);
  };
}
