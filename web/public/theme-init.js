// Тема до первой отрисовки, чтобы не мигало: 'auto' | 'light' | 'dark' в localStorage 'ceh-theme' (как в макете).
try { var t = localStorage.getItem('ceh-theme'); if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t); } catch (e) {}
