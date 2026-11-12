// Права доступа по ролям и фильтрация данных. Чистые функции, без Express и без сети.
const normPlate = (p) => String(p || '').replace(/\s+/g, '').toUpperCase();

// c = создать (POST), r = читать (GET), u = менять (PATCH), d = удалять (DELETE)
const PERMS = {
  master: {
    bookings: 'crud', orders: 'crud', parts: 'crud', services: 'crud', clients: 'crud', cars: 'crud',
  },
  mechanic: {
    bookings: 'r', orders: 'ru', parts: 'r', services: 'r', clients: 'r', cars: 'r',
  },
  client: {
    bookings: 'rc', orders: 'r', services: 'r', clients: 'r', cars: 'rcu',
  },
};

const METHOD_LETTER = { GET: 'r', POST: 'c', PATCH: 'u', DELETE: 'd' };

function can(role, entity, method) {
  const letters = PERMS[role] && PERMS[role][entity];
  return !!letters && letters.includes(METHOD_LETTER[method]);
}

// Клиент видит только своё: себя, свои машины, заказы и записи по своим госномерам
function scopeList(user, entity, list, allCars) {
  if (user.role !== 'client') return list;
  const myCars = allCars.filter((c) => Number(c.clientId) === Number(user.clientId));
  const plates = new Set(myCars.map((c) => normPlate(c.plate)));
  switch (entity) {
    case 'clients': return list.filter((c) => Number(c.id) === Number(user.clientId));
    case 'cars': return myCars;
    case 'orders': return list.filter((o) => plates.has(normPlate(o.plate)));
    case 'bookings':
      return list.filter(
        (b) => Number(b.clientId) === Number(user.clientId) || plates.has(normPlate(b.plate))
      );
    case 'services': return list;
    default: return [];
  }
}

const text = (v, max = 1000) => String(v == null ? '' : v).slice(0, max);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

// Заявка клиента: берём только разрешённые поля, режем длину, остальное задаёт сервер
function sanitizeClientBooking(body, user, client, myCars) {
  const b = body || {};
  const car = myCars.find((c) => normPlate(c.plate) === normPlate(b.plate));
  if (!car) return { error: 'Автомобиль не найден среди ваших' };
  const serviceType = text(b.serviceType, 500).trim();
  if (!serviceType) return { error: 'Укажите услугу' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date || ''))) return { error: 'Некорректная дата' };
  if (!/^\d{2}:\d{2}$/.test(String(b.time || ''))) return { error: 'Некорректное время' };
  return {
    value: {
      carModel: car.model,
      plate: car.plate,
      mileage: num(b.mileage),
      serviceType,
      services: (Array.isArray(b.services) ? b.services : []).slice(0, 20).map((x) => text(x, 200)),
      date: b.date,
      time: b.time,
      comment: text(b.comment, 1000),
      status: 'Новая заявка',
      master: '',
      phone: client ? client.phone : '',
      clientId: Number(user.clientId),
    },
  };
}

function sanitizeClientCar(body, user) {
  const b = body || {};
  const model = text(b.model, 100).trim();
  const plate = text(b.plate, 20).trim();
  if (!model || !plate) return { error: 'Укажите модель и госномер' };
  return {
    value: { model, plate, year: num(b.year), mileage: num(b.mileage) || 0, clientId: Number(user.clientId) },
  };
}

// Приоритет и признак выполнения выводим на сервере, чтобы не зависеть от версии приложения
function normalizeRecommendations(list) {
  return (Array.isArray(list) ? list : []).map((r) => ({
    ...r,
    priority: r.priority || (r.status === 'Требует внимания' ? 'high' : 'medium'),
    completed: !!r.completed,
  }));
}

const PHOTO_PREFIX = 'https://res.cloudinary.com/';

// Замечания от механика: оставляем только известные поля, фото только с нашего Cloudinary
function sanitizeFindings(list) {
  return (Array.isArray(list) ? list : []).slice(0, 100).map((f) => ({
    part: text(f && f.part, 200),
    status: text(f && f.status, 50),
    comment: text(f && f.comment),
    priority: text(f && f.priority, 20),
    mileageHint: text(f && f.mileageHint, 200),
    photos: (Array.isArray(f && f.photos) ? f.photos : [])
      .filter((u) => typeof u === 'string' && u.startsWith(PHOTO_PREFIX) && u.length < 500)
      .slice(0, 10),
  })).filter((f) => f.part);
}

// Данные нового клиента: имя, телефон (российский), необязательная почта
function validateNewClient(body, normLogin) {
  const b = body || {};
  const name = text(b.name, 100).trim();
  if (name.length < 2) return { error: 'Укажите имя' };
  const login = normLogin(b.phone);
  if (!/^\+7\d{10}$/.test(login)) return { error: 'Укажите телефон в формате 89991234567' };
  const email = text(b.email, 100).trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'Некорректная почта' };
  const d = login.slice(2);
  const phone = `+7 (${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6, 8)}-${d.slice(8)}`;
  return { value: { name, login, phone, email } };
}

// Пробег: целое число км от 0 до 2 000 000; если известен текущий, уменьшать нельзя
function sanitizeMileage(value, current) {
  const n = Number(value);
  if (value === '' || value == null || !Number.isFinite(n) || n < 0 || n > 2000000) {
    return { error: 'Укажите пробег числом от 0 до 2 000 000 км' };
  }
  const km = Math.round(n);
  if (current != null && Number(current) > km) {
    return { error: `Пробег не может быть меньше текущего (${Number(current)} км)` };
  }
  return { value: km };
}

// Заказ-наряд из записи клиента
function orderFromBooking(b, { id, mechanic, master, today }) {
  const parts = [b.serviceType, b.comment].filter(Boolean);
  return {
    id,
    bookingId: b.id,
    clientId: b.clientId != null ? b.clientId : null,
    date: b.date || today,
    time: b.time || '',
    model: b.carModel || '',
    plate: b.plate || '',
    mileage: b.mileage != null ? b.mileage : null,
    issue: parts.join('. ').slice(0, 600),
    status: 'В работе',
    master: master || '',
    mechanic: mechanic || '',
    findings: [],
    recommendations: [],
  };
}

const MAX_CARS_PER_CLIENT = 10;
const MAX_OPEN_BOOKINGS = 10;

module.exports = {
  orderFromBooking,
  MAX_CARS_PER_CLIENT, MAX_OPEN_BOOKINGS,
  sanitizeMileage,
  validateNewClient,
  normPlate, PERMS, can, scopeList, sanitizeClientBooking, sanitizeClientCar,
  normalizeRecommendations, sanitizeFindings,
};
