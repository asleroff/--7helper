/** Тара: строки КТЯ и переход по страницам списка. */
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
  const scrapeFoundCount = (...args) => api.scrapeFoundCount(...args);
  const scrapeTotalCount = (...args) => api.scrapeTotalCount(...args);
  const pageDiagnostics = (...args) => api.pageDiagnostics(...args);
  const getPointNumber = (...args) => api.getPointNumber(...args);
  const clickFindButton = (...args) => api.clickFindButton(...args);
  const prepareReportPage = (...args) => api.prepareReportPage(...args);
  const buildGiveoutUrl = (...args) => api.buildGiveoutUrl(...args);
  const buildRemainsUrl = (...args) => api.buildRemainsUrl(...args);
  const buildTareUrl = (...args) => api.buildTareUrl(...args);
  const buildCarriagesUrl = (...args) => api.buildCarriagesUrl(...args);
  const buildCarriageDetailUrl = (...args) => api.buildCarriageDetailUrl(...args);
  const reportPageReady = (...args) => api.reportPageReady(...args);
  const settle = (...args) => api.settle(...args);

function tareRowEntries() {
  const rows = Array.from(document.querySelectorAll('table tbody tr'));
  return rows
    .map((row) => normalizeSpaces(row.innerText || row.textContent))
    .filter((text) => text && text.length > 2)
    .filter((text) => !(/тип|наименован|артикул/i.test(text) && text.length < 80));
}


async function countKtyaAcrossPages(total) {
  const seen = new Set();
  let ktya = 0;
  let pages = 0;
  const warnings = [];
  let previousSignature = '';

  for (let page = 0; page < 40; page += 1) {
    const entries = tareRowEntries();
    const signature = entries.join('\n');
    if (page > 0 && signature && signature === previousSignature) break;
    previousSignature = signature;
    pages += 1;
    entries.forEach((text) => {
      const key = text.slice(0, 180);
      if (seen.has(key)) return;
      seen.add(key);
      if (S.ktyaMarkerRegex.test(text)) ktya += 1;
    });
    if (total > 0 && seen.size >= total) break;
    const next = findNextPageControl();
    if (!next) break;
    robustClick(next);
    try {
      await waitFor(
        () => {
          const nextSignature = tareRowEntries().join('\n');
          return nextSignature && nextSignature !== signature ? true : null;
        },
        { timeoutMs: 8000, intervalMs: 300 }
      );
    } catch (_) {
      warnings.push('Тара: следующая страница не открылась');
      break;
    }
  }

  if (total > 0 && seen.size < total) {
    warnings.push(
      `Тара: просмотрено ${seen.size} из ${total}. Если список длиннее экрана и нет кнопки «далее», КТЯ может быть неполным.`
    );
  }
  return { ktya, scanned: seen.size, pages, warnings };
}


async function scrapeTareAcrossPages() {
  const base = scrapeTareRemains();
  if (!base.ok) return base;
  const paged = await countKtyaAcrossPages(base.total);
  if (!paged.scanned) return base;
  const ktya = paged.ktya;
  const tya = Math.max(0, base.total - ktya);
  const warnings = [...(base.warnings || []), ...paged.warnings];
  if (ktya > base.total) {
    warnings.push(`КТЯ (${ktya}) больше «Найдено» (${base.total}) — проверьте разметку`);
  }
  return {
    ok: true,
    total: base.total,
    ktya,
    tya,
    scanned: paged.scanned,
    pages: paged.pages,
    warnings,
    formula: `ТЯ=${base.total}-${ktya}=${tya}`,
  };
}


function scrapeTareRemains() {
  const warnings = [];
  const href = decodeURIComponent(location.href || '');
  if (!href.includes('GRPC_REMNANT_FILTER_ARTICLE_BOX_TARE')) {
    warnings.push(
      'Страница остатков без фильтра «Тарный ящик» — ТЯ/КТЯ могут быть неверными'
    );
  }

  const found = scrapeFoundCount();
  if (!found.ok) return found;

  // «Найдено: N» при фильтре «Тарный ящик» = всего тары (ТЯ + КТЯ)
  const total = found.value;
  let ktya = 0;

  // Считаем строки таблицы, в названии которых есть «КТЯ»
  const rows = document.querySelectorAll('table tbody tr');
  const rowList = rows.length
    ? Array.from(rows)
    : Array.from(document.querySelectorAll('[role="row"]')).filter((row) => {
        const t = normalizeSpaces(row.innerText || row.textContent);
        return t && !(/тип|наименован|артикул|найдено/i.test(t) && t.length < 80);
      });

  rowList.forEach((row) => {
    const t = normalizeSpaces(row.innerText || row.textContent);
    if (!t) return;
    if (/тип|наименован|артикул/i.test(t) && t.length < 80) return;
    if (S.ktyaMarkerRegex.test(t)) ktya += 1;
  });

  if (!rowList.length) {
    // Запасной: строки текста с «КТЯ» (не заголовок фильтра)
    const chunks = (document.body.innerText || '').split('\n');
    chunks.forEach((line) => {
      const n = normalizeSpaces(line);
      if (!n || n.length > 220) return;
      if (/^тип\b/i.test(n) || /тарный ящик/i.test(n)) return;
      if (S.ktyaMarkerRegex.test(n)) ktya += 1;
    });
    if (ktya > 0) {
      warnings.push('Строки таблицы тары не найдены — КТЯ посчитан по тексту страницы');
    }
  }

  // ТЯ = всего тары − число строк с пометкой КТЯ
  const tya = Math.max(0, total - ktya);
  if (ktya > total) {
    warnings.push(`КТЯ (${ktya}) больше «Найдено» (${total}) — проверьте разметку`);
  }
  if (total === 0) {
    warnings.push('Тарных ящиков: Найдено 0');
  }

  return {
    ok: true,
    total,
    ktya,
    tya,
    warnings,
    formula: `ТЯ=${total}-${ktya}=${tya}`,
  };
}

  Object.assign(api, { tareRowEntries, countKtyaAcrossPages, scrapeTareAcrossPages, scrapeTareRemains });
})();
