/** Открыть отчёт, нажать «Найти», дождаться страницы и собрать адреса. */
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

function getPointNumber() {
  // 1) Кандидаты в шапке
  for (const sel of S.pointCandidates) {
    let nodes;
    try {
      nodes = document.querySelectorAll(sel);
    } catch {
      continue;
    }
    for (const node of nodes) {
      const hit =
        matchPoint(node.innerText || node.textContent || '', sel) ||
        matchPoint(collectDeepText(node).join(' '), `${sel}+deep`);
      if (hit) return hit;
    }
  }

  // 2) Кнопки / combobox рядом с верхом страницы
  const controls = document.querySelectorAll(
    'button, [role="button"], [role="combobox"], [role="listbox"], [aria-haspopup]'
  );
  for (const node of controls) {
    const rect = node.getBoundingClientRect?.();
    if (rect && rect.top > 120) continue;
    const hit =
      matchPoint(node.innerText || node.textContent || '', 'control') ||
      matchPoint(collectDeepText(node).join(' '), 'control+deep');
    if (hit) return hit;
  }

  // 3) Весь документ + shadow
  const deep = collectDeepText(document.documentElement).join(' ');
  const fromDeep = matchPoint(deep, 'deep');
  if (fromDeep) return fromDeep;

  const fromBody = matchPoint(document.body?.innerText || '', 'body');
  if (fromBody) return fromBody;

  // 4) Запасной вариант: только цифры после «ПП»/«PP» без разделителя
  const loose = normalizeSpaces(deep || document.body?.innerText || '').match(
    /(?:пп|pp)\s*[_\-–—./]?\s*(\d{3,6})/i
  );
  if (loose) {
    return { point_number: loose[1], raw: loose[0], source: 'loose' };
  }
  return null;
}


function clickFindButton() {
  const texts = S.findButtonTexts || ['Найти'];
  const nodes = visibleClickableNodes()
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { el, t: nodeLabel(el), top: r.top, left: r.left, width: r.width };
    })
    // боковое меню слева обычно < 220px; кнопку «Найти» ищем в контенте
    .filter((x) => x.left > 180)
    .sort((a, b) => a.top - b.top || a.left - b.left);

  for (const want of texts) {
    const hit = nodes.find((n) => labelMatchesWant(n.t, want));
    if (hit) {
      robustClick(hit.el);
      return { clicked: true, label: hit.t };
    }
  }
  // fallback: любой «Найти» на странице (без фильтра по left)
  for (const want of texts) {
    const hit = visibleClickableNodes().find((n) => labelMatchesWant(nodeLabel(n), want));
    if (hit) {
      robustClick(hit);
      return { clicked: true, label: nodeLabel(hit) };
    }
  }
  return { clicked: false };
}


async function prepareReportPage({
  settleMs = 400,
  ensureTab = null,
  openReportsMenu = false,
  requireNonZero = false,
} = {}) {
  await settle(settleMs);

  if (openReportsMenu) {
    const reports = clickTabByText(['отчёты', 'отчеты']);
    if (reports.clicked) await sleep(700);
  }

  if (ensureTab?.length) {
    const tab = clickTabByText(ensureTab);
    if (tab.clicked) await sleep(1000);
  }

  let before = scrapeFoundCount();
  if (!before.ok) {
    try {
      before = await waitFor(() => {
        const found = scrapeFoundCount();
        return found.ok ? found : null;
      }, { timeoutMs: 6000, intervalMs: 250 });
    } catch (_) {
      before = scrapeFoundCount();
    }
  }
  if (before.ok && !(requireNonZero && before.value === 0)) {
    return {
      ok: true,
      findClicked: false,
      findLabel: null,
      before: before.value,
      value: before.value,
      tableRows: document.querySelectorAll('table tbody tr').length,
      error: null,
      diagnostics: pageDiagnostics(),
    };
  }

  let click = clickFindButton();
  if (!click.clicked) {
    await sleep(600);
    click = clickFindButton();
  }
  if (click.clicked) {
    await sleep(200);
    try {
      await waitFor(() => {
        const found = scrapeFoundCount();
        if (!found.ok) return null;
        if (requireNonZero && found.value === 0 && before.ok && before.value === 0) {
          // ещё грузится
          return null;
        }
        return found;
      }, { timeoutMs: 18000, intervalMs: 400 });
    } catch (_) {
      /* ниже */
    }
  } else {
    const input = queryAllDeep('input').filter(isVisible)[0];
    if (input) {
      input.focus();
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })
      );
      await sleep(1500);
    }
  }

  let after = scrapeFoundCount();

  // Повтор «Найти», если остатки 0 — часто поиск ещё не запускался
  if (requireNonZero && after.ok && after.value === 0) {
    const retry = clickFindButton();
    if (retry.clicked) {
      click = retry;
      await sleep(2000);
      try {
        after = await waitFor(() => {
          const found = scrapeFoundCount();
          return found.ok && found.value > 0 ? found : null;
        }, { timeoutMs: 12000, intervalMs: 400 });
      } catch (_) {
        after = scrapeFoundCount();
      }
    }
  }

  const diag = pageDiagnostics();
  const tableRows = document.querySelectorAll('table tbody tr').length;

  // 0 при ненажатом «Найти» или пустой таблице без подтверждения — ошибка для остатков
  if (requireNonZero && after.ok && after.value === 0 && !click.clicked) {
    return {
      ok: false,
      findClicked: false,
      findLabel: null,
      before: before.ok ? before.value : null,
      value: 0,
      error:
        'Остатки: «Найдено: 0» и кнопка «Найти» не нажата. Откройте Отчёты → Остатки на складе и проверьте кнопку.',
      diagnostics: { ...diag, tableRows },
    };
  }

  return {
    ok: after.ok,
    findClicked: click.clicked,
    findLabel: click.label || null,
    before: before.ok ? before.value : null,
    value: after.ok ? after.value : null,
    tableRows,
    error: after.ok
      ? null
      : after.error ||
        `После «Найти» нет «Найдено». Кнопка: ${click.clicked ? click.label : 'не найдена'}. URL: ${diag.href}`,
    diagnostics: { ...diag, tableRows },
  };
}


function buildGiveoutUrl() {
  const t = todayLocalParts();
  const filter = {
    startDate: t.startIso,
    endDate: t.endIso,
  };
  const encoded = encodeURIComponent(JSON.stringify(filter));
  return `https://turbo-pvz.ozon.ru/reports/giveout?filter=${encoded}`;
}


async function scrapeWarehouseLeftover() {
  const hrefDecoded = decodeURIComponent(location.href || '');
  if (!hrefDecoded.includes('GRPC_REMNANT_FILTER_ARTICLE_POSTING')) {
    return {
      ok: false,
      error: 'Остатки: открыт не фильтр «Отправление»',
      diagnostics: pageDiagnostics(),
    };
  }

  // Сначала сайт показывает «Найдено: 0», настоящее число появляется через пару секунд.
  const started = Date.now();
  let zeroSince = 0;
  let stableValue = null;
  let stableSince = 0;
  while (Date.now() - started < 20000) {
    const found = scrapeFoundCount();
    if (found.ok && found.value > 0) {
      if (stableValue === found.value && Date.now() - stableSince >= 500) {
        return { ok: true, value: found.value, findClicked: false, diagnostics: pageDiagnostics() };
      }
      if (stableValue !== found.value) {
        stableValue = found.value;
        stableSince = Date.now();
      }
      zeroSince = 0;
    } else if (found.ok && found.value === 0) {
      stableValue = null;
      if (!zeroSince) zeroSince = Date.now();
      if (Date.now() - zeroSince >= 8000) {
        return { ok: true, value: 0, findClicked: false, diagnostics: pageDiagnostics() };
      }
    }
    await sleep(300);
  }

  const last = scrapeFoundCount();
  if (last.ok && last.value > 0) {
    return { ok: true, value: last.value, findClicked: false, diagnostics: pageDiagnostics() };
  }
  return {
    ok: false,
    error: 'Остатки: «Найдено:» не успело обновиться после нуля',
    diagnostics: pageDiagnostics(),
  };
}


function buildRemainsUrl() {
  // Кавычки в фильтре кодируются, скобки остаются как в рабочей ссылке Турбо.
  const filter = JSON.stringify({ filter: ['GRPC_REMNANT_FILTER_ARTICLE_POSTING'] }).replace(/"/g, '%22');
  return `https://turbo-pvz.ozon.ru/reports/remains?filter=${filter}`;
}


function buildTareUrl() {
  // Отчёты → Остатки → Тип = «Тарный ящик», 100 строк на странице.
  const filter = encodeURIComponent(JSON.stringify({ filter: ['GRPC_REMNANT_FILTER_ARTICLE_BOX_TARE'] }));
  const pagination = encodeURIComponent(JSON.stringify({ page: 1, rowsPerPage: 100 }));
  return `https://turbo-pvz.ozon.ru/reports/remains?filter=${filter}&pagination=${pagination}`;
}


function buildOzonShelfUrl() {
  return 'https://turbo-pvz.ozon.ru/reports/micro-ff-stock';
}


function ozonShelfDenied() {
  const href = location.href || '';
  if (/forbidden/i.test(href)) return true;
  const text = document.body?.innerText || '';
  return /доступ запрещ/i.test(text);
}


async function scrapeOzonShelf() {
  const href = location.href || '';
  if (!href.includes('/reports/micro-ff-stock')) {
    return {
      ok: false,
      error: 'Озон полка: открыта не та страница, сбор пошёл дальше',
      diagnostics: pageDiagnostics(),
    };
  }

  if (ozonShelfDenied()) {
    return { ok: false, unavailable: true };
  }

  // Итог на странице — «Всего». «Найти» здесь ищет товар по штрихкоду, её не жмём.
  let total = scrapeTotalCount();
  if (!total.ok) {
    try {
      const ready = await waitFor(
        () => {
          if (ozonShelfDenied()) return { unavailable: true };
          const next = scrapeTotalCount();
          return next.ok ? next : null;
        },
        { timeoutMs: 4000, intervalMs: 200 }
      );
      if (ready?.unavailable) return { ok: false, unavailable: true };
      total = ready;
    } catch (_) {
      if (ozonShelfDenied()) return { ok: false, unavailable: true };
      total = scrapeTotalCount();
    }
  }

  if (!total?.ok) {
    return {
      ok: false,
      error: 'Озон полка: нет строки «Всего». Остальные пункты отчёта собираются дальше',
      diagnostics: pageDiagnostics(),
    };
  }
  return { ok: true, value: total.value, diagnostics: pageDiagnostics() };
}


function buildCarriagesUrl() {
  return 'https://turbo-pvz.ozon.ru/carriages_list/finished';
}


function buildCarriageDetailUrl(longId) {
  return `https://turbo-pvz.ozon.ru/carriages_list/finished-carriage-detail/${longId}`;
}


function reportPageReady() {
  const text = document.body?.innerText || '';
  if (/Найдено\s*:/i.test(text)) return true;
  if (document.querySelector('table tbody tr')) return true;
  if (/Сегодня\s+принято/i.test(text)) return true;
  return visibleClickableNodes().some((el) => /^найти$/i.test(nodeLabel(el)));
}


async function settle(ms = 400) {
  if (reportPageReady()) return;
  await waitUntil(reportPageReady, Math.min(ms, 1200));
}

  Object.assign(api, { getPointNumber, clickFindButton, prepareReportPage, scrapeWarehouseLeftover, buildGiveoutUrl, buildRemainsUrl, buildTareUrl, buildOzonShelfUrl, scrapeOzonShelf, buildCarriagesUrl, buildCarriageDetailUrl, reportPageReady, settle });
})();
