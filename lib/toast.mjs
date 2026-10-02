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

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export function toastXml({ title, body, url }) {
  return `<toast activationType="protocol" launch="${esc(url)}"><visual><binding template="ToastGeneric">`
    + `<text>${esc(title)}</text>${body ? `<text>${esc(body)}</text>` : ''}</binding></visual></toast>`;
}

// onExit(code) — для server.log: только код выхода, без текста (6.3)
export function showToast({ title, body }, { url, spawn = nodeSpawn, onExit = () => {} }) {
  const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT], {
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, [ENV_KEY]: toastXml({ title, body, url }) },
  });
  child.on('error', () => onExit(-1));
  child.on('exit', (code) => onExit(code));
  return child;
}
