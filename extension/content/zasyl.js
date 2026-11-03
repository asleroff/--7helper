/** Фильтр статуса «Засыл» на карточке перевозки. */
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
  const scrapeAcceptedToday = (...args) => api.scrapeAcceptedToday(...args);
  const parseClosingDateTime = (...args) => api.parseClosingDateTime(...args);
  const isTodayClosing = (...args) => api.isTodayClosing(...args);
  const headerIndexMap = (...args) => api.headerIndexMap(...args);
  const findCol = (...args) => api.findCol(...args);
  const scrapeFinishedCarriages = (...args) => api.scrapeFinishedCarriages(...args);
  const applyCarriageTodayFilter = (...args) => api.applyCarriageTodayFilter(...args);
  const readCarriageLongIdFromUrl = (...args) => api.readCarriageLongIdFromUrl(...args);
  const openCarriageByNumber = (...args) => api.openCarriageByNumber(...args);

function statusFilterLooksLikeZasyl() {
  const label = S.zasylStatusText;
  const controls = queryAllDeep(
    'button, [role="combobox"], [role="button"], input, [class*="Select"], [class*="Chip"], [class*="Tag"], [class*="filter"]'
  ).filter(isVisible);
  for (const el of controls) {
    const t = nodeLabel(el);
    const aria = normalizeSpaces(el.getAttribute('aria-label') || '');
    const blob = `${t} ${aria}`;
    if (/статус/i.test(blob) && blob.includes(label)) return true;
    if (t === label || t.includes(label)) {
      // чип/тег выбранного фильтра
      if (t.length <= 40) return true;
    }
  }
  return false;
}


function countZasylRows() {
  const statusLabel = S.zasylStatusText;
  let count = 0;
  const rows = document.querySelectorAll('table tbody tr');
  const list = rows.length
    ? Array.from(rows)
    : Array.from(document.querySelectorAll('[role="row"]'));

  list.forEach((row) => {
    const t = normalizeSpaces(row.innerText || row.textContent);
    if (!t || t.length < 2) return;
    if (/^статус$/i.test(t)) return;
    // Статус в отдельной ячейке предпочтительнее
    const cells = Array.from(row.querySelectorAll('td, [role="cell"]'));
    if (cells.length >= 2) {
      const statusCell = cells.find((c) => {
        const ct = normalizeSpaces(c.innerText || c.textContent);
        return ct === statusLabel;
      });
      if (statusCell) {
        count += 1;
        return;
      }
      // не считаем строку, где «Засыл» только как часть длинного текста без статуса
      return;
    }
    if (new RegExp(`(^|[\\s|])${statusLabel}([\\s|]|$)`).test(t)) count += 1;
  });
  return count;
}


function clickTextOption(label) {
  const want = normalizeSpaces(label).toLowerCase();
  // Без жёсткого isVisible: пункты дропдауна часто в portal/overflow
  const nodes = queryAllDeep(
    'label, [role="option"], [role="menuitem"], [role="listitem"], li, span, div, button, [class*="option"], [class*="Option"], [class*="Checkbox"], [class*="checkbox"]'
  );

  for (const el of nodes) {
    const t = normalizeSpaces(el.innerText || el.textContent);
    if (!t || t.length > 48) continue;
    // Точное совпадение важнее (не цеплять длинные строки таблицы)
    if (t.toLowerCase() !== want) continue;

    const forId = el.getAttribute?.('for');
    const input =
      (el.matches?.('input') && el) ||
      el.querySelector?.('input[type="checkbox"], input') ||
      el.closest?.('label')?.querySelector('input') ||
      (forId ? document.getElementById(forId) : null) ||
      el.previousElementSibling?.querySelector?.('input') ||
      el.parentElement?.querySelector?.('input[type="checkbox"]');

    if (input) {
      if (input.type === 'checkbox') {
        if (!input.checked) {
          robustClick(input);
          if (!input.checked) {
            input.checked = true;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      } else {
        robustClick(input);
      }
      return true;
    }

    // Клик по строке пункта (чекбокс слева от текста)
    const row = el.closest('li, [role="option"], [class*="MenuItem"], [class*="menu-item"], label, div');
    robustClick(row || el);
    return true;
  }
  return false;
}


function findExactLabels(word) {
  const out = [];
  const visit = (root) => {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (normalizeSpaces(node.textContent) !== word) continue;
      const el = node.parentElement;
      if (!el) continue;
      if (el.closest('table, tbody, thead, [role="table"], [role="columnheader"]')) continue;
      out.push(el);
    }
    const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const el of all) {
      if (el.shadowRoot) visit(el.shadowRoot);
    }
  };
  visit(document.body);
  return out;
}


function findZasylDropdownLabels() {
  return findExactLabels('Засыл');
}


function clickZasylMenuRow(labelEl) {
  // Строка пункта: [иконка/чекбокс] + «Засыл»
  const row =
    labelEl.closest(
      'label, li, [role="option"], [role="menuitem"], [role="menuitemcheckbox"], [class*="Menu"], [class*="menu"], [class*="Option"], [class*="option"], [class*="Item"], [class*="item"]'
    ) || labelEl.parentElement;

  const candidates = [];
  if (row) {
    candidates.push(
      ...row.querySelectorAll(
        'input[type="checkbox"], [role="checkbox"], [class*="Checkbox"], [class*="checkbox"], [class*="Check"]'
      )
    );
    candidates.push(row);
  }
  candidates.push(labelEl);
  if (labelEl.previousElementSibling) candidates.push(labelEl.previousElementSibling);
  if (labelEl.parentElement) candidates.push(labelEl.parentElement);

  for (const el of candidates) {
    if (!el) continue;
    robustClick(el);
  }

  // Для кастомных чекбоксов — pointer-события по центру строки
  if (row) {
    const r = row.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      const x = r.left + Math.min(24, r.width / 2);
      const y = r.top + r.height / 2;
      const topEl = document.elementFromPoint(x, y);
      if (topEl) robustClick(topEl);
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        row.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: x,
            clientY: y,
          })
        );
      }
    }
  }
}


function zasylFilterLooksSelected() {
  const text = document.body?.innerText || '';
  if (/Выбрано\s*:\s*[1-9]/i.test(text)) return true;
  // Поле статуса показывает «Засыл» / «Выбрано: 1»
  const controls = queryAllDeep(
    'button, [role="combobox"], [role="button"], input, [class*="Select"]'
  );
  for (const el of controls) {
    const t = nodeLabel(el);
    if (/выбрано\s*:\s*[1-9]/i.test(t)) return true;
    if (/^засыл$/i.test(t) || (/статус/i.test(t) && /засыл/i.test(t))) return true;
  }
  return scrapeFoundCount().ok;
}


async function selectZasylCheckbox() {
  try {
    await waitFor(() => {
      const labels = findZasylDropdownLabels();
      if (labels.length) return true;
      const text = document.body?.innerText || '';
      if (
        text.includes('Засыл') &&
        text.includes('Излишек') &&
        text.includes('Недостача')
      ) {
        return true;
      }
      return null;
    }, { timeoutMs: 1500, intervalMs: 100 });
  } catch (_) {
    /* try anyway */
  }

  await sleep(80);

  const labels = findZasylDropdownLabels();
  if (!labels.length) {
    // fallback: старый путь
    if (clickTextOption('Засыл')) return { ok: true, via: 'text-option-fallback' };
    return { ok: false, reason: 'no-dropdown-label' };
  }

  // Берём последний/видимый пункт в дропдауне (не из скрытых копий)
  const sorted = labels
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter((x) => x.r.width > 0 || x.r.height > 0 || true)
    .sort((a, b) => b.r.top - a.r.top);

  for (const { el } of sorted) {
    clickZasylMenuRow(el);
    await sleep(400);
    if (zasylFilterLooksSelected() || scrapeFoundCount().ok) {
      return { ok: true, via: 'dropdown-label' };
    }
  }

  // Ещё одна попытка по первому label
  clickZasylMenuRow(labels[0]);
  await sleep(500);
  if (zasylFilterLooksSelected() || scrapeFoundCount().ok) {
    return { ok: true, via: 'dropdown-label-retry' };
  }

  return { ok: false, reason: 'click-no-effect', tried: labels.length };
}


function tableStatusSample(limit = 20) {
  const rows = Array.from(document.querySelectorAll('table tbody tr')).slice(0, limit);
  return rows.map((r) => normalizeSpaces(r.innerText || r.textContent)).join(' || ');
}


function filterAppliedZasyl() {
  // После выбора на ваших скринах: «Выбрано: 1» + «Найдено: N» + строки «Засыл»
  if (zasylFilterLooksSelected()) return true;
  if (scrapeFoundCount().ok) return true;
  if (statusFilterLooksLikeZasyl()) return true;
  const sample = tableStatusSample(25);
  if (!sample) return false;
  const zasylHits = (sample.match(/Засыл/g) || []).length;
  const acceptedHits = (sample.match(/Принято/g) || []).length;
  return zasylHits > 0 && acceptedHits === 0;
}


function statusClickHost(el) {
  let node = el;
  for (let depth = 0; depth < 5 && node; depth += 1) {
    const role = node.getAttribute?.('role') || '';
    if (
      node.tagName === 'LABEL' ||
      node.tagName === 'BUTTON' ||
      role === 'combobox' ||
      role === 'button' ||
      node.hasAttribute?.('aria-haspopup')
    ) {
      return node;
    }
    if (node.querySelector?.('input, button')) return node;
    node = node.parentElement;
  }
  return el;
}


function findStatusClickTarget() {
  const controls = queryAllDeep(
    'input, button, [role="combobox"], [role="button"], [aria-haspopup]'
  ).filter(isVisible);
  for (const el of controls) {
    if (el.closest('table, thead, tbody, [role="table"], [role="columnheader"]')) continue;
    const own = normalizeSpaces(
      `${nodeLabel(el)} ${el.getAttribute('placeholder') || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`
    ).toLowerCase();
    const around = normalizeSpaces(el.parentElement?.innerText || '').toLowerCase();
    const blob = around.length > 0 && around.length <= 40 ? `${own} ${around}` : own;
    if (!blob || blob.includes('наименование')) continue;
    if (blob === 'статус' || /(^|[\s:])статус($|[\s:])/.test(blob)) {
      return statusClickHost(el);
    }
  }

  for (const el of findExactLabels('Статус')) {
    if (!isVisible(el)) continue;
    return statusClickHost(el);
  }
  return null;
}


function statusMenuOpen() {
  if (findZasylDropdownLabels().some((el) => isVisible(el))) return true;
  const text = document.body?.innerText || '';
  return text.includes('Засыл') && text.includes('Излишек') && text.includes('Недостача');
}


async function waitForStatusControl(timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const el = findStatusClickTarget();
    if (el) return el;
    await sleep(200);
  }
  return null;
}


function clickStatusControl(el) {
  const host = statusClickHost(el);
  robustClick(host);
  const rect = host.getBoundingClientRect();
  if (rect.width > 2 && rect.height > 2) {
    const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (top && top !== host) robustClick(top);
  }
  const input = host.matches?.('input, button') ? host : host.querySelector?.('input, button');
  if (input && input !== host) robustClick(input);
}


async function openStatusFilter() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const control = await waitForStatusControl(attempt === 0 ? 4500 : 1200);
    if (!control) continue;
    clickStatusControl(control);
    await sleep(350);
    if (statusMenuOpen()) return true;
  }
  return false;
}


function zasylResultConfirmed() {
  if (scrapeFoundCount().ok) return true;
  const sample = tableStatusSample(25);
  if (!sample) return false;
  const zasylHits = (sample.match(/Засыл/g) || []).length;
  const acceptedHits = (sample.match(/Принято/g) || []).length;
  return zasylHits > 0 && acceptedHits === 0;
}


async function scrapeZasyl() {
  const statusLabel = S.zasylStatusText;
  const warnings = [];
  const totalBefore = scrapeTotalCount();

  if (!/finished-carriage-detail/i.test(location.href)) {
    warnings.push(`Ожидалась карточка перевозки, сейчас: ${location.href}`);
  }

  const openedStatus = await openStatusFilter();

  let selected = false;
  let pickInfo = null;
  if (openedStatus) {
    pickInfo = await selectZasylCheckbox();
    selected = pickInfo.ok;
    if (!selected) {
      await sleep(600);
      pickInfo = await selectZasylCheckbox();
      selected = pickInfo.ok;
    }
  }

  // После галочки «Засыл» ждём «Найдено». Если статус даже не открылся — не стоим на странице.
  if (openedStatus) {
    try {
      await waitFor(() => {
        if (scrapeFoundCount().ok) return true;
        if (zasylFilterLooksSelected()) return true;
        if (filterAppliedZasyl()) return true;
        return null;
      }, { timeoutMs: 4000, intervalMs: 200 });
    } catch (_) {
      /* ниже */
    }
  }

  if (openedStatus && !selected) {
    warnings.push(
      `Список «Статус» открыт, но галочка «Засыл» не поставилась (${pickInfo?.reason || 'unknown'})`
    );
  }

  const applied = zasylResultConfirmed();
  const found = scrapeFoundCount();

  // Главный путь по вашим скринам: после «Засыл» появляется «Найдено: 2»
  if (found.ok) {
    return {
      ok: true,
      value: found.value,
      method: 'status-filter+naydeno',
      matched: found.matched || null,
      warnings,
      selected,
    };
  }

  const total = scrapeTotalCount();
  if (applied && total.ok && !/Принято/i.test(tableStatusSample(10))) {
    return {
      ok: true,
      value: total.value,
      method: 'status-filter+vsego-verified',
      matched: total.matched,
      warnings,
    };
  }

  if (total.ok && /Принято/i.test(tableStatusSample(15))) {
    warnings.push(
      `«Всего: ${total.value}» — это все места, не засылы. Нужна галочка Статус→Засыл, тогда будет «Найдено: N».`
    );
  }

  if (!applied) {
    warnings.push(
      openedStatus
        ? 'Фильтр «Засыл» не подтвердился — нет «Найдено» и строк со статусом «Засыл»'
        : 'Не удалось открыть фильтр статуса'
    );
    return {
      ok: false,
      value: null,
      method: 'status-not-applied',
      warnings,
      error: warnings[warnings.length - 1],
      selected,
    };
  }

  const count = countZasylRows();
  return {
    ok: true,
    value: count,
    method: 'status-rows',
    warnings,
    filterApplied: true,
    selected,
  };
}

  Object.assign(api, { statusFilterLooksLikeZasyl, countZasylRows, clickTextOption, findExactLabels, findZasylDropdownLabels, clickZasylMenuRow, zasylFilterLooksSelected, selectZasylCheckbox, tableStatusSample, filterAppliedZasyl, statusClickHost, findStatusClickTarget, statusMenuOpen, waitForStatusControl, clickStatusControl, openStatusFilter, zasylResultConfirmed, scrapeZasyl });
})();
