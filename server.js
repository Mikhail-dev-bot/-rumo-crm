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
app.use(cors()); // токен идёт в заголовке Authorization, а не в cookie, поэтому открытый CORS не даёт CSRF

// Защитные заголовки. CSP: скрипты и запросы только со своего домена, картинки ещё с Cloudinary.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    + "img-src 'self' https://res.cloudinary.com data:; connect-src 'self'; "
    + "frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  );
  next();
});

// Большое тело (фото в base64) разрешено только для /api/upload, везде остальное маленькое
app.use('/api/upload', express.json({ limit: '12mb' }));
app.use(express.json({ limit: '100kb' }));
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

const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randomPassword = (len = 10) => Array.from(crypto.randomBytes(len), (b) => ALPHABET[b % ALPHABET.length]).join('');
// Все изменения данных идут по одной очереди: данные лежат в JSON-бинах (прочитал, поправил, записал),
// и без очереди два одновременных запроса затирали бы друг другу правки.
let dbChain = Promise.resolve();
const withDb = (fn) => {
  const r = dbChain.then(fn, fn);
  dbChain = r.catch(() => {});
  return r;
};
const locked = (handler) => (req, res, next) => withDb(() => handler(req, res, next));

const nextId = (list) => (list.length ? Math.max(...list.map((i) => Number(i.id) || 0)) + 1 : 1);
// Подробности ошибки пишем в лог сервера, клиенту отдаём общий текст (в сообщении могут быть внутренности)
const fail = (res, e) => {
  console.error('Ошибка запроса:', e && e.message);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
};
// Отпечаток пароля в токене: после смены пароля старые токены перестают работать
const pvOf = (u) => crypto.createHash('sha256').update(String(u.passHash)).digest('hex').slice(0, 12);
const tokenFor = (u) => A.signToken({ sub: u.id, pv: pvOf(u) }, JWT_SECRET);
const publicUser = (u) => ({ id: u.id, name: u.name, role: u.role, clientId: u.clientId || null });

// ═══════════════ Авторизация ═══════════════

const limiter = A.makeRateLimiter(10, 15 * 60 * 1000);       // неудачи на пару адрес+логин
const ipLimiter = A.makeRateLimiter(60, 15 * 60 * 1000);     // неудачи с одного адреса по любым логинам
const loginLimiter = A.makeRateLimiter(40, 15 * 60 * 1000);  // неудачи по одному логину с любых адресов
let DUMMY_HASH; // чтобы время ответа не выдавало, существует ли такой логин
A.hashPassword('dummy-password').then((h) => { DUMMY_HASH = h; });

// Регистрация: создаём запись клиента и аккаунт. Одна очередь, чтобы два запроса
// одновременно не получили один и тот же id (данные лежат в JSON-бинах).
function createClientAccount(data, password) {
  return withDb(async () => {
    const users = [...(await getEntity('users'))];
    if (users.length >= MAX_USERS) {
      const err = new Error('Регистрация временно закрыта');
      err.status = 503;
      throw err;
    }
    if (users.some((u) => A.normLogin(u.login) === data.login)) {
      const err = new Error('Клиент с таким телефоном уже зарегистрирован');
      err.status = 409;
      throw err;
    }
    const clients = [...(await getEntity('clients'))];
    const client = {
      id: nextId(clients), name: data.name, phone: data.phone, email: data.email,
      cars: [], lastVisit: '', totalSpent: 0,
    };
    clients.push(client);
    await saveEntity('clients', clients);
    const user = {
      id: nextId(users), login: data.login, name: data.name, role: 'client',
      clientId: client.id, passHash: await A.hashPassword(password),
    };
    users.push(user);
    await saveEntity('users', users);
    return { client, user };
  });
}

const regLimiter = A.makeRateLimiter(5, 60 * 60 * 1000);        // с одного адреса
const regGlobalLimiter = A.makeRateLimiter(40, 60 * 60 * 1000); // со всех адресов вместе
const MAX_USERS = 400; // бесплатный бин JSONBin ограничен по размеру

// Самостоятельная регистрация клиента из приложения (без токена)
app.post('/api/auth/register', async (req, res) => {
  try {
    if (!JWT_SECRET || !BINS.users) {
      return res.status(503).json({ error: 'Авторизация не настроена на сервере' });
    }
    if (regLimiter.blocked(req.ip) || regGlobalLimiter.blocked('all')) {
      return res.status(429).json({ error: 'Слишком много регистраций, попробуйте позже' });
    }
    regLimiter.fail(req.ip); regGlobalLimiter.fail('all'); // считаем каждую попытку
    const v = acc.validateNewClient(req.body, A.normLogin);
    if (v.error) return res.status(400).json({ error: v.error });
    const password = req.body && req.body.password;
    if (typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ error: 'Пароль: не короче 6 символов' });
    }
    const { user } = await createClientAccount(v.value, password);
    res.status(201).json({ token: tokenFor(user), user: publicUser(user) });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    fail(res, e);
  }
});

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
    if (login.length > 64 || password.length > 200) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }
    const key = `${req.ip}|${login}`;
    if (limiter.blocked(key) || ipLimiter.blocked(req.ip) || loginLimiter.blocked(login)) {
      return res.status(429).json({ error: 'Слишком много попыток, попробуйте через 15 минут' });
    }
    const users = await getEntity('users');
    const user = users.find((u) => A.normLogin(u.login) === login);
    const ok = await A.checkPassword(password, user ? user.passHash : DUMMY_HASH);
    if (!user || !ok) {
      limiter.fail(key); ipLimiter.fail(req.ip); loginLimiter.fail(login);
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }
    limiter.reset(key);
    res.json({ token: tokenFor(user), user: publicUser(user) });
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
    if (!user || payload.pv !== pvOf(user)) return res.status(401).json({ error: 'Требуется вход' });
    req.user = user;
    next();
  } catch (e) { fail(res, e); }
}
app.use('/api', requireAuth);

const requireRole = (...roles) => (req, res, next) => (
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Недостаточно прав' })
);

app.get('/api/auth/me', (req, res) => res.json(publicUser(req.user)));

app.post('/api/auth/password', locked(async (req, res) => {
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
}));

// ── Управление пользователями: только мастер ──
app.get('/api/users', requireRole('master'), async (req, res) => {
  try { res.json((await getEntity('users')).map(publicUser)); } catch (e) { fail(res, e); }
});

app.post('/api/users', requireRole('master'), locked(async (req, res) => {
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
}));

// Мастер заводит клиента (например, при визите в сервис); пароль показывается один раз
app.post('/api/users/client', requireRole('master'), async (req, res) => {
  try {
    const v = acc.validateNewClient(req.body, A.normLogin);
    if (v.error) return res.status(400).json({ error: v.error });
    const given = req.body && req.body.password;
    if (given != null && (typeof given !== 'string' || given.length < 6)) {
      return res.status(400).json({ error: 'Пароль: не короче 6 символов' });
    }
    const password = given || randomPassword();
    const { client, user } = await createClientAccount(v.value, password);
    res.status(201).json({ client, login: user.login, password });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    fail(res, e);
  }
});

app.post('/api/users/:id/password', requireRole('master'), locked(async (req, res) => {
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
}));

app.delete('/api/users/:id', requireRole('master'), locked(async (req, res) => {
  try {
    if (String(req.params.id) === String(req.user.id)) {
      return res.status(400).json({ error: 'Нельзя удалить самого себя' });
    }
    const users = (await getEntity('users')).filter((u) => String(u.id) !== String(req.params.id));
    await saveEntity('users', users);
    res.status(204).end();
  } catch (e) { fail(res, e); }
}));

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

  app.post(`/api/${name}`, guard, locked(async (req, res) => {
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
      if (name === 'cars') {
        // чужой госномер завести нельзя: по номеру клиент видит заказы и историю машины
        if (list.some((c) => acc.normPlate(c.plate) === acc.normPlate(data.plate))) {
          return res.status(409).json({ error: 'Автомобиль с таким госномером уже зарегистрирован' });
        }
        if (req.user.role === 'client'
          && list.filter((c) => Number(c.clientId) === Number(req.user.clientId)).length >= acc.MAX_CARS_PER_CLIENT) {
          return res.status(400).json({ error: `Не больше ${acc.MAX_CARS_PER_CLIENT} автомобилей` });
        }
      }
      if (name === 'bookings' && req.user.role === 'client'
        && list.filter((b) => Number(b.clientId) === Number(req.user.clientId) && b.status === 'Новая заявка').length
          >= acc.MAX_OPEN_BOOKINGS) {
        return res.status(400).json({ error: 'Слишком много неподтверждённых заявок, дождитесь ответа сервиса' });
      }
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
  }));

  app.patch(`/api/${name}/:id`, guard, locked(async (req, res) => {
    try {
      const list = [...(await getEntity(name))];
      const idx = list.findIndex((i) => String(i.id) === String(req.params.id));
      if (idx === -1) return res.status(404).json({ error: 'Not found' });
      // механик может менять у заказа только статус
      let body = req.user.role === 'mechanic' ? pick(req.body, ['status']) : (req.body || {});
      if (req.user.role === 'client') {
        // клиент меняет только пробег своей машины, и только вверх
        if (name !== 'cars' || Number(list[idx].clientId) !== Number(req.user.clientId)) {
          return res.status(404).json({ error: 'Not found' });
        }
        const m = acc.sanitizeMileage(req.body && req.body.mileage, list[idx].mileage);
        if (m.error) return res.status(400).json({ error: m.error });
        body = { mileage: m.value };
      }
      list[idx] = { ...list[idx], ...body, id: list[idx].id };
      await saveEntity(name, list);
      res.json(list[idx]);
    } catch (e) { fail(res, e); }
  }));

  app.delete(`/api/${name}/:id`, guard, locked(async (req, res) => {
    try {
      const list = (await getEntity(name)).filter((i) => String(i.id) !== String(req.params.id));
      await saveEntity(name, list);
      res.status(204).end();
    } catch (e) { fail(res, e); }
  }));
}

// ── Мастер создаёт заказ-наряд из записи и назначает механика ──
app.post('/api/bookings/:id/order', requireRole('master'), locked(async (req, res) => {
  try {
    const bookings = [...(await getEntity('bookings'))];
    const bi = bookings.findIndex((b) => String(b.id) === String(req.params.id));
    if (bi === -1) return res.status(404).json({ error: 'Запись не найдена' });
    const b = bookings[bi];
    if (b.orderId != null) return res.status(409).json({ error: `Заказ уже создан (№ ${b.orderId})` });
    if (b.status === 'Отменена') return res.status(400).json({ error: 'Запись отклонена' });

    const mechanicName = String((req.body && req.body.mechanic) || '').slice(0, 100);
    if (mechanicName) {
      const users = await getEntity('users');
      if (!users.some((u) => u.role === 'mechanic' && u.name === mechanicName)) {
        return res.status(400).json({ error: 'Такого механика нет' });
      }
    }
    const orders = [...(await getEntity('orders'))];
    const order = acc.orderFromBooking(b, {
      id: nextId(orders), mechanic: mechanicName, master: req.user.name,
      today: new Date().toISOString().slice(0, 10),
    });
    orders.push(order);
    await saveEntity('orders', orders);
    bookings[bi] = { ...b, status: 'Подтверждена', master: req.user.name, orderId: order.id };
    await saveEntity('bookings', bookings);
    res.status(201).json(order);
  } catch (e) { fail(res, e); }
}));

// ── Приложение механика передаёт результаты диагностики сюда ──
// Обновляет заказ (orders) полями findings/recommendations и статусом.
// Имя механика и время берутся на сервере, а не из запроса.
app.post('/api/orders/:id/diagnostics', requireRole('mechanic', 'master'), locked(async (req, res) => {
  try {
    const findings = acc.sanitizeFindings(req.body && req.body.findings);
    if (findings.length === 0) return res.status(400).json({ error: 'Нет данных диагностики' });
    const recommendations = acc.normalizeRecommendations(
      findings.filter((f) => f.status !== 'Норма' && f.status !== 'OK')
    );
    const orders = [...(await getEntity('orders'))];
    const idx = orders.findIndex((o) => String(o.id) === String(req.params.id));
    if (idx === -1) return res.status(404).json({ error: 'Заказ не найден' });

    // пробег с осмотра: пишем в заказ, а у машины обновляем, если он больше прежнего
    let mileage = orders[idx].mileage;
    if (req.body && req.body.mileage != null && req.body.mileage !== '') {
      const m = acc.sanitizeMileage(req.body.mileage);
      if (m.error) return res.status(400).json({ error: m.error });
      mileage = m.value;
      const cars = [...(await getEntity('cars'))];
      const ci = cars.findIndex((c) => acc.normPlate(c.plate) === acc.normPlate(orders[idx].plate));
      if (ci !== -1 && Number(cars[ci].mileage || 0) < mileage) {
        cars[ci] = { ...cars[ci], mileage };
        await saveEntity('cars', cars);
      }
    }

    const now = new Date().toISOString();
    orders[idx] = {
      ...orders[idx],
      mileage,
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
}));

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
const uploadLimiter = A.makeRateLimiter(60, 60 * 60 * 1000); // фото в час на пользователя
const MAX_UPLOAD_CHARS = 10 * 1024 * 1024; // ~7 МБ картинки в base64

app.post('/api/upload', requireRole('mechanic', 'master'), async (req, res) => {
  try {
    if (!CLOUD_NAME || !CLOUD_KEY || !CLOUD_SECRET) {
      return res.status(503).json({ error: 'Cloudinary не настроен на сервере' });
    }
    if (uploadLimiter.blocked(req.user.id)) {
      return res.status(429).json({ error: 'Слишком много загрузок, попробуйте позже' });
    }
    uploadLimiter.fail(req.user.id); // считаем каждую попытку
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
  if (!err.status) console.error('Необработанная ошибка:', err && err.message);
  res.status(err.status || 500).json({ error: err.status === 413 ? 'Слишком большой запрос' : err.status ? 'Некорректный запрос' : 'Внутренняя ошибка сервера' });
});

app.listen(PORT, () => {
  console.log(`Rumo CRM запущен на порту ${PORT}`);
});
