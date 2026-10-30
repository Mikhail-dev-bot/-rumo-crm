require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors()); // разрешаем запросы с других доменов (Snack.expo, StackBlitz и т.д.)
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const MASTER_KEY = process.env.RUMO_MASTER_KEY;

const BINS = {
  bookings: process.env.BIN_BOOKINGS,
  orders: process.env.BIN_ORDERS,
  parts: process.env.BIN_PARTS,
  services: process.env.BIN_SERVICES,
  clients: process.env.BIN_CLIENTS,
  cars: process.env.BIN_CARS,
};

const jsonbin = axios.create({
  baseURL: 'https://api.jsonbin.io/v3',
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
  if (!binId) throw new Error(`BIN_${name.toUpperCase()} не задан в .env`);
  const cached = cache.get(name);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;
  const record = await readBin(binId);
  const list = Array.isArray(record) ? record : record[name] || [];
  cache.set(name, { at: Date.now(), data: list });
  return list;
}

async function saveEntity(name, list) {
  const binId = BINS[name];
  await writeBin(binId, list);
  cache.set(name, { at: Date.now(), data: list });
  return list;
}

// ── Универсальные CRUD-роуты для каждой сущности ──
for (const name of Object.keys(BINS)) {
  app.get(`/api/${name}`, async (req, res) => {
    try {
      res.json(await getEntity(name));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post(`/api/${name}`, async (req, res) => {
    try {
      const list = await getEntity(name);
      const nextId = list.length
        ? Math.max(...list.map((i) => Number(i.id) || 0)) + 1
        : 1;
      const item = { id: nextId, ...req.body };
      list.push(item);
      await saveEntity(name, list);
      res.status(201).json(item);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.patch(`/api/${name}/:id`, async (req, res) => {
    try {
      const list = await getEntity(name);
      const idx = list.findIndex((i) => String(i.id) === String(req.params.id));
      if (idx === -1) return res.status(404).json({ error: 'Not found' });
      list[idx] = { ...list[idx], ...req.body };
      await saveEntity(name, list);
      res.json(list[idx]);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete(`/api/${name}/:id`, async (req, res) => {
    try {
      const list = await getEntity(name);
      const filtered = list.filter(
        (i) => String(i.id) !== String(req.params.id)
      );
      await saveEntity(name, filtered);
      res.status(204).end();
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

// ── Приложение механика передаёт результаты диагностики сюда ──
// Обновляет заказ (orders) полями findings/recommendations и статусом.
app.post('/api/orders/:id/diagnostics', async (req, res) => {
  try {
    const { mechanic, findings, recommendations, submittedAt } = req.body;
    const orders = await getEntity('orders');
    const idx = orders.findIndex((o) => String(o.id) === String(req.params.id));
    if (idx === -1) return res.status(404).json({ error: 'Заказ не найден' });

    orders[idx] = {
      ...orders[idx],
      mechanic,
      findings,
      recommendations,
      diagnosticsSubmittedAt: submittedAt,
      status: 'Диагностика завершена',
    };
    await saveEntity('orders', orders);
    res.json(orders[idx]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Аналитика для дашборда CRM ──
app.get('/api/analytics/today', async (req, res) => {
  try {
    const [orders, bookings, clients] = await Promise.all([
      getEntity('orders'),
      getEntity('bookings'),
      getEntity('clients'),
    ]);
    const today = new Date().toISOString().slice(0, 10);

    const needsAttention = orders.filter((o) =>
      (o.recommendations || []).some((r) => r.priority === 'high')
    ).length;

    const newDiagnostics = orders.filter(
      (o) => o.diagnosticsSubmittedAt?.slice(0, 10) === today
    ).length;
    const incompleteRecommendations = orders.reduce(
      (sum, o) =>
        sum + (o.recommendations || []).filter((r) => !r.completed).length,
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
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Rumo CRM запущен на порту ${PORT}`);
});
