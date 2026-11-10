// Создаёт стартовых пользователей: мастер, механик и по аккаунту на каждого клиента.
// Запуск:  node scripts/make-users.js <clients.json> <папка-вывода>
// Результат: users.json (хэши паролей, его кладут в бин BIN_USERS) и passwords.txt (пароли открытым текстом).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { hashPassword, normLogin } = require('../auth');

const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без похожих символов
const randomPassword = (len = 10) =>
  Array.from(crypto.randomBytes(len), (b) => ALPHABET[b % ALPHABET.length]).join('');

async function main() {
  const [clientsPath, outDir] = process.argv.slice(2);
  if (!clientsPath || !outDir) {
    console.error('Использование: node scripts/make-users.js <clients.json> <папка-вывода>');
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(clientsPath, 'utf8'));
  const clients = Array.isArray(raw) ? raw : raw.clients;

  const people = [
    { login: 'master', name: 'Петров И.И.', role: 'master', clientId: null },
    { login: 'mechanic', name: 'Петров И.И.', role: 'mechanic', clientId: null },
    ...clients.map((c) => ({
      login: normLogin(c.phone), name: c.name, role: 'client', clientId: c.id,
    })),
  ];

  const users = [];
  const lines = ['логин | имя | роль | пароль', ''];
  for (const [i, p] of people.entries()) {
    const password = randomPassword();
    users.push({ id: i + 1, ...p, passHash: await hashPassword(password) });
    lines.push(`${p.login} | ${p.name} | ${p.role} | ${password}`);
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'users.json'), JSON.stringify({ users }, null, 2));
  fs.writeFileSync(path.join(outDir, 'passwords.txt'), `${lines.join('\n')}\n`);
  console.log(`Создано пользователей: ${users.length}`);
}

main();
