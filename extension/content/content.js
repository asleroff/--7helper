(() => {
  const S = window.TurboPvzSelectors;
  if (!S) {
    console.error('[turbo-close] selectors.js not loaded');
    return;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function normalizeSpaces(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  function parseIntLoose(raw) {
    if (raw == null || raw === '') return null;
    const digits = String(raw).replace(/\s/g, '').replace(/[^\d-]/g, '');
    if (!digits || digits === '-') return null;
    const n = Number.parseInt(digits, 10);
    return Number.isFinite(n) ? n : null;
  }

  function todayLocalParts() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return {
      y,
      m,
      day,
      isoDate: `${y}-${m}-${day}`,
      displayDate: `${day}.${m}.${y}`,
      startIso: `${y}-${m}-${day}T00:00:00`,
      endIso: `${y}-${m}-${day}T23:59:59`,
    };
  }

  function waitFor(predicate, { timeoutMs = 20000, intervalMs = 400 } = {}) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        try {
          const value = predicate();
          if (value) {
            resolve(value);
            return;
          }
        } catch (_) {
          /* keep polling */
        }
        if (Date.now() - start >= timeoutMs) {
          reject(new Error('Таймаут ожидания страницы'));
          return;
        }
        setTimeout(tick, intervalMs);
      };
      tick();
    });
  }

  function matchPoint(text, source) {
    const t = normalizeSpaces(text);
    if (!t) return null;
    const m = t.match(S.pointNumberRegex);
    if (!m) return null;
    return { point_number: m[1], raw: m[0], source };
  }

  /** Собирает текст из DOM + open shadow roots + aria/title. */
  function collectDeepText(root, out = []) {
    if (!root) return out;
    if (root.nodeType === Node.TEXT_NODE) {
      const v = root.textContent;
      if (v && v.trim()) out.push(v);
      return out;
    }
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
      return out;
    }
    const el = root;
    if (el.getAttribute) {
      for (const attr of ['aria-label', 'title', 'placeholder', 'alt', 'data-testid', 'value']) {
        const v = el.getAttribute(attr);
        if (v) out.push(v);
      }
    }
    if (el.shadowRoot) collectDeepText(el.shadowRoot, out);
    const children = el.childNodes || [];
    for (const child of children) collectDeepText(child, out);
    return out;
  }

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

  /** «Всего: N» на карточке перевозки — только если фильтр Статус=Засыл реально применён. */
  function scrapeTotalCount() {
    const text = document.body?.innerText || '';
    const m = text.match(/Всего\s*:?\s*([\d\s\u00a0\u202f]+)/i);
    if (!m) return { ok: false };
    const value = parseIntLoose(m[1]);
    if (value == null) return { ok: false };
    return { ok: true, value, matched: m[0] };
  }

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

  function queryAllDeep(selector, root = document) {
    const out = [];
    const visit = (node) => {
      if (!node) return;
      if (node.querySelectorAll) {
        try {
          out.push(...node.querySelectorAll(selector));
        } catch (_) {
          /* ignore */
        }
      }
      const all = node.querySelectorAll ? node.querySelectorAll('*') : [];
      for (const el of all) {
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(root);
    return out;
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  }

  function visibleClickableNodes() {
    const sel =
      'button, [role="button"], a, input[type="button"], input[type="submit"], [class*="Button"], [class*="button"]';
    return queryAllDeep(sel).filter(isVisible);
  }

  function nodeLabel(el) {
    return normalizeSpaces(
      el.innerText || el.textContent || el.getAttribute('aria-label') || el.value || ''
    );
  }

  /** React часто слушает pointer/mouse, а не голый .click() */
  function robustClick(el) {
    if (!el) return false;
    try {
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
    } catch (_) {
      /* ignore */
    }
    const opts = { bubbles: true, cancelable: true, view: window };
    try {
      el.focus?.();
    } catch (_) {
      /* ignore */
    }
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      try {
        el.dispatchEvent(new MouseEvent(type, opts));
      } catch (_) {
        /* ignore */
      }
    }
    try {
      el.click();
    } catch (_) {
      /* ignore */
    }
    return true;
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

  function labelMatchesWant(label, want) {
    const t = normalizeSpaces(label).toLowerCase();
    const w = normalizeSpaces(want).toLowerCase();
    return t === w || t.startsWith(w) || t.includes(w);
  }

  /** Нажимает «Найти» / «Применить» в основной области (не в боковом меню). */
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

  function clickTabByText(labels) {
    const wantList = labels.map((l) => l.toLowerCase());
    const nodes = queryAllDeep(
      'a, button, [role="tab"], [role="button"], [class*="Tab"], [class*="tab"]'
    ).filter(isVisible);
    for (const el of nodes) {
      const t = nodeLabel(el).toLowerCase();
      if (!t || t.length > 60) continue;
      if (wantList.some((w) => t === w || t.includes(w))) {
        robustClick(el);
        return { clicked: true, label: nodeLabel(el) };
      }
    }
    return { clicked: false };
  }

  async function prepareReportPage({
    settleMs = 800,
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

    const before = scrapeFoundCount();
    let click = clickFindButton();
    if (!click.clicked) {
      await sleep(600);
      click = clickFindButton();
    }
    if (click.clicked) {
      await sleep(1500);
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

  /** Текстовые узлы «Засыл» вне таблицы (пункт дропдауна, не бейдж в строке). */
  function findZasylDropdownLabels() {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const raw = node.textContent || '';
      if (normalizeSpaces(raw) !== 'Засыл') continue;
      const el = node.parentElement;
      if (!el) continue;
      if (el.closest('table, tbody, thead, [role="table"]')) continue;
      out.push(el);
    }
    return out;
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

  /** Ждёт появления пунктов статуса и ставит галочку «Засыл». */
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
      }, { timeoutMs: 6000, intervalMs: 200 });
    } catch (_) {
      /* try anyway */
    }

    await sleep(300);

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

  /** В карточке перевозки: фильтр Статус → Засыл → Найти (без Escape — он сбрасывает выбор!). */
  async function scrapeZasyl() {
    await settle(800);
    const statusLabel = S.zasylStatusText;
    const warnings = [];
    const totalBefore = scrapeTotalCount();

    if (!/finished-carriage-detail/i.test(location.href)) {
      warnings.push(`Ожидалась карточка перевозки, сейчас: ${location.href}`);
    }

    // Открыть фильтр «Статус»
    const filterTriggers = queryAllDeep(
      'button, [role="button"], [role="combobox"], [aria-haspopup], input, [class*="Select"], [class*="select"], [class*="Filter"], [class*="filter"]'
    ).filter(isVisible);

    let openedStatus = false;
    let statusControl = null;
    for (const el of filterTriggers) {
      const t = nodeLabel(el);
      const aria = normalizeSpaces(el.getAttribute('aria-label') || '');
      const ph = normalizeSpaces(el.getAttribute('placeholder') || '');
      const blob = `${t} ${aria} ${ph}`.toLowerCase();
      // Не путать с другими фильтрами; «Статус» как плейсхолдер/подпись
      if (blob.includes('статус') && !blob.includes('наименование')) {
        statusControl = el;
        robustClick(el);
        openedStatus = true;
        await sleep(700);
        break;
      }
    }

    if (!openedStatus) {
      const labels = queryAllDeep('label, span, div, p').filter(isVisible);
      for (const lab of labels) {
        const t = nodeLabel(lab);
        if (t.toLowerCase() !== 'статус') continue;
        const parent = lab.parentElement;
        const ctrl =
          parent?.querySelector(
            'button, [role="combobox"], [role="button"], input, [class*="Select"]'
          ) || lab.nextElementSibling;
        if (ctrl) {
          statusControl = ctrl;
          robustClick(ctrl);
          openedStatus = true;
          await sleep(700);
          break;
        }
      }
    }

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

    // На карточке перевозки после галочки сразу «Найдено: N» — отдельная «Найти» не нужна.
    // Не кликаем «Всего»/Escape (сброс). Ждём «Найдено» / «Выбрано: 1».
    try {
      await waitFor(() => {
        if (scrapeFoundCount().ok) return true;
        if (zasylFilterLooksSelected()) return true;
        if (filterAppliedZasyl()) return true;
        return null;
      }, { timeoutMs: 8000, intervalMs: 350 });
    } catch (_) {
      /* ниже */
    }
    await sleep(300);

    if (!openedStatus) {
      warnings.push('Не удалось открыть фильтр статуса — считаю строки таблицы');
    } else if (!selected) {
      warnings.push(
        `Список «Статус» открыт, но галочка «Засыл» не поставилась (${pickInfo?.reason || 'unknown'})`
      );
    }

    const applied = filterAppliedZasyl() || scrapeFoundCount().ok;
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

    const count = countZasylRows();
    if (!count) {
      warnings.push(
        applied
          ? 'После фильтра «Засыл» строк не видно (возможно, засылов 0)'
          : 'Фильтр «Засыл» не подтверждён — нет «Найдено» и строк со статусом «Засыл»'
      );
    }

    return {
      ok: true,
      value: count,
      method: 'status-rows',
      warnings,
      filterApplied: applied,
      selected,
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

  function buildRemainsUrl() {
    // Отчёты → Остатки → Тип = «Отправления» → Найти
    // https://turbo-pvz.ozon.ru/reports/remains?filter={"filter":["GRPC_REMNANT_FILTER_ARTICLE_POSTING"]}
    const filter = { filter: ['GRPC_REMNANT_FILTER_ARTICLE_POSTING'] };
    const encoded = encodeURIComponent(JSON.stringify(filter));
    return `https://turbo-pvz.ozon.ru/reports/remains?filter=${encoded}`;
  }

  function buildTareUrl() {
    // Отчёты → Остатки → Тип = «Тарный ящик» → Найти
    // filter={"filter":["GRPC_REMNANT_FILTER_ARTICLE_BOX_TARE"]}
    const filter = { filter: ['GRPC_REMNANT_FILTER_ARTICLE_BOX_TARE'] };
    const encoded = encodeURIComponent(JSON.stringify(filter));
    return `https://turbo-pvz.ozon.ru/reports/remains?filter=${encoded}`;
  }

  function buildCarriagesUrl() {
    return 'https://turbo-pvz.ozon.ru/carriages_list/finished';
  }

  function buildCarriageDetailUrl(longId) {
    return `https://turbo-pvz.ozon.ru/carriages_list/finished-carriage-detail/${longId}`;
  }

  function readCarriageLongIdFromUrl(href = location.href) {
    const m = String(href || '').match(S.carriageLinkHref);
    return m ? m[1] : null;
  }

  /**
   * В таблице «Завершенные» часто нет <a href=…detail…> — только клик по строке.
   * Кликаем строку с нужным коротким номером и ждём URL карточки.
   */
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

  async function settle(ms = 800) {
    await sleep(ms);
    // Soft wait for «Найдено» or table if present soon
    try {
      await waitFor(
        () => {
          const text = document.body?.innerText || '';
          if (/Найдено\s*:/i.test(text)) return true;
          if (document.querySelector('table tbody tr')) return true;
          if (/Сегодня\s+принято/i.test(text)) return true;
          return null;
        },
        { timeoutMs: 5000, intervalMs: 300 }
      );
    } catch (_) {
      /* page may still be usable */
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const handle = async () => {
      switch (message?.type) {
        case 'PING':
          return { ok: true, href: location.href };
        case 'GET_POINT':
          await settle(300);
          {
            const point = getPointNumber();
            if (!point) {
              return { ok: false, error: 'ПП не найден в шапке (ожидался текст вида ПП_1125)' };
            }
            return { ok: true, ...point };
          }
        case 'SCRAPE_FOUND': {
          // Отчёты (выдача / остатки): нужна кнопка «Найти», иначе «Найдено» пустое/старое
          const isRemains = Boolean(message.remains);
          const hrefDecoded = decodeURIComponent(location.href || '');
          const hasPostingFilter = hrefDecoded.includes('GRPC_REMNANT_FILTER_ARTICLE_POSTING');
          if (isRemains && !hasPostingFilter) {
            return {
              ok: false,
              error:
                'Остатки: нет фильтра типа «Отправления» в URL (ожидался GRPC_REMNANT_FILTER_ARTICLE_POSTING)',
              diagnostics: pageDiagnostics(),
            };
          }
          // Если filter уже в URL — НЕ кликать «Отчёты/Остатки»: это сбрасывает query
          const prep = await prepareReportPage({
            settleMs: message.settleMs || 800,
            ensureTab: hasPostingFilter ? null : message.ensureTab || null,
            openReportsMenu: hasPostingFilter
              ? false
              : isRemains || Boolean(message.openReportsMenu),
            requireNonZero: isRemains,
          });
          if (!prep.ok) {
            return {
              ok: false,
              error: prep.error,
              findClicked: prep.findClicked,
              diagnostics: prep.diagnostics,
            };
          }
          if (isRemains && prep.value === 0) {
            return {
              ok: true,
              value: 0,
              findClicked: prep.findClicked,
              warnings: [
                prep.findClicked
                  ? 'Остатки (тип «Отправления»): после «Найти» всё ещё 0 — на пункте реально пусто или фильтр не применился'
                  : 'Остатки: «Найдено: 0»',
              ],
              diagnostics: prep.diagnostics,
            };
          }
          return {
            ok: true,
            value: prep.value,
            findClicked: prep.findClicked,
            diagnostics: prep.diagnostics,
          };
        }
        case 'SCRAPE_TARE': {
          const hrefDecoded = decodeURIComponent(location.href || '');
          const hasTareFilter = hrefDecoded.includes('GRPC_REMNANT_FILTER_ARTICLE_BOX_TARE');
          if (!hasTareFilter) {
            return {
              ok: false,
              error:
                'Тара: нет фильтра «Тарный ящик» в URL (ожидался GRPC_REMNANT_FILTER_ARTICLE_BOX_TARE). Не кликайте вкладки — они сбрасывают filter.',
              diagnostics: pageDiagnostics(),
            };
          }
          // filter уже в URL — только «Найти», без кликов по меню/вкладкам
          const prep = await prepareReportPage({
            settleMs: message.settleMs || 800,
            ensureTab: null,
            openReportsMenu: false,
          });
          if (!prep.ok) {
            return {
              ok: false,
              error: prep.error || 'Тара: не собрано после «Найти»',
              findClicked: prep.findClicked,
              diagnostics: prep.diagnostics,
            };
          }
          const tare = scrapeTareRemains();
          if (tare?.ok) {
            tare.findClicked = prep.findClicked;
            tare.diagnostics = prep.diagnostics;
            if (!prep.findClicked) {
              tare.warnings = tare.warnings || [];
              tare.warnings.push('Кнопка «Найти» на странице тары не найдена — проверьте фильтр');
            }
          }
          return tare;
        }
        case 'PAGE_DIAG':
          await settle(200);
          return { ok: true, ...pageDiagnostics() };
        case 'SCRAPE_CARRIAGES':
          await settle(message.settleMs || 500);
          return scrapeFinishedCarriages();
        case 'SCRAPE_ZASYL':
          return scrapeZasyl();
        case 'OPEN_CARRIAGE':
          return openCarriageByNumber(message.transportNumber);
        case 'GET_URLS':
          return {
            ok: true,
            urls: {
              giveout: buildGiveoutUrl(),
              remains: buildRemainsUrl(),
              tare: buildTareUrl(),
              carriages: buildCarriagesUrl(),
              carriageDetail: message.longId ? buildCarriageDetailUrl(message.longId) : null,
            },
            today: todayLocalParts(),
          };
        default:
          return { ok: false, error: `Unknown message: ${message?.type}` };
      }
    };

    handle()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  });
})();
