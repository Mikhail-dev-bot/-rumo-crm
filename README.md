# -rumo-crm

[Edit in StackBlitz next generation editor ⚡️](https://stackblitz.com/~/github.com/Mikhail-dev-bot/-rumo-crm)
## Загрузка фото (Cloudinary)
Эндпоинт `POST /api/upload` принимает `{ "image": "data:image/jpeg;base64,..." }`, загружает картинку в Cloudinary и возвращает `{ "url": "https://res.cloudinary.com/..." }`.
Нужны переменные окружения на сервере (Render → Environment):
`CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`.
Без них эндпоинт отвечает 503.
