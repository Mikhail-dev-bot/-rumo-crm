const test = require('node:test');
const assert = require('node:assert');
const auth = require('../auth');
const access = require('../access');

const SECRET = 'test-secret';

test('пароль: верный проходит, неверный нет, хэши солятся', async () => {
  const h1 = await auth.hashPassword('abc12345');
  const h2 = await auth.hashPassword('abc12345');
  assert.notStrictEqual(h1, h2);
  assert.ok(await auth.checkPassword('abc12345', h1));
  assert.ok(!(await auth.checkPassword('abc12346', h1)));
  assert.ok(!(await auth.checkPassword('abc12345', 'garbage')));
  assert.ok(!(await auth.checkPassword('abc12345', undefined)));
});

test('токен: подпись, срок, подделка', () => {
  const t = auth.signToken({ sub: 1, role: 'client' }, SECRET, 60);
  assert.strictEqual(auth.verifyToken(t, SECRET).sub, 1);
  assert.strictEqual(auth.verifyToken(t, 'other-secret'), null);
  const [h, b, s] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 1, role: 'master', exp: 9999999999 })).toString('base64url');
  assert.strictEqual(auth.verifyToken(`${h}.${forged}.${s}`, SECRET), null);
  assert.strictEqual(auth.verifyToken(auth.signToken({ sub: 1 }, SECRET, -10), SECRET), null);
  assert.strictEqual(auth.verifyToken('a.b', SECRET), null);
  assert.strictEqual(auth.verifyToken(undefined, SECRET), null);
  // токен без подписи с alg: none не принимается
  const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${b}.`;
  assert.strictEqual(auth.verifyToken(none, SECRET), null);
});

test('логин нормализуется', () => {
  assert.strictEqual(auth.normLogin(' +7 (999) 123-45-67 '), '+79991234567');
  assert.strictEqual(auth.normLogin('Master'), 'master');
  for (const v of ['89991234567', '8 (999) 123-45-67', '79991234567', '9991234567', '+7 999 123 45 67']) {
    assert.strictEqual(auth.normLogin(v), '+79991234567');
  }
});

test('ограничитель попыток входа', () => {
  const rl = auth.makeRateLimiter(3, 1000);
  assert.ok(!rl.blocked('k'));
  rl.fail('k'); rl.fail('k');
  assert.ok(!rl.blocked('k'));
  rl.fail('k');
  assert.ok(rl.blocked('k'));
  rl.reset('k');
  assert.ok(!rl.blocked('k'));
});

test('права по ролям', () => {
  assert.ok(access.can('master', 'orders', 'DELETE'));
  assert.ok(access.can('mechanic', 'orders', 'PATCH'));
  assert.ok(!access.can('mechanic', 'orders', 'DELETE'));
  assert.ok(!access.can('mechanic', 'bookings', 'POST'));
  assert.ok(access.can('client', 'bookings', 'POST'));
  assert.ok(access.can('client', 'cars', 'PATCH'));
  assert.ok(!access.can('client', 'orders', 'PATCH'));
  assert.ok(!access.can('client', 'bookings', 'PATCH'));
  assert.ok(!access.can('client', 'parts', 'GET'));
  assert.ok(!access.can('client', 'clients', 'PATCH'));
  assert.ok(!access.can('ghost', 'orders', 'GET'));
  assert.ok(!access.can('master', 'users', 'GET')); // users не входит в общий CRUD
});

const cars = [
  { id: 1, model: 'Camry', plate: 'A 123 AA 55', clientId: 1 },
  { id: 2, model: 'Sportage', plate: 'B 234 BB 55', clientId: 2 },
  { id: 6, model: 'Camry', plate: 'F 111 FF 55', clientId: 6 },
];
const me = { role: 'client', clientId: 1 };

test('клиент видит только своё', () => {
  const orders = [
    { id: 1, plate: 'A123AA55' }, { id: 2, plate: 'B 234 BB 55' }, { id: 6, plate: 'f111ff55' },
  ];
  assert.deepStrictEqual(access.scopeList(me, 'orders', orders, cars).map((o) => o.id), [1]);
  assert.deepStrictEqual(access.scopeList(me, 'cars', cars, cars).map((c) => c.id), [1]);
  assert.deepStrictEqual(
    access.scopeList(me, 'clients', [{ id: 1 }, { id: 2 }], cars).map((c) => c.id), [1]);
  const bookings = [
    { id: 1, plate: 'B 234 BB 55', clientId: 2 }, { id: 2, plate: 'A123AA55' }, { id: 3, clientId: 1 },
  ];
  assert.deepStrictEqual(access.scopeList(me, 'bookings', bookings, cars).map((b) => b.id), [2, 3]);
  assert.deepStrictEqual(access.scopeList(me, 'parts', [{ id: 1 }], cars), []);
  // мастер и механик видят всё
  assert.strictEqual(access.scopeList({ role: 'master' }, 'orders', orders, cars).length, 3);
  assert.strictEqual(access.scopeList({ role: 'mechanic' }, 'orders', orders, cars).length, 3);
});

test('заявка клиента: чужую машину нельзя, служебные поля задаёт сервер', () => {
  const myCars = cars.filter((c) => c.clientId === 1);
  const client = { id: 1, phone: '+7 (999) 123-45-67' };
  const bad = access.sanitizeClientBooking(
    { plate: 'B 234 BB 55', serviceType: 'ТО', date: '2026-11-10', time: '10:00' }, me, client, myCars);
  assert.ok(bad.error);
  const ok = access.sanitizeClientBooking({
    plate: 'A123AA55', serviceType: 'ТО', date: '2026-11-10', time: '10:00',
    status: 'Подтверждена', clientId: 99, master: 'Хакер', id: 5,
  }, me, client, myCars);
  assert.strictEqual(ok.value.status, 'Новая заявка');
  assert.strictEqual(ok.value.clientId, 1);
  assert.strictEqual(ok.value.master, '');
  assert.strictEqual(ok.value.id, undefined);
  assert.strictEqual(ok.value.carModel, 'Camry');
  assert.ok(access.sanitizeClientBooking({ plate: 'A123AA55' }, me, client, myCars).error);
});

test('заявка клиента: длина полей и формат даты ограничены', () => {
  const myCars = cars.filter((c) => c.clientId === 1);
  const client = { id: 1, phone: '+7 (999) 123-45-67' };
  const base = { plate: 'A123AA55', serviceType: 'ТО', date: '2026-11-10', time: '10:00' };
  assert.ok(access.sanitizeClientBooking({ ...base, date: '10.11.2026' }, me, client, myCars).error);
  assert.ok(access.sanitizeClientBooking({ ...base, time: '25' }, me, client, myCars).error);
  const long = access.sanitizeClientBooking(
    { ...base, serviceType: 'x'.repeat(5000), comment: 'y'.repeat(5000), services: new Array(50).fill('z'.repeat(999)) },
    me, client, myCars).value;
  assert.strictEqual(long.serviceType.length, 500);
  assert.strictEqual(long.comment.length, 1000);
  assert.strictEqual(long.services.length, 20);
  assert.strictEqual(long.services[0].length, 200);
  assert.strictEqual(access.sanitizeClientBooking({ ...base, mileage: 'abc' }, me, client, myCars).value.mileage, null);
});

test('автомобиль клиента: clientId принудительно свой', () => {
  const r = access.sanitizeClientCar({ model: 'X', plate: 'Y', clientId: 7, id: 1 }, me);
  assert.strictEqual(r.value.clientId, 1);
  assert.strictEqual(r.value.id, undefined);
  assert.ok(access.sanitizeClientCar({ model: 'X' }, me).error);
});

test('замечания механика очищаются', () => {
  const out = access.sanitizeFindings([
    {
      part: 'Подвеска', status: 'Требует внимания', comment: 'Просела', evil: '<script>',
      photos: ['https://res.cloudinary.com/x/a.png', 'http://evil.example/a.png', 'file:///etc/passwd', 5],
    },
    { part: '', status: 'Норма' },
    null,
  ]);
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual(out[0].photos, ['https://res.cloudinary.com/x/a.png']);
  assert.strictEqual(out[0].evil, undefined);
  assert.deepStrictEqual(access.sanitizeFindings('nope'), []);
});

test('рекомендации: приоритет и completed выводятся', () => {
  const out = access.normalizeRecommendations([
    { part: 'a', status: 'Требует внимания', priority: '' },
    { part: 'b', status: 'Рекомендуется' },
    { part: 'c', status: 'Рекомендуется', priority: 'low', completed: true },
  ]);
  assert.deepStrictEqual(out.map((r) => r.priority), ['high', 'medium', 'low']);
  assert.deepStrictEqual(out.map((r) => r.completed), [false, false, true]);
  assert.deepStrictEqual(access.normalizeRecommendations(undefined), []);
});

test('регистрация клиента: проверка полей и форматирование телефона', () => {
  const ok = access.validateNewClient({ name: ' Иван ', phone: '8 999 123-45-67', email: 'a@b.ru' }, auth.normLogin);
  assert.deepStrictEqual(ok.value, { name: 'Иван', login: '+79991234567', phone: '+7 (999) 123-45-67', email: 'a@b.ru' });
  assert.ok(access.validateNewClient({ name: 'И', phone: '89991234567' }, auth.normLogin).error);
  assert.ok(access.validateNewClient({ name: 'Иван', phone: '12345' }, auth.normLogin).error);
  assert.ok(access.validateNewClient({ name: 'Иван', phone: 'master' }, auth.normLogin).error);
  assert.ok(access.validateNewClient({ name: 'Иван', phone: '89991234567', email: 'bad' }, auth.normLogin).error);
  assert.strictEqual(access.validateNewClient({ name: 'Иван', phone: '89991234567' }, auth.normLogin).value.email, '');
});

test('пробег: диапазон и запрет уменьшения', () => {
  assert.strictEqual(access.sanitizeMileage('80500', 80000).value, 80500);
  assert.strictEqual(access.sanitizeMileage(80000.4, 80000).value, 80000);
  assert.ok(access.sanitizeMileage(79000, 80000).error);
  assert.ok(access.sanitizeMileage('abc').error);
  assert.ok(access.sanitizeMileage('').error);
  assert.ok(access.sanitizeMileage(-5).error);
  assert.ok(access.sanitizeMileage(3000000).error);
  assert.strictEqual(access.sanitizeMileage(10).value, 10);
});

test('заказ из записи: поля переносятся, служебные задаёт сервер', () => {
  const o = access.orderFromBooking(
    { id: 5, carModel: 'Camry', plate: 'A 123 AA 55', serviceType: 'ТО', comment: 'Стук', date: '2026-12-01', time: '10:00', mileage: 80000, clientId: 1 },
    { id: 17, mechanic: 'Петров И.И.', master: 'Мастер', today: '2026-11-12' });
  assert.strictEqual(o.id, 17);
  assert.strictEqual(o.bookingId, 5);
  assert.strictEqual(o.issue, 'ТО. Стук');
  assert.strictEqual(o.status, 'В работе');
  assert.strictEqual(o.mechanic, 'Петров И.И.');
  assert.deepStrictEqual(o.findings, []);
  assert.strictEqual(access.orderFromBooking({ id: 1 }, { id: 2, today: '2026-11-12' }).date, '2026-11-12');
});
