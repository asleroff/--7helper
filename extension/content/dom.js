/** Общие ожидания, клики и разбор текста на странице. */
(() => {
  const api = (window.TurboClose = window.TurboClose || {});
  const S = window.TurboPvzSelectors;
  if (!S) {
    console.error('[turbo-close] selectors.js не загружен');
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


function setNativeValue(el, value) {
  const proto = Object.getPrototypeOf(el);
  const desc =
    Object.getOwnPropertyDescriptor(proto, 'value') ||
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  if (desc?.set) desc.set.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
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


function labelMatchesWant(label, want) {
  const t = normalizeSpaces(label).toLowerCase();
  const w = normalizeSpaces(want).toLowerCase();
  return t === w || t.startsWith(w) || t.includes(w);
}


function clickButtonLabel(texts) {
  const nodes = visibleClickableNodes()
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { el, t: nodeLabel(el), top: r.top, left: r.left };
    })
    .filter((x) => x.left > 180)
    .sort((a, b) => a.top - b.top || a.left - b.left);
  for (const want of texts) {
    const hit = nodes.find((n) => labelMatchesWant(n.t, want));
    if (hit) {
      robustClick(hit.el);
      return { clicked: true, label: hit.t };
    }
  }
  return { clicked: false };
}


function isControlDisabled(el) {
  if (!el) return true;
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') return true;
  return /\bdisabled\b/i.test(String(el.className || ''));
}


function findNextPageControl() {
  const nextRe = /следующ|далее|\bnext\b|вперёд|вперед/i;
  const iconRe = /^(›|»|>|→|▶)$/;
  for (const el of visibleClickableNodes()) {
    const label = `${nodeLabel(el)} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`;
    if (!nextRe.test(label) && !iconRe.test(nodeLabel(el))) continue;
    if (isControlDisabled(el)) return null;
    return el;
  }
  return null;
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


async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (predicate()) return true;
    } catch (_) {
      /* страница ещё строится */
    }
    await sleep(120);
  }
  return false;
}

  Object.assign(api, { sleep, normalizeSpaces, parseIntLoose, todayLocalParts, waitFor, matchPoint, collectDeepText, setNativeValue, queryAllDeep, isVisible, visibleClickableNodes, nodeLabel, robustClick, labelMatchesWant, clickButtonLabel, isControlDisabled, findNextPageControl, clickTabByText, waitUntil });
})();
