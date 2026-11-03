/** Чтение чисел «Найдено» и «Всего». */
(() => {
  const api = (window.TurboClose = window.TurboClose || {});
  const S = window.TurboPvzSelectors;
  if (!S) {
    console.error('[turbo-close] selectors.js не загружен');
    return;
  }
  const sleep = (...args) => api.sleep(...args);
  const normalizeSpaces = (...args) => api.normalizeSpaces(...args);
  const parseIntLoose = (...args) => api.parseIntLoose(...args);
  const todayLocalParts = (...args) => api.todayLocalParts(...args);
  const waitFor = (...args) => api.waitFor(...args);
  const matchPoint = (...args) => api.matchPoint(...args);
  const collectDeepText = (...args) => api.collectDeepText(...args);
  const setNativeValue = (...args) => api.setNativeValue(...args);
  const queryAllDeep = (...args) => api.queryAllDeep(...args);
  const isVisible = (...args) => api.isVisible(...args);
  const visibleClickableNodes = (...args) => api.visibleClickableNodes(...args);
  const nodeLabel = (...args) => api.nodeLabel(...args);
  const robustClick = (...args) => api.robustClick(...args);
  const labelMatchesWant = (...args) => api.labelMatchesWant(...args);
  const clickButtonLabel = (...args) => api.clickButtonLabel(...args);
  const isControlDisabled = (...args) => api.isControlDisabled(...args);
  const findNextPageControl = (...args) => api.findNextPageControl(...args);
  const clickTabByText = (...args) => api.clickTabByText(...args);
  const waitUntil = (...args) => api.waitUntil(...args);

function scrapeFoundCount() {
  const sources = [
    document.body?.innerText || '',
    collectDeepText(document.documentElement).join(' '),
  ];
  for (const text of sources) {
    const m = text.match(S.foundCountRegex);
    if (!m) continue;
    const value = parseIntLoose(m[1]);
    if (value != null) return { ok: true, value, matched: m[0] };
  }

  // Подпись «Найдено» и число рядом (НЕ «Всего» — на карточке перевозки «Всего» = все места)
  const nodes = queryAllDeep('span, div, p, b, strong, label').filter(isVisible);
  for (const el of nodes) {
    const t = normalizeSpaces(el.innerText || el.textContent);
    if (!/^найдено:?$/i.test(t)) continue;
    const parentText = normalizeSpaces(el.parentElement?.innerText || '');
    const m = parentText.match(S.foundCountRegex);
    if (m) {
      const value = parseIntLoose(m[1]);
      if (value != null) return { ok: true, value, matched: m[0], via: 'label-sibling' };
    }
    const next = normalizeSpaces(
      el.nextElementSibling?.innerText || el.nextSibling?.textContent || ''
    );
    const n = parseIntLoose(next);
    if (n != null) return { ok: true, value: n, matched: next, via: 'next-sibling' };
  }

  return { ok: false, error: 'Не найден текст «Найдено: N» на странице' };
}


function scrapeTotalCount() {
  const text = document.body?.innerText || '';
  const m = text.match(/Всего\s*:?\s*([\d\s\u00a0\u202f]+)/i);
  if (!m) return { ok: false };
  const value = parseIntLoose(m[1]);
  if (value == null) return { ok: false };
  return { ok: true, value, matched: m[0] };
}


function pageDiagnostics() {
  const findBtns = visibleClickableNodes().filter((n) => {
    const t = nodeLabel(n).toLowerCase();
    return t === 'найти' || t.startsWith('найти') || t === 'применить';
  });
  const found = scrapeFoundCount();
  const text = (document.body?.innerText || '').slice(0, 500);
  return {
    href: location.href,
    findButtons: findBtns.slice(0, 5).map((b) => nodeLabel(b)),
    foundOk: found.ok,
    foundValue: found.ok ? found.value : null,
    hasFoundWord: /найдено/i.test(text),
    snippet: text.replace(/\s+/g, ' ').slice(0, 220),
  };
}

  Object.assign(api, { scrapeFoundCount, scrapeTotalCount, pageDiagnostics });
})();
