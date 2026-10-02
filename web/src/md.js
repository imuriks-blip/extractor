// Markdown карточки → HTML с очисткой (2.6). Два слоя, своего разборщика нет:
// 1) markdown-it с html: false — сырой HTML из текста идёт текстом (экранируется), картинки выключены
//    (внешний адрес — это запрос наружу), ссылка становится ссылкой только при http(s);
// 2) DOMPurify по белому списку тегов и атрибутов — на случай ошибки первого слоя; у каждой ссылки
//    href только http(s), target="_blank" и rel="noreferrer".
// Результат mdToHtml — единственное, что витрина вставляет готовым HTML (CardPanel.jsx, <Md>).
import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';

const HTTP = /^https?:\/\//i;

const md = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: false });
md.disable(['image']);
md.validateLink = (url) => HTTP.test(String(url).trim());
const linkOpen = md.renderer.rules.link_open || ((tokens, i, opts, env, self) => self.renderToken(tokens, i, opts));
md.renderer.rules.link_open = (tokens, i, opts, env, self) => {
  tokens[i].attrSet('target', '_blank');
  tokens[i].attrSet('rel', 'noreferrer');
  return linkOpen(tokens, i, opts, env, self);
};

const purify = DOMPurify();
purify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName !== 'A') return;
  const href = node.getAttribute('href') || '';
  if (!HTTP.test(href)) node.removeAttribute('href');
  node.setAttribute('target', '_blank');
  node.setAttribute('rel', 'noreferrer');
});
const CFG = {
  ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 's', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'hr',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
  ALLOWED_ATTR: ['href', 'target', 'rel', 'start'],
  ALLOW_DATA_ATTR: false,
};

export function mdToHtml(src) {
  return purify.sanitize(md.render(String(src ?? '')), CFG);
}
