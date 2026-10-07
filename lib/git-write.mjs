// Пишущая обёртка git — единственная на витрину (спека пульта §0, §1.5; ПТ8б, EXT-83): уборка отслуживших рабочих копий.
// Белый список — РОВНО две формы вызова, проверка по форме, а не по первому слову, и до запуска процесса:
//   worktree remove <путь>   — три аргумента, путь не флаг; никакого --force/-f/--lock и прочих аргументов
//   worktree prune           — без флагов (--expire=… и --dry-run тоже нет)
// Всё иное — исключение ДО запуска процесса. Ветки не удаляются, коммитов нет: откат уборки — `git worktree add <путь> <ветка>`.
import { execFile } from 'node:child_process';

const notFlag = (a) => typeof a === 'string' && a.length > 0 && !a.startsWith('-');

export function checkWriteArgs(args) {
  if (!Array.isArray(args) || args.length === 0) throw new Error('git-write: пустая команда');
  for (const a of args) if (typeof a !== 'string') throw new Error('git-write: аргумент не строка');
  const [sub, verb, target] = args;
  const remove = sub === 'worktree' && verb === 'remove' && args.length === 3 && notFlag(target);
  const prune = sub === 'worktree' && verb === 'prune' && args.length === 2;
  if (!remove && !prune) throw new Error(`git-write: «${args.slice(0, 2).join(' ')}» не в белом списке (только worktree remove <путь> и worktree prune)`);
}

// bin/prefix — для подменного git в тестах; env — дополнение окружения; onCall(repo, args) — на каждый запущенный вызов
export function createGitWrite({ bin = 'git', prefix = [], env = {}, timeoutMs = 60000, onCall } = {}) {
  return async function gitWrite(repo, args) {
    checkWriteArgs(args);
    if (typeof repo !== 'string' || !repo) throw new Error('git-write: нет пути репозитория');
    onCall?.(repo, args);
    const argv = [...prefix, '-C', repo, ...args];
    return new Promise((resolve, reject) => {
      execFile(bin, argv, {
        windowsHide: true,
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
      }, (err, stdout, stderr) => {
        if (err) { err.stderr = stderr; reject(err); } else resolve(stdout);
      });
    });
  };
}
