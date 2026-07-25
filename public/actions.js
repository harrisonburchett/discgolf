// ============================================================
// actions.js — Event delegation, loaded before everything else.
//
// Why this exists rather than inline onclick handlers:
//
// An inline handler's attribute value is HTML-entity-decoded by the parser and
// THEN compiled as JavaScript. So HTML-escaping a value interpolated into one
// does not contain it — escaping ' to &#39; just means the parser hands a real
// quote to the JS compiler:
//
//   server sends:  onclick="pick('a&#39;-alert(1)-&#39;b')"
//   JS receives:   pick('a'-alert(1)-'b')      <-- executes
//
// A data-* attribute has no such second parse. It is only ever read back as an
// opaque string through element.dataset, so HTML-escaping is sufficient and
// there is no context where the value becomes code.
//
// Handlers register themselves into ACTIONS; markup declares data-action plus
// whatever data-* values the handler needs.
// ============================================================

const ACTIONS = {};

/** Read the numeric value of a data attribute, or null. */
function dataInt(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Dispatch one delegated event to the matching registered action.
 * `closest` means a click on a child element (an icon, a span) still resolves
 * to the element that declared the action.
 */
function dispatchAction(event, kind) {
  const el = event.target.closest(`[data-action]`);
  if (!el) return;

  // Let an element opt into a non-click event, e.g. data-on="input".
  const wants = el.dataset.on || 'click';
  if (wants !== kind) return;

  const handler = ACTIONS[el.dataset.action];
  if (!handler) {
    console.warn(`No handler registered for data-action="${el.dataset.action}"`);
    return;
  }

  if (kind === 'click' && el.tagName === 'A') event.preventDefault();
  handler(el.dataset, el, event);
}

function initActions() {
  document.addEventListener('click', (e) => dispatchAction(e, 'click'));
  document.addEventListener('input', (e) => dispatchAction(e, 'input'));
  document.addEventListener('change', (e) => dispatchAction(e, 'change'));

  // Anything given a role of button by markup should also respond to the keys a
  // real button responds to.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = e.target.closest('[data-action]');
    if (!el || el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'INPUT') return;
    if (el.getAttribute('role') !== 'button' && el.tabIndex < 0) return;
    e.preventDefault();
    dispatchAction(e, 'click');
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initActions, { once: true });
} else {
  initActions();
}
