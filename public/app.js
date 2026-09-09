const STATUS_BADGE = {
  'Подтверждена': 'ok',
  'В работе': 'warn',
  'Запись': 'info',
  'Требует внимания': 'danger',
  'Рекомендуется': 'warn',
  'Диагностика завершена': 'info',
};

function badge(status) {
  const cls = STATUS_BADGE[status] || 'info';
  return `<span class="badge ${cls}">${status || '—'}</span>`;
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

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
      <div class="metric-card red"><div class="num">${analytics.clientsNeedAttention}</div><div class="label">Клиентов требуют внимания</div></div>
      <div class="metric-card blue"><div class="num">${analytics.todaysBookings}</div><div class="label">Записей на сегодня</div></div>
      <div class="metric-card orange"><div class="num">${analytics.incompleteRecommendations}</div><div class="label">Невыполненные рекомендации</div></div>
      <div class="metric-card green"><div class="num">${analytics.newDiagnosticsToday}</div><div class="label">Новые результаты диагностики</div></div>
    `;

    const today = new Date().toISOString().slice(0, 10);
    const todaysBookings = bookings.filter(b => b.date === today);
    document.querySelector('#table-bookings tbody').innerHTML = todaysBookings.map(b => `
      <tr>
        <td>${b.time || ''}</td>
        <td>${b.phone || ''}</td>
        <td>${b.carModel || ''} ${b.plate || ''}</td>
        <td>${b.serviceType || ''}</td>
        <td>${badge(b.status)}</td>
      </tr>
    `).join('') || `<tr><td colspan="5">Нет записей на сегодня</td></tr>`;

    const withDiagnostics = orders.filter(o => o.diagnosticsSubmittedAt);
    document.getElementById('diagnostics-list').innerHTML = withDiagnostics.map(o => `
      <div style="padding:10px 0; border-bottom:1px solid #f0f0f0;">
        <strong>${o.model}</strong> ${o.plate ? `(${o.plate})` : ''}<br>
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
      <td>${c.name}</td>
      <td>${c.phone || ''}</td>
      <td>${c.email || ''}</td>
      <td>${(c.cars || []).length}</td>
      <td>${c.lastVisit || ''}</td>
      <td>${(c.totalSpent || 0).toLocaleString('ru-RU')} ₽</td>
    </tr>
  `).join('');
}

// ── Вкладка "Автомобили" ──
async function renderCars() {
  const cars = await fetchJSON('/api/cars');
  document.querySelector('#table-cars tbody').innerHTML = cars.map(c => `
    <tr>
      <td>${c.model}</td>
      <td>${c.plate}</td>
      <td>${(c.mileage || 0).toLocaleString('ru-RU')} км</td>
      <td>${c.year || ''}</td>
    </tr>
  `).join('');
}

// ── Вкладка "Заказы" ──
async function renderOrders() {
  const orders = await fetchJSON('/api/orders');
  document.querySelector('#table-orders tbody').innerHTML = orders.map(o => `
    <tr>
      <td>${o.time || ''}</td>
      <td>${o.model}</td>
      <td>${o.plate}</td>
      <td>${o.issue}</td>
      <td>${badge(o.status)}</td>
    </tr>
  `).join('');
}

// ── Вкладка "Записи" ──
async function renderBookingsFull() {
  const bookings = await fetchJSON('/api/bookings');
  document.querySelector('#table-bookings-full tbody').innerHTML = bookings.map(b => `
    <tr>
      <td>${b.date}</td>
      <td>${b.time}</td>
      <td>${b.carModel} (${b.plate})</td>
      <td>${b.serviceType}</td>
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
    <div class="metric-card green"><div class="num">${totalSpent.toLocaleString('ru-RU')} ₽</div><div class="label">Общая выручка</div></div>
    <div class="metric-card orange"><div class="num">${orders.length}</div><div class="label">Всего заказов</div></div>
    <div class="metric-card red"><div class="num">${lowStock}</div><div class="label">Запчасти на исходе</div></div>
  `;
}

renderToday();
renderClients();
renderCars();
renderOrders();
renderBookingsFull();
renderAnalytics();
setInterval(renderToday, 30_000);
