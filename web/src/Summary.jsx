// Заголовок свёртки <details> с уголком — общий для «Цеха», окна проекта и «Отложено» (вынесен из Ceh.jsx: без кольцевого
// импорта Ceh.jsx ↔ Defer.jsx, Голем М12)
export function Summary({ children, ...rest }) {
  return <summary {...rest}><span className="car" aria-hidden="true">›</span>{children}</summary>;
}
