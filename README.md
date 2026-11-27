# Assist

Дошки для щоденних справ, таймлайн і Markdown-замітки. Сайт і фонові завдання працюють на одному сервері.

## Локальний запуск

Потрібен Node.js 22 або новіший.

```sh
npm ci
npm run build
ENABLE_DEMO=true APP_URL=http://localhost:3000 npm run server
```

Відкрий `http://localhost:3000` і вибери демоверсію. Локальний режим без PostgreSQL зберігає дані в пам’яті. Демоверсія використовує спільний тестовий акаунт, тому в production її слід вимкнути.

Для змін фронтенду запускай API з `PORT=3001 APP_URL=http://localhost:3000 ENABLE_DEMO=true npm run server`, а Vite — через `npm run dev` в окремому терміналі.

## Постійний сервер

1. Скопіюй `.env.example` у `.env` і задай HTTPS-адресу, випадковий `APP_SECRET` та пароль PostgreSQL. Використовуй зашифрований диск і резервні копії для даних сервера.
2. У Google Cloud створи OAuth-клієнт для вебзастосунку. Зареєструй перенаправлення на `/auth/google/callback` на своєму домені. Увімкни Google Tasks API. Пройди потрібну перевірку доступу Google перед публічним підключенням Tasks.
3. Згенеруй ключі Web Push через `npx web-push generate-vapid-keys` і заповни змінні `VAPID_*`.
4. Запусти `docker compose up -d --build`. Налаштуй HTTPS-проксі до порту 3000. Запускай один екземпляр застосунку. Фонові завдання запускаються разом із ним.

## Obsidian

Виконай `npm run build:obsidian`. Скопіюй файли з `dist/obsidian` у папку `.obsidian/plugins/assist-sync` свого vault та увімкни плагін. У налаштуваннях Assist створи код прив’язки для вибраної дошки. У плагіні введи HTTPS-адресу Assist, код і шлях до папки заміток у vault. Резервна копія папки допоможе перевірити першу синхронізацію на твоїх файлах.

## Перевірки

```sh
npm run typecheck
npm run build
npm run build:obsidian
node --check obsidian/main.js
```
