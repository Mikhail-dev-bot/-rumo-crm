const STATUS_BADGE = {
  'Подтверждена': 'ok',
  'Отменена': 'danger',
  'Завершён': 'ok',
  'В работе': 'warn',
  'Новая заявка': 'warn',
  'Запись': 'info',
  'Требует внимания': 'danger',
  'Рекомендуется': 'warn',
  'Диагностика завершена': 'info',
};

// Любой текст из базы (в том числе введённый клиентами) выводим только через esc():
// иначе чужой текст с HTML-кодом выполнился бы в браузере мастера.
function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function badge(status) {
  const cls = STATUS_BADGE[status] || 'info';
  return `<span class="badge ${cls}">${esc(status || '—')}</span>`;
}

// ── Токен хранится только на время вкладки ──
const TOKEN_KEY = 'rumo_token';
let token = null;
try { token = sessionStorage.getItem(TOKEN_KEY); } catch (e) { /* хранилище недоступно */ }
let refreshTimer = null;
let currentUserName = '';

function saveToken(value) {
  token = value;
  try {
    if (value) sessionStorage.setItem(TOKEN_KEY, value); else sessionStorage.removeItem(TOKEN_KEY);
  } catch (e) { /* ничего страшного: войдём заново после перезагрузки */ }
}

async function fetchJSON(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
    showLogin('Войдите заново');
    throw new Error('401');
  }
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.status === 204 ? null : res.json();
}

// ── Вход ──
const loginBox = document.getElementById('login');
const loginError = document.getElementById('login-error');

function showLogin(message) {
  stopRefresh();
  saveToken(null);
  loginError.textContent = message || '';
  loginBox.classList.remove('hidden');
  document.getElementById('login-pass').value = '';
}

function hideLogin() {
  loginBox.classList.add('hidden');
  loginError.textContent = '';
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.textContent = '';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        login: document.getElementById('login-name').value,
        password: document.getElementById('login-pass').value,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { loginError.textContent = data.error || `Ошибка ${res.status}`; return; }
    if (data.user.role !== 'master') {
      loginError.textContent = 'CRM доступна только мастеру. Используйте мобильное приложение.';
      return;
    }
    saveToken(data.token);
    currentUserName = data.user.name;
    document.getElementById('user-name').textContent = data.user.name;
    hideLogin();
    startApp();
  } catch (err) {
    loginError.textContent = 'Нет связи с сервером. Если он только что проснулся, подождите минуту.';
  }
});

document.getElementById('logout').addEventListener('click', (e) => {
  e.preventDefault();
  showLogin('');
});

// ── Навигация по вкладкам ──
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.add('hidden'));
    item.classList.add('active');
    document.getElementById(`tab-${item.dataset.tab}`).classList.remove('hidden');
  });
});

// ── Вкладка "Сегодня" ──
async function renderToday() {
  try {
    const [analytics, bookings, orders] = await Promise.all([
      fetchJSON('/api/analytics/today'),
      fetchJSON('/api/bookings'),
      fetchJSON('/api/orders'),
    ]);

    document.getElementById('metric-cards').innerHTML = `
      <div class="metric-card red"><div class="num">${esc(analytics.clientsNeedAttention)}</div><div class="label">Клиентов требуют внимания</div></div>
      <div class="metric-card blue"><div class="num">${esc(analytics.todaysBookings)}</div><div class="label">Записей на сегодня</div></div>
      <div class="metric-card orange"><div class="num">${esc(analytics.incompleteRecommendations)}</div><div class="label">Невыполненные рекомендации</div></div>
      <div class="metric-card green"><div class="num">${esc(analytics.newDiagnosticsToday)}</div><div class="label">Новые результаты диагностики</div></div>
    `;

    const today = new Date().toISOString().slice(0, 10);
    const todaysBookings = bookings.filter(b => b.date === today);
    document.querySelector('#table-bookings tbody').innerHTML = todaysBookings.map(b => `
      <tr>
        <td>${esc(b.time)}</td>
        <td>${esc(b.phone)}</td>
        <td>${esc(b.carModel)} ${esc(b.plate)}</td>
        <td>${esc(b.serviceType)}</td>
        <td>${badge(b.status)}</td>
      </tr>
    `).join('') || `<tr><td colspan="5">Нет записей на сегодня</td></tr>`;

    ordersCache = orders;
    const withDiagnostics = orders.filter(o => o.diagnosticsSubmittedAt);
    document.getElementById('diagnostics-list').innerHTML = withDiagnostics.map(o => `
      <div class="clickable" data-order="${esc(o.id)}" style="padding:10px 0; border-bottom:1px solid #f0f0f0;">
        <strong>${esc(o.model)}</strong> ${o.plate ? `(${esc(o.plate)})` : ''}<br>
        <span style="color:#888; font-size:13px;">${(o.recommendations || []).length} рекомендаций</span>
      </div>
    `).join('') || '<p style="color:#888;">Пока нет новых результатов</p>';
  } catch (e) {
    console.error(e);
  }
}

// ── Вкладка "Клиенты" ──
async function renderClients() {
  const clients = await fetchJSON('/api/clients');
  document.querySelector('#table-clients tbody').innerHTML = clients.map(c => `
    <tr>
      <td>${esc(c.name)}</td>
      <td>${esc(c.phone)}</td>
      <td>${esc(c.email)}</td>
      <td>${(c.cars || []).length}</td>
      <td>${esc(c.lastVisit)}</td>
      <td>${esc((c.totalSpent || 0).toLocaleString('ru-RU'))} ₽</td>
    </tr>
  `).join('');
}


// ── Добавить клиента ──
document.getElementById('add-client-btn').addEventListener('click', () => {
  document.getElementById('add-client-form').classList.remove('hidden');
  document.getElementById('nc-result').textContent = '';
  document.getElementById('nc-name').focus();
});
document.getElementById('nc-cancel').addEventListener('click', () => {
  document.getElementById('add-client-form').classList.add('hidden');
});
document.getElementById('add-client-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = document.getElementById('nc-result');
  out.className = 'nc-result';
  out.textContent = 'Создаём…';
  try {
    const res = await fetch('/api/users/client', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name: document.getElementById('nc-name').value,
        phone: document.getElementById('nc-phone').value,
        email: document.getElementById('nc-email').value,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !data.password) { showLogin('Войдите заново'); return; }
    if (!res.ok) { out.className = 'nc-result err'; out.textContent = data.error || `Ошибка ${res.status}`; return; }
    out.className = 'nc-result ok';
    out.innerHTML = `Клиент создан. Логин: <b>${esc(data.login)}</b>, пароль: <b>${esc(data.password)}</b><br>
      <span class="note">Пароль показывается один раз. Передайте его клиенту; он сможет сменить его в приложении.</span>`;
    e.target.reset();
    renderClients().catch(console.error);
  } catch (err) {
    out.className = 'nc-result err';
    out.textContent = 'Нет связи с сервером';
  }
});

// ── Вкладка "Автомобили" ──
async function renderCars() {
  const cars = await fetchJSON('/api/cars');
  document.querySelector('#table-cars tbody').innerHTML = cars.map(c => `
    <tr>
      <td>${esc(c.model)}</td>
      <td>${esc(c.plate)}</td>
      <td>${esc((c.mileage || 0).toLocaleString('ru-RU'))} км</td>
      <td>${esc(c.year)}</td>
      <td class="actions"><button type="button" class="btn-no" style="color:#3b82f6;border-color:#3b82f6"
        data-car="${esc(c.id)}" data-km="${esc(c.mileage || 0)}">Изменить пробег</button></td>
    </tr>
  `).join('');
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-car]');
  if (!btn) return;
  const input = window.prompt('Новый пробег, км', btn.dataset.km);
  if (input == null) return;
  const km = Number(String(input).replace(/\s/g, ''));
  if (!Number.isFinite(km) || km < 0 || km > 2000000) { window.alert('Укажите пробег числом от 0 до 2 000 000'); return; }
  try {
    await fetchJSON(`/api/cars/${encodeURIComponent(btn.dataset.car)}`, { method: 'PATCH', body: JSON.stringify({ mileage: Math.round(km) }) });
    renderCars().catch(console.error);
  } catch (err) { window.alert('Не удалось сохранить'); }
});

// ── Вкладка "Заказы" ──
async function renderOrders() {
  const orders = await fetchJSON('/api/orders');
  ordersCache = orders;
  document.querySelector('#table-orders tbody').innerHTML = orders.map(o => `
    <tr class="clickable" data-order="${esc(o.id)}">
      <td>${esc(o.time)}</td>
      <td>${esc(o.model)}</td>
      <td>${esc(o.plate)}</td>
      <td>${esc(o.issue)}</td>
      <td>${badge(o.status)}</td>
    </tr>
  `).join('');
}

// ── Вкладка "Записи" ──
async function renderBookingsFull() {
  const [bookings, users] = await Promise.all([fetchJSON('/api/bookings'), fetchJSON('/api/users')]);
  const mechanics = users.filter(u => u.role === 'mechanic');
  // новые заявки сверху, остальные по дате (свежие первыми)
  const rank = (b) => (b.status === 'Новая заявка' ? 0 : 1);
  document.querySelector('#table-bookings-full tbody').innerHTML = bookings
    .slice()
    .sort((a, b) => rank(a) - rank(b) || `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`))
    .map(b => `
    <tr>
      <td>${esc(b.date)}</td>
      <td>${esc(b.time)}</td>
      <td>${esc(b.carModel)} (${esc(b.plate)})${b.phone ? `<div class="note">${esc(b.phone)}</div>` : ''}</td>
      <td>${esc(b.serviceType)}${b.comment ? `<div class="note">${esc(b.comment)}</div>` : ''}</td>
      <td>${badge(b.status)}</td>
      <td class="actions">${
        b.status === 'Новая заявка' ? `
        <button type="button" class="btn-ok" data-booking="${esc(b.id)}" data-set="Подтверждена">Подтвердить</button>
        <button type="button" class="btn-no" data-booking="${esc(b.id)}" data-set="Отменена">Отклонить</button>`
        : (b.status === 'Подтверждена' && b.orderId == null) ? `
        <select data-mech="${esc(b.id)}">${mechanics.map(m => `<option>${esc(m.name)}</option>`).join('')}</select>
        <button type="button" class="btn-ok" data-mkorder="${esc(b.id)}">Создать заказ</button>`
        : (b.orderId != null ? `<span class="note">Заказ № ${esc(b.orderId)}</span>` : '')}</td>
    </tr>
  `).join('') || '<tr><td colspan="6">Записей пока нет</td></tr>';
}

document.addEventListener('click', async (e) => {
  const mk = e.target.closest('button[data-mkorder]');
  if (!mk) return;
  const sel = document.querySelector(`select[data-mech="${CSS.escape(mk.dataset.mkorder)}"]`);
  mk.disabled = true;
  try {
    await fetchJSON(`/api/bookings/${encodeURIComponent(mk.dataset.mkorder)}/order`, {
      method: 'POST', body: JSON.stringify({ mechanic: sel ? sel.value : '' }),
    });
    renderBookingsFull().catch(console.error);
    renderOrders().catch(console.error);
    renderToday();
  } catch (err) {
    mk.disabled = false;
    mk.textContent = 'Ошибка, повторить';
  }
});

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-booking]');
  if (!btn) return;
  btn.disabled = true;
  const status = btn.dataset.set;
  try {
    await fetchJSON(`/api/bookings/${encodeURIComponent(btn.dataset.booking)}`, {
      method: 'PATCH',
      body: JSON.stringify(status === 'Подтверждена' ? { status, master: currentUserName } : { status }),
    });
    renderBookingsFull().catch(console.error);
    renderToday();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Ошибка, повторить';
  }
});

// ── Вкладка "Аналитика" ──
async function renderAnalytics() {
  const [clients, orders, parts] = await Promise.all([
    fetchJSON('/api/clients'),
    fetchJSON('/api/orders'),
    fetchJSON('/api/parts'),
  ]);
  const totalSpent = clients.reduce((s, c) => s + (c.totalSpent || 0), 0);
  const lowStock = parts.filter(p => p.stock < 5).length;

  document.getElementById('analytics-cards').innerHTML = `
    <div class="metric-card blue"><div class="num">${clients.length}</div><div class="label">Всего клиентов</div></div>
    <div class="metric-card green"><div class="num">${esc(totalSpent.toLocaleString('ru-RU'))} ₽</div><div class="label">Общая выручка</div></div>
    <div class="metric-card orange"><div class="num">${orders.length}</div><div class="label">Всего заказов</div></div>
    <div class="metric-card red"><div class="num">${lowStock}</div><div class="label">Запчасти на исходе</div></div>
  `;
}


// ── Карточка заказа: результаты диагностики с фото ──
let ordersCache = [];
const ORDER_STATUSES = ['Запись', 'В работе', 'Диагностика завершена', 'Завершён'];

// фото показываем только с нашего Cloudinary, остальное не открываем
const safePhoto = (u) => typeof u === 'string' && u.startsWith('https://res.cloudinary.com/');

function findingHtml(f) {
  const photos = (f.photos || []).filter(safePhoto).map(u =>
    `<a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="Фото" loading="lazy"></a>`).join('');
  return `
    <div class="finding">
      <div class="finding-head"><strong>${esc(f.part)}</strong> ${badge(f.status)}${f.completed ? ' <span class="badge ok">Выполнено</span>' : ''}</div>
      ${f.comment ? `<div class="finding-comment">${esc(f.comment)}</div>` : ''}
      ${f.mileageHint ? `<div class="note">${esc(f.mileageHint)}</div>` : ''}
      ${photos ? `<div class="photos">${photos}</div>` : ''}
    </div>`;
}

function openOrder(id) {
  const o = ordersCache.find(x => String(x.id) === String(id));
  if (!o) return;
  const findings = o.findings || [];
  const problems = findings.filter(f => f.status !== 'Норма' && f.status !== 'OK');
  const ok = findings.filter(f => f.status === 'Норма' || f.status === 'OK');
  document.getElementById('order-body').innerHTML = `
    <h2>${esc(o.model)} <small>${esc(o.plate)}</small></h2>
    <div class="order-meta">
      <div><span>Проблема</span>${esc(o.issue)}</div>
      <div><span>Механик</span>${esc(o.mechanic || '—')}</div>
      <div><span>Дата</span>${esc(o.date || (o.diagnosticsSubmittedAt || '').slice(0, 10) || '—')}</div>
      <div><span>Пробег</span>${o.mileage ? esc(Number(o.mileage).toLocaleString('ru-RU')) + ' км' : '—'}</div>
    </div>
    <label class="status-row">Статус
      <select id="order-status">
        ${ORDER_STATUSES.concat(ORDER_STATUSES.includes(o.status) ? [] : [o.status]).map(s =>
          `<option ${s === o.status ? 'selected' : ''}>${esc(s)}</option>`).join('')}
      </select>
      <button id="order-status-save" type="button">Сохранить</button>
      <span id="order-status-msg" class="note"></span>
    </label>
    <h3>Требуют внимания (${problems.length})</h3>
    ${problems.map(findingHtml).join('') || '<p class="note">Нет замечаний</p>'}
    ${ok.length ? `<h3>В норме (${ok.length})</h3><p class="note">${ok.map(f => esc(f.part)).join(', ')}</p>` : ''}
    ${findings.length ? '' : '<p class="note">Диагностика ещё не отправлена</p>'}
  `;
  document.getElementById('order-status-save').addEventListener('click', async () => {
    const msg = document.getElementById('order-status-msg');
    const status = document.getElementById('order-status').value;
    msg.textContent = 'Сохраняем…';
    try {
      await fetchJSON(`/api/orders/${encodeURIComponent(o.id)}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      o.status = status;
      msg.textContent = 'Сохранено';
      renderOrders().catch(console.error);
    } catch (e) { msg.textContent = 'Не удалось сохранить'; }
  });
  document.getElementById('order-modal').classList.remove('hidden');
}

document.addEventListener('click', (e) => {
  const row = e.target.closest('[data-order]');
  if (row) { openOrder(row.dataset.order); return; }
  if (e.target.id === 'order-modal' || e.target.id === 'order-close') {
    document.getElementById('order-modal').classList.add('hidden');
  }
});

// ── Запуск ──
function stopRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

function startApp() {
  renderToday();
  renderClients().catch(console.error);
  renderCars().catch(console.error);
  renderOrders().catch(console.error);
  renderBookingsFull().catch(console.error);
  renderAnalytics().catch(console.error);
  stopRefresh();
  refreshTimer = setInterval(renderToday, 30_000);
}

(async function boot() {
  if (!token) { showLogin(''); return; }
  try {
    const me = await fetchJSON('/api/auth/me');
    if (me.role !== 'master') { showLogin('CRM доступна только мастеру'); return; }
    currentUserName = me.name;
    document.getElementById('user-name').textContent = me.name;
    hideLogin();
    startApp();
  } catch (e) {
    // при 401 fetchJSON уже показал окно входа
    if (String(e.message) !== '401') showLogin('Нет связи с сервером. Попробуйте ещё раз через минуту.');
  }
})();
