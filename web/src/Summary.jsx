// Заголовок свёртки <details> с уголком — общий для «Цеха», окна проекта и «Отложено» (вынесен из Ceh.jsx: без кольцевого
// импорта Ceh.jsx ↔ Defer.jsx, Голем М12)
export function Summary({ children, ...rest }) {
  return <summary {...rest}><span className="car" aria-hidden="true">›</span>{children}</summary>;
}

// «подробнее» у пункта (EXT-125): служебное — номер карточки, след, хеши, пути — не удаляется, а прячется сюда; закрыто всегда
export function More({ children, label = 'подробнее' }) {
  return <details className="dd"><summary>{label}</summary><div className="ddb">{children}</div></details>;
}
