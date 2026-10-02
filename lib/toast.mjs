// Тост Windows из серверного процесса (спека 4.1 «способ»): без новой зависимости — WinRT ToastNotificationManager
// через Windows PowerShell 5.1, который есть в каждой Windows 10/11; прав администратора не нужно.
// Ни одного окна консоли: spawn с windowsHide: true даёт CREATE_NO_WINDOW — консоль процессу не создаётся вовсе
// (а не создаётся и прячется, как у `-WindowStyle Hidden`, грабля Т4). Текст тоста — XML в переменной окружения,
// сценарий PowerShell постоянный: текст из журналов не попадает в командную строку и не исполняется.
// Отправитель — идентификатор приложения Windows PowerShell (он зарегистрирован в системе): своё имя отправителя
// потребовало бы записи в реестр или ярлыка в меню «Пуск» — вне data/vitrina (6.5).
// Щелчок по тосту — activationType="protocol": Windows открывает адрес витрины («Цех») браузером по умолчанию.
import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';

export const AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const ENV_KEY = 'EXTRACTOR_TOAST_XML';

const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]',
  '[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]',
  '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
  `$x.LoadXml($env:${ENV_KEY})`,
  `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${AUMID}').Show([Windows.UI.Notifications.ToastNotification]::new($x))`,
].join('; ');

// управляющие символы, кроме табуляции и переводов строки, в XML 1.0 недопустимы — LoadXml упал бы
const esc = (s) => String(s ?? '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export function toastXml({ title, body, url }) {
  return `<toast activationType="protocol" launch="${esc(url)}"><visual><binding template="ToastGeneric">`
    + `<text>${esc(title)}</text>${body ? `<text>${esc(body)}</text>` : ''}</binding></visual></toast>`;
}

// Запуск одного тоста; ожидание выхода, потолок и порядок — createToastQueue.
export function showToast({ title, body }, { url, spawn = nodeSpawn }) {
  const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT], {
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, [ENV_KEY]: toastXml({ title, body, url }) },
  });
  child.on('error', () => {}); // ошибку запуска забирает очередь; без слушателя она уронила бы процесс
  return child;
}

// Очередь тостов: строго по одному процессу; следующий — после выхода предыдущего; зависший убивается через timeoutMs
// (потолок — вердикт Голема на В8). onDone(код) — один раз на тост: код выхода, код ошибки запуска или 'timeout'
// (error и exit одного процесса — одна запись в server.log).
export function createToastQueue({ run, timeoutMs = 15000, onDone = () => {} }) {
  const queue = [];
  let active = false;
  let waiters = [];
  const next = () => {
    if (active) return;
    if (queue.length === 0) { const w = waiters; waiters = []; for (const f of w) f(); return; }
    const r = queue.shift();
    active = true;
    let done = false;
    let timer = null;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      active = false;
      onDone(code);
      next();
    };
    let child;
    try {
      child = run(r);
      child.on('error', (e) => finish(e?.code ?? 'ERR'));
      child.on('exit', (code) => finish(code));
    } catch (e) { finish(e?.code ?? 'ERR'); return; }
    timer = setTimeout(() => { try { child.kill(); } catch { /* уже вышел */ } finish('timeout'); }, timeoutMs);
    timer.unref?.();
  };
  return {
    push(r) { queue.push(r); next(); },
    // для тестов и остановки: дождаться пустой очереди
    idle: () => (active || queue.length ? new Promise((res) => waiters.push(res)) : Promise.resolve()),
  };
}
