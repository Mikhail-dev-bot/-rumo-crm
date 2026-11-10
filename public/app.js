const STATUS_BADGE = {
  'Подтверждена': 'ok',
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

    const withDiagnostics = orders.filter(o => o.diagnosticsSubmittedAt);
    document.getElementById('diagnostics-list').innerHTML = withDiagnostics.map(o => `
      <div style="padding:10px 0; border-bottom:1px solid #f0f0f0;">
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

// ── Вкладка "Автомобили" ──
async function renderCars() {
  const cars = await fetchJSON('/api/cars');
  document.querySelector('#table-cars tbody').innerHTML = cars.map(c => `
    <tr>
      <td>${esc(c.model)}</td>
      <td>${esc(c.plate)}</td>
      <td>${esc((c.mileage || 0).toLocaleString('ru-RU'))} км</td>
      <td>${esc(c.year)}</td>
    </tr>
  `).join('');
}

// ── Вкладка "Заказы" ──
async function renderOrders() {
  const orders = await fetchJSON('/api/orders');
  document.querySelector('#table-orders tbody').innerHTML = orders.map(o => `
    <tr>
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
  const bookings = await fetchJSON('/api/bookings');
  document.querySelector('#table-bookings-full tbody').innerHTML = bookings
    .slice()
    .sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`))
    .map(b => `
    <tr>
      <td>${esc(b.date)}</td>
      <td>${esc(b.time)}</td>
      <td>${esc(b.carModel)} (${esc(b.plate)})</td>
      <td>${esc(b.serviceType)}${b.comment ? `<div class="note">${esc(b.comment)}</div>` : ''}</td>
      <td>${badge(b.status)}</td>
    </tr>
  `).join('');
}

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
    document.getElementById('user-name').textContent = me.name;
    hideLogin();
    startApp();
  } catch (e) {
    // при 401 fetchJSON уже показал окно входа
    if (String(e.message) !== '401') showLogin('Нет связи с сервером. Попробуйте ещё раз через минуту.');
  }
})();
