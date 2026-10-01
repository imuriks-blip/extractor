// Проверка параметров ручек до любого чтения диска (спека витрины 1.6):
// :code — ^[A-Z]{2,6}$ и код есть в projects.md доски; :id — ^[A-Z]{2,6}-\d+$ и код из него есть там же.
// Словарь кодов — из кэша читателя доски (hasCode), не с диска.
const CODE_RE = /^[A-Z]{2,6}$/;
const ID_RE = /^([A-Z]{2,6})-(\d+)$/;

export function validCode(code, hasCode) {
  return typeof code === 'string' && CODE_RE.test(code) && hasCode(code) === true;
}

export function validCardId(id, hasCode) {
  if (typeof id !== 'string') return false;
  const m = id.match(ID_RE);
  return !!m && hasCode(m[1]) === true;
}
