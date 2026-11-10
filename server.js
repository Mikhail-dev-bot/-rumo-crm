require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');
const A = require('./auth');
const acc = require('./access');

const app = express();
app.set('trust proxy', 1); // за прокси Render, чтобы req.ip был настоящим адресом
app.use(cors()); // разрешаем запросы с других доменов (Snack.expo и т.д.)
app.use(express.json({ limit: '12mb' })); // большой лимит нужен для загрузки фото (base64)
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const MASTER_KEY = process.env.RUMO_MASTER_KEY;
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error('ВНИМАНИЕ: JWT_SECRET не задан. Вход отключён, весь /api закрыт (503).');
}

// Сущности, которые отдаются через общий CRUD. Бин users сюда НЕ входит: в нём хэши паролей.
const ENTITIES = ['bookings', 'orders', 'parts', 'services', 'clients', 'cars'];
const BINS = {
  bookings: process.env.BIN_BOOKINGS,
  orders: process.env.BIN_ORDERS,
  parts: process.env.BIN_PARTS,
  services: process.env.BIN_SERVICES,
  clients: process.env.BIN_CLIENTS,
  cars: process.env.BIN_CARS,
  users: process.env.BIN_USERS,
};

const jsonbin = axios.create({
  baseURL: process.env.JSONBIN_BASE_URL || 'https://api.jsonbin.io/v3',
  headers: { 'X-Master-Key': MASTER_KEY, 'Content-Type': 'application/json' },
});

async function readBin(binId) {
  const { data } = await jsonbin.get(`/b/${binId}/latest`);
  return data.record;
}

async function writeBin(binId, record) {
  const { data } = await jsonbin.put(`/b/${binId}`, record);
  return data.record;
}

// Простой in-memory кэш, чтобы не дёргать JSONBin на каждый чих
// (у бесплатного плана JSONBin есть лимит запросов в минуту)
const cache = new Map();
const CACHE_TTL_MS = 15_000;

async function getEntity(name) {
  const binId = BINS[name];
  if (!binId) throw new Error(`BIN_${name.toUpperCase()} не задан в переменных окружения`);
  const cached = cache.get(name);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;
  const record = await readBin(binId);
  const list = Array.isArray(record) ? record : record[name] || [];
  cache.set(name, { at: Date.now(), data: list });
  return list;
}

async function saveEntity(name, list) {
  await writeBin(BINS[name], list);
  cache.set(name, { at: Date.now(), data: list });
  return list;
}

const nextId = (list) => (list.length ? Math.max(...list.map((i) => Number(i.id) || 0)) + 1 : 1);
const fail = (res, e) => res.status(500).json({ error: e.message });
const publicUser = (u) => ({ id: u.id, name: u.name, role: u.role, clientId: u.clientId || null });

// ═══════════════ Авторизация ═══════════════

const limiter = A.makeRateLimiter(10, 15 * 60 * 1000);
let DUMMY_HASH; // чтобы время ответа не выдавало, существует ли такой логин
A.hashPassword('dummy-password').then((h) => { DUMMY_HASH = h; });

app.post('/api/auth/login', async (req, res) => {
  try {
    if (!JWT_SECRET || !BINS.users) {
      return res.status(503).json({ error: 'Авторизация не настроена на сервере' });
    }
    const login = A.normLogin(req.body && req.body.login);
    const password = req.body && req.body.password;
    if (!login || typeof password !== 'string' || !password) {
      return res.status(400).json({ error: 'Введите логин и пароль' });
    }
    const key = `${req.ip}|${login}`;
    if (limiter.blocked(key)) {
      return res.status(429).json({ error: 'Слишком много попыток, попробуйте через 15 минут' });
    }
    const users = await getEntity('users');
    const user = users.find((u) => A.normLogin(u.login) === login);
    const ok = await A.checkPassword(password, user ? user.passHash : DUMMY_HASH);
    if (!user || !ok) {
      limiter.fail(key);
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }
    limiter.reset(key);
    res.json({ token: A.signToken({ sub: user.id }, JWT_SECRET), user: publicUser(user) });
  } catch (e) { fail(res, e); }
});

// Всё остальное под /api требует токен. Роль берём из базы, а не из токена:
// удалённый пользователь или смена роли действуют сразу.
async function requireAuth(req, res, next) {
  try {
    if (!JWT_SECRET || !BINS.users) {
      return res.status(503).json({ error: 'Авторизация не настроена на сервере' });
    }
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    const payload = m && A.verifyToken(m[1], JWT_SECRET);
    if (!payload) return res.status(401).json({ error: 'Требуется вход' });
    const users = await getEntity('users');
    const user = users.find((u) => String(u.id) === String(payload.sub));
    if (!user) return res.status(401).json({ error: 'Требуется вход' });
    req.user = user;
    next();
  } catch (e) { fail(res, e); }
}
app.use('/api', requireAuth);

const requireRole = (...roles) => (req, res, next) => (
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Недостаточно прав' })
);

app.get('/api/auth/me', (req, res) => res.json(publicUser(req.user)));

app.post('/api/auth/password', async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body || {};
    if (typeof newPassword !== 'string' || newPassword.length < 6) {
      return res.status(400).json({ error: 'Новый пароль: не короче 6 символов' });
    }
    if (!(await A.checkPassword(String(oldPassword || ''), req.user.passHash))) {
      return res.status(401).json({ error: 'Старый пароль неверен' });
    }
    const users = [...(await getEntity('users'))];
    const idx = users.findIndex((u) => String(u.id) === String(req.user.id));
    users[idx] = { ...users[idx], passHash: await A.hashPassword(newPassword) };
    await saveEntity('users', users);
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// ── Управление пользователями: только мастер ──
app.get('/api/users', requireRole('master'), async (req, res) => {
  try { res.json((await getEntity('users')).map(publicUser)); } catch (e) { fail(res, e); }
});

app.post('/api/users', requireRole('master'), async (req, res) => {
  try {
    const { login, password, name, role, clientId } = req.body || {};
    if (!['client', 'mechanic', 'master'].includes(role)) {
      return res.status(400).json({ error: 'Роль: client, mechanic или master' });
    }
    if (!A.normLogin(login) || !name) return res.status(400).json({ error: 'Укажите логин и имя' });
    if (typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ error: 'Пароль: не короче 6 символов' });
    }
    const users = [...(await getEntity('users'))];
    if (users.some((u) => A.normLogin(u.login) === A.normLogin(login))) {
      return res.status(409).json({ error: 'Такой логин уже есть' });
    }
    if (role === 'client') {
      const clients = await getEntity('clients');
      if (!clients.some((c) => Number(c.id) === Number(clientId))) {
        return res.status(400).json({ error: 'Для клиента укажите существующий clientId' });
      }
    }
    const user = {
      id: nextId(users), login: A.normLogin(login), name: String(name), role,
      clientId: role === 'client' ? Number(clientId) : null,
      passHash: await A.hashPassword(password),
    };
    users.push(user);
    await saveEntity('users', users);
    res.status(201).json(publicUser(user));
  } catch (e) { fail(res, e); }
});

app.post('/api/users/:id/password', requireRole('master'), async (req, res) => {
  try {
    const { password } = req.body || {};
    if (typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ error: 'Пароль: не короче 6 символов' });
    }
    const users = [...(await getEntity('users'))];
    const idx = users.findIndex((u) => String(u.id) === String(req.params.id));
    if (idx === -1) return res.status(404).json({ error: 'Пользователь не найден' });
    users[idx] = { ...users[idx], passHash: await A.hashPassword(password) };
    await saveEntity('users', users);
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

app.delete('/api/users/:id', requireRole('master'), async (req, res) => {
  try {
    if (String(req.params.id) === String(req.user.id)) {
      return res.status(400).json({ error: 'Нельзя удалить самого себя' });
    }
    const users = (await getEntity('users')).filter((u) => String(u.id) !== String(req.params.id));
    await saveEntity('users', users);
    res.status(204).end();
  } catch (e) { fail(res, e); }
});

// ═══════════════ Данные: общий CRUD с правами по ролям ═══════════════

const pick = (obj, keys) => {
  const out = {};
  keys.forEach((k) => { if (obj && obj[k] !== undefined) out[k] = obj[k]; });
  return out;
};

for (const name of ENTITIES) {
  const guard = (req, res, next) => (
    acc.can(req.user.role, name, req.method)
      ? next()
      : res.status(403).json({ error: 'Недостаточно прав' })
  );

  app.get(`/api/${name}`, guard, async (req, res) => {
    try {
      const list = await getEntity(name);
      const cars = req.user.role === 'client' ? await getEntity('cars') : [];
      res.json(acc.scopeList(req.user, name, list, cars));
    } catch (e) { fail(res, e); }
  });

  app.post(`/api/${name}`, guard, async (req, res) => {
    try {
      let data = req.body || {};
      if (req.user.role === 'client') {
        const [clients, cars] = await Promise.all([getEntity('clients'), getEntity('cars')]);
        const client = clients.find((c) => Number(c.id) === Number(req.user.clientId));
        const myCars = cars.filter((c) => Number(c.clientId) === Number(req.user.clientId));
        const r = name === 'bookings'
          ? acc.sanitizeClientBooking(data, req.user, client, myCars)
          : acc.sanitizeClientCar(data, req.user);
        if (r.error) return res.status(400).json({ error: r.error });
        data = r.value;
      }
      const list = [...(await getEntity(name))];
      const item = { ...data, id: nextId(list) }; // id всегда назначает сервер
      list.push(item);
      await saveEntity(name, list);

      // Новый автомобиль сразу привязываем к владельцу
      if (name === 'cars' && item.clientId != null) {
        const clients = [...(await getEntity('clients'))];
        const ci = clients.findIndex((c) => Number(c.id) === Number(item.clientId));
        if (ci !== -1) {
          clients[ci] = { ...clients[ci], cars: [...(clients[ci].cars || []), item.id] };
          await saveEntity('clients', clients);
        }
      }
      res.status(201).json(item);
    } catch (e) { fail(res, e); }
  });

  app.patch(`/api/${name}/:id`, guard, async (req, res) => {
    try {
      const list = [...(await getEntity(name))];
      const idx = list.findIndex((i) => String(i.id) === String(req.params.id));
      if (idx === -1) return res.status(404).json({ error: 'Not found' });
      // механик может менять у заказа только статус
      const body = req.user.role === 'mechanic' ? pick(req.body, ['status']) : (req.body || {});
      list[idx] = { ...list[idx], ...body, id: list[idx].id };
      await saveEntity(name, list);
      res.json(list[idx]);
    } catch (e) { fail(res, e); }
  });

  app.delete(`/api/${name}/:id`, guard, async (req, res) => {
    try {
      const list = (await getEntity(name)).filter((i) => String(i.id) !== String(req.params.id));
      await saveEntity(name, list);
      res.status(204).end();
    } catch (e) { fail(res, e); }
  });
}

// ── Приложение механика передаёт результаты диагностики сюда ──
// Обновляет заказ (orders) полями findings/recommendations и статусом.
// Имя механика и время берутся на сервере, а не из запроса.
app.post('/api/orders/:id/diagnostics', requireRole('mechanic', 'master'), async (req, res) => {
  try {
    const findings = acc.sanitizeFindings(req.body && req.body.findings);
    if (findings.length === 0) return res.status(400).json({ error: 'Нет данных диагностики' });
    const recommendations = acc.normalizeRecommendations(
      findings.filter((f) => f.status !== 'Норма' && f.status !== 'OK')
    );
    const orders = [...(await getEntity('orders'))];
    const idx = orders.findIndex((o) => String(o.id) === String(req.params.id));
    if (idx === -1) return res.status(404).json({ error: 'Заказ не найден' });

    const now = new Date().toISOString();
    orders[idx] = {
      ...orders[idx],
      mechanic: req.user.name,
      findings,
      recommendations,
      diagnosticsSubmittedAt: now,
      date: orders[idx].date || now.slice(0, 10),
      status: 'Диагностика завершена',
    };
    await saveEntity('orders', orders);
    res.json(orders[idx]);
  } catch (e) { fail(res, e); }
});

// ── Аналитика для дашборда CRM: только мастер ──
app.get('/api/analytics/today', requireRole('master'), async (req, res) => {
  try {
    const [orders, bookings, clients] = await Promise.all([
      getEntity('orders'),
      getEntity('bookings'),
      getEntity('clients'),
    ]);
    const today = new Date().toISOString().slice(0, 10);

    const needsAttention = orders.filter((o) =>
      (o.recommendations || []).some(
        (r) => !r.completed && (r.priority === 'high' || r.status === 'Требует внимания')
      )
    ).length;

    const newDiagnostics = orders.filter(
      (o) => o.diagnosticsSubmittedAt && o.diagnosticsSubmittedAt.slice(0, 10) === today
    ).length;
    const incompleteRecommendations = orders.reduce(
      (sum, o) => sum + (o.recommendations || []).filter((r) => !r.completed).length,
      0
    );
    const todaysBookings = bookings.filter((b) => b.date === today).length;

    res.json({
      clientsNeedAttention: needsAttention,
      newDiagnosticsToday: newDiagnostics,
      incompleteRecommendations,
      todaysBookings,
      totalClients: clients.length,
    });
  } catch (e) { fail(res, e); }
});

// ── Загрузка фото диагностики в Cloudinary ──
// Ключи Cloudinary живут только в переменных окружения сервера (Render -> Environment):
// CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET.
// Приложение присылает картинку как data URI (base64), сервер подписывает запрос и
// возвращает постоянную ссылку, которую уже можно хранить в заказе.
const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUD_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUD_SECRET = process.env.CLOUDINARY_API_SECRET;
const MAX_UPLOAD_CHARS = 10 * 1024 * 1024; // ~7 МБ картинки в base64

app.post('/api/upload', requireRole('mechanic', 'master'), async (req, res) => {
  try {
    if (!CLOUD_NAME || !CLOUD_KEY || !CLOUD_SECRET) {
      return res.status(503).json({ error: 'Cloudinary не настроен на сервере' });
    }
    const { image } = req.body || {};
    if (typeof image !== 'string' || !/^data:image\/(jpeg|jpg|png|webp);base64,/.test(image)) {
      return res.status(400).json({ error: 'Ожидается картинка в формате data URI (base64)' });
    }
    if (image.length > MAX_UPLOAD_CHARS) {
      return res.status(413).json({ error: 'Файл слишком большой' });
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const folder = 'rumo/diagnostics';
    // Подпись Cloudinary: параметры по алфавиту + секрет, SHA-1
    const signature = crypto
      .createHash('sha1')
      .update(`folder=${folder}&timestamp=${timestamp}${CLOUD_SECRET}`)
      .digest('hex');

    const form = new FormData();
    form.append('file', image);
    form.append('api_key', CLOUD_KEY);
    form.append('timestamp', String(timestamp));
    form.append('folder', folder);
    form.append('signature', signature);

    const r = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`, {
      method: 'POST',
      body: form,
    });
    const data = await r.json();
    if (!r.ok) {
      return res.status(502).json({ error: (data.error && data.error.message) || 'Ошибка Cloudinary' });
    }
    res.status(201).json({ url: data.secure_url, publicId: data.public_id });
  } catch (e) { fail(res, e); }
});

// Ошибки разбора запроса (например, битый JSON) отдаём как JSON, а не как HTML
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.status ? 'Некорректный запрос' : err.message });
});

app.listen(PORT, () => {
  console.log(`Rumo CRM запущен на порту ${PORT}`);
});
