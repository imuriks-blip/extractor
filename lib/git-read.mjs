// Обёртка git — одна на всю витрину (спека витрины 1.2, гейт п.7).
// Каждый вызов: git --no-optional-locks -C <путь> <команда> …, windowsHide: true.
// Команда — только из белого списка читающих; иное — исключение ДО запуска процесса:
// обычный `git status` берёт index.lock и ломал бы коммиты тредов (грабля INFRA-63).
import { execFile } from 'node:child_process';

const notFlag = (a) => typeof a === 'string' && a.length > 0 && !a.startsWith('-');

// подкоманда → проверка остальных аргументов (обязательный флаг, где он делает команду читающей)
const ALLOWED = {
  status: (rest) => rest.includes('--porcelain'),
  'rev-parse': () => true,
  log: () => true,
  diff: (rest) => rest.includes('--name-only'),
  show: () => true,
  worktree: (rest) => rest[0] === 'list',
  // по форме вызова (спека пульта §0, Н5): ровно `branch --list <шаблон> [--format=…]` — голое имя создало бы ветку,
  // -D удалило бы; ровно `merge-base --is-ancestor <a> <b>` — «Принять» (В7), ветка карточки слита ли в main
  branch: (rest) => rest[0] === '--list' && notFlag(rest[1]) && (rest.length === 2 || (rest.length === 3 && /^--format=/.test(rest[2]))),
  'merge-base': (rest) => rest.length === 3 && rest[0] === '--is-ancestor' && notFlag(rest[1]) && notFlag(rest[2]),
};
// флаги, которые пишут файл или зовут внешние программы. Глобальные -c/-C/--git-dir после подкоманды
// глобальными не являются (у log -C — поиск копий) — не запрещаются (вердикт Голема).
const FORBIDDEN = [/^--output(=|$)/, /^--ext-diff$/, /^--textconv$/];
// log и show — внешние программы (textconv, внешний diff) не запускаются никогда
const FORCED = { log: ['--no-textconv', '--no-ext-diff'], show: ['--no-textconv', '--no-ext-diff'] };

export function checkArgs(args) {
  if (!Array.isArray(args) || args.length === 0) throw new Error('git-read: пустая команда');
  const [sub, ...rest] = args;
  const rule = Object.hasOwn(ALLOWED, sub) ? ALLOWED[sub] : null;
  if (!rule) throw new Error(`git-read: команда «${sub}» не в белом списке`);
  if (!rule(rest)) throw new Error(`git-read: «${sub}» без обязательной читающей формы`);
  for (const a of rest) {
    if (typeof a !== 'string') throw new Error('git-read: аргумент не строка');
    if (FORBIDDEN.some((re) => re.test(a))) throw new Error(`git-read: флаг «${a}» запрещён`);
  }
}

// bin/prefix — для подменного git в тестах (node fake-git.mjs); env — дополнение окружения.
export function createGitRead({ bin = 'git', prefix = [], env = {}, timeoutMs = 15000, onCall } = {}) {
  return async function gitRead(repo, args) {
    checkArgs(args);
    if (typeof repo !== 'string' || !repo) throw new Error('git-read: нет пути репозитория');
    onCall?.(repo);
    const [sub, ...rest] = args;
    const argv = [...prefix, '--no-optional-locks', '-C', repo, sub, ...(FORCED[sub] ?? []), ...rest];
    return new Promise((resolve, reject) => {
      execFile(bin, argv, {
        windowsHide: true,
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...env },
      }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
  };
}
