/** Завершённые перевозки и открытие карточки. */
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
  const tareRowEntries = (...args) => api.tareRowEntries(...args);
  const countKtyaAcrossPages = (...args) => api.countKtyaAcrossPages(...args);
  const scrapeTareAcrossPages = (...args) => api.scrapeTareAcrossPages(...args);
  const scrapeTareRemains = (...args) => api.scrapeTareRemains(...args);

function scrapeAcceptedToday() {
  const text = document.body?.innerText || '';
  // «Сегодня принято: 962» или «Сегодня принято\n962\nотправлений»
  const m = text.match(
    /Сегодня\s+принято\s*:?\s*([\d\s\u00a0\u202f]+)\s*(?:отправлен)?/i
  );
  if (m) {
    const n = parseIntLoose(m[1]);
    if (n != null) return n;
  }
  // Карточки сверху: ищем блок с заголовком «Сегодня принято»
  const nodes = queryAllDeep('div, section, article, span, p, h2, h3, h4').filter(isVisible);
  for (const el of nodes) {
    const t = normalizeSpaces(el.innerText || el.textContent);
    if (!/^сегодня\s+принято$/i.test(t) && !/^сегодня\s+принято\b/i.test(t)) continue;
    if (t.length > 80) continue;
    const block = normalizeSpaces(el.parentElement?.innerText || t);
    const bm = block.match(/сегодня\s+принято\s*:?\s*([\d\s\u00a0\u202f]+)/i);
    if (bm) {
      const n = parseIntLoose(bm[1]);
      if (n != null) return n;
    }
    const next = el.nextElementSibling;
    const nextN = parseIntLoose(next?.innerText || next?.textContent || '');
    if (nextN != null) return nextN;
  }
  return null;
}


function parseClosingDateTime(raw) {
  const t = normalizeSpaces(raw);
  // «31 октября 18:23» or «31.10.2026 18:23»
  const ru = t.match(
    /(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+(\d{1,2}):(\d{2})/i
  );
  if (ru) {
    const day = Number(ru[1]);
    const month = S.monthMap[ru[2].toLowerCase()];
    const year = new Date().getFullYear();
    const hh = ru[3].padStart(2, '0');
    const mm = ru[4];
    return {
      closing_time: `${hh}:${mm}`,
      transport_date: `${String(day).padStart(2, '0')}.${String(month).padStart(2, '0')}.${year}`,
      raw: t,
    };
  }
  const dotted = t.match(/(\d{2})\.(\d{2})\.(\d{4}).*?(\d{1,2}):(\d{2})/);
  if (dotted) {
    return {
      closing_time: `${dotted[4].padStart(2, '0')}:${dotted[5]}`,
      transport_date: `${dotted[1]}.${dotted[2]}.${dotted[3]}`,
      raw: t,
    };
  }
  const timeOnly = t.match(/(\d{1,2}):(\d{2})/);
  if (timeOnly) {
    const today = todayLocalParts();
    return {
      closing_time: `${timeOnly[1].padStart(2, '0')}:${timeOnly[2]}`,
      transport_date: today.displayDate,
      raw: t,
    };
  }
  return null;
}


function isTodayClosing(parsed) {
  if (!parsed?.transport_date) return false;
  const today = todayLocalParts().displayDate;
  return parsed.transport_date === today;
}


function headerIndexMap(table) {
  const map = {};
  const headers = table.querySelectorAll('thead th, thead [role="columnheader"], tr:first-child th');
  headers.forEach((th, i) => {
    const key = normalizeSpaces(th.innerText || th.textContent).toLowerCase();
    if (key) map[key] = i;
  });
  return map;
}


function findCol(map, ...needles) {
  for (const [key, idx] of Object.entries(map)) {
    for (const n of needles) {
      if (key.includes(n.toLowerCase())) return idx;
    }
  }
  return -1;
}


function scrapeFinishedCarriages() {
  const acceptedToday = scrapeAcceptedToday();
  const tables = Array.from(document.querySelectorAll('table'));
  const carriages = [];
  const warnings = [];

  const collectFromTable = (table) => {
    const map = headerIndexMap(table);
    const idxNum = findCol(map, 'номер', 'перевоз');
    const idxClose = findCol(map, 'дата закрытия', 'закрыт');
    const idxShip = findCol(map, 'отправлен');
    const idxShort = findCol(map, 'недостач');
    const idxExcess = findCol(map, 'излиш');

    const rows = table.querySelectorAll('tbody tr');
    rows.forEach((row) => {
      const cells = Array.from(row.querySelectorAll(S.tableCell));
      if (!cells.length) return;
      const texts = cells.map((c) => normalizeSpaces(c.innerText || c.textContent));
      const rowText = texts.join(' | ');

      let longId = null;
      const link =
        row.querySelector('a[href*="finished-carriage-detail"]') ||
        row.closest('a[href*="finished-carriage-detail"]');
      const href = link?.getAttribute('href') || '';
      const hrefMatch = href.match(S.carriageLinkHref);
      if (hrefMatch) longId = hrefMatch[1];
      if (!longId) {
        const html = row.innerHTML || '';
        const fromHtml = html.match(S.carriageLinkHref);
        if (fromHtml) longId = fromHtml[1];
      }
      if (!longId) {
        // Иногда id только в data-* или в тексте длинным числом 13–18 цифр
        for (const attr of Array.from(row.attributes || [])) {
          const m = String(attr.value || '').match(S.carriageLinkHref);
          if (m) {
            longId = m[1];
            break;
          }
        }
      }
      if (!longId) {
        const longNum = rowText.match(/\b(\d{13,18})\b/);
        if (longNum) longId = longNum[1];
      }

      let transportNumber = null;
      if (idxNum >= 0 && texts[idxNum]) {
        const m = texts[idxNum].match(S.shortTransportRegex);
        if (m) transportNumber = m[1];
      }
      if (!transportNumber) {
        for (const t of texts) {
          const m = t.match(S.shortTransportRegex);
          if (m && (!longId || !longId.includes(m[1]))) {
            // Prefer shorter display number over long id fragments
            if (!transportNumber || m[1].length <= transportNumber.length) {
              transportNumber = m[1];
            }
          }
        }
      }

      const closeRaw = idxClose >= 0 ? texts[idxClose] : rowText;
      const parsedClose = parseClosingDateTime(closeRaw);
      const shipments = idxShip >= 0 ? parseIntLoose(texts[idxShip]) : null;
      const shortage = idxShort >= 0 ? parseIntLoose(texts[idxShort]) : null;
      const excess = idxExcess >= 0 ? parseIntLoose(texts[idxExcess]) : null;

      if (!transportNumber && !longId) return;

      carriages.push({
        transport_number: transportNumber,
        carriage_long_id: longId,
        closing_time: parsedClose?.closing_time || null,
        transport_date: parsedClose?.transport_date || null,
        closing_raw: parsedClose?.raw || closeRaw || null,
        is_today: parsedClose ? isTodayClosing(parsedClose) : false,
        accepted: shipments,
        shortage,
        excess,
        row_preview: rowText.slice(0, 200),
      });
    });
  };

  if (tables.length) {
    tables.forEach(collectFromTable);
  } else {
    // Fallback: row-like nodes with links
    document.querySelectorAll('a[href*="finished-carriage-detail"]').forEach((a) => {
      const hrefMatch = a.getAttribute('href')?.match(S.carriageLinkHref);
      const row = a.closest('tr, [role="row"], [class*="row"]') || a.parentElement;
      const rowText = normalizeSpaces(row?.innerText || a.innerText);
      const numMatch = rowText.match(S.shortTransportRegex);
      const parsedClose = parseClosingDateTime(rowText);
      carriages.push({
        transport_number: numMatch?.[1] || null,
        carriage_long_id: hrefMatch?.[1] || null,
        closing_time: parsedClose?.closing_time || null,
        transport_date: parsedClose?.transport_date || null,
        closing_raw: parsedClose?.raw || null,
        is_today: parsedClose ? isTodayClosing(parsedClose) : false,
        accepted: null,
        shortage: null,
        excess: null,
        row_preview: rowText.slice(0, 200),
      });
    });
  }

  if (!carriages.length) {
    warnings.push('На странице завершённых перевозок строки не найдены');
  }

  const todayList = carriages.filter((c) => c.is_today);
  return {
    ok: true,
    accepted_today_card: acceptedToday,
    carriages,
    today_carriages: todayList,
    warnings,
  };
}


async function applyCarriageTodayFilter() {
  const today = todayLocalParts();
  const range = queryAllDeep('input').filter(isVisible).find((input) =>
    /\d{2}\.\d{2}\.\d{4}\s*[-–—]\s*\d{2}\.\d{2}\.\d{4}/.test(normalizeSpaces(input.value || ''))
  );
  if (!range) return { touched: 0, applied: false };
  setNativeValue(range, `${today.displayDate} - ${today.displayDate}`);
  const applied = clickButtonLabel(['Применить']);
  if (applied.clicked) await sleep(1200);
  return { touched: 1, applied: applied.clicked };
}


function readCarriageLongIdFromUrl(href = location.href) {
  const m = String(href || '').match(S.carriageLinkHref);
  return m ? m[1] : null;
}


async function openCarriageByNumber(transportNumber) {
  const num = String(transportNumber || '').trim();
  if (!num) {
    return { ok: false, error: 'Не передан номер перевозки' };
  }

  const already = readCarriageLongIdFromUrl();
  if (already) {
    return { ok: true, carriage_long_id: already, href: location.href, alreadyOpen: true };
  }

  await settle(500);
  const rows = Array.from(document.querySelectorAll('table tbody tr')).filter((row) => {
    const t = normalizeSpaces(row.innerText || row.textContent);
    return t.includes(num);
  });

  if (!rows.length) {
    return {
      ok: false,
      error: `Строка перевозки #${num} не найдена в таблице «Завершенные»`,
    };
  }

  const row = rows[0];
  const cells = Array.from(row.querySelectorAll('td, [role="cell"]'));
  let clickTarget =
    cells.find((c) => normalizeSpaces(c.innerText || c.textContent) === num) ||
    cells.find((c) => normalizeSpaces(c.innerText || c.textContent).includes(num)) ||
    row;

  // Не кликать в меню «⋯»
  const label = nodeLabel(clickTarget);
  if (/^…$|^\.\.\.$|^⋮$/.test(label) || clickTarget.querySelector?.('[class*="menu"], [class*="Menu"]')) {
    clickTarget = cells[2] || cells[0] || row;
  }

  robustClick(clickTarget);
  try {
    const longId = await waitFor(() => readCarriageLongIdFromUrl(), {
      timeoutMs: 12000,
      intervalMs: 300,
    });
    return { ok: true, carriage_long_id: longId, href: location.href, via: 'row-click' };
  } catch (_) {
    /* retry double-click on number cell */
  }

  robustClick(clickTarget);
  await sleep(200);
  robustClick(clickTarget);
  try {
    const longId = await waitFor(() => readCarriageLongIdFromUrl(), {
      timeoutMs: 10000,
      intervalMs: 300,
    });
    return { ok: true, carriage_long_id: longId, href: location.href, via: 'row-dblclick' };
  } catch (_) {
    /* try first non-menu cell */
  }

  if (cells[0] && cells[0] !== clickTarget) {
    robustClick(cells[0]);
    try {
      const longId = await waitFor(() => readCarriageLongIdFromUrl(), {
        timeoutMs: 8000,
        intervalMs: 300,
      });
      return { ok: true, carriage_long_id: longId, href: location.href, via: 'first-cell' };
    } catch (_) {
      /* fall through */
    }
  }

  return {
    ok: false,
    error: `Клик по перевозке #${num} не открыл карточку (/finished-carriage-detail/…). Сейчас: ${location.href}`,
    href: location.href,
  };
}

  Object.assign(api, { scrapeAcceptedToday, parseClosingDateTime, isTodayClosing, headerIndexMap, findCol, scrapeFinishedCarriages, applyCarriageTodayFilter, readCarriageLongIdFromUrl, openCarriageByNumber });
})();
