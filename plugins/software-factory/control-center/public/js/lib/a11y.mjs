// Accessibility helpers: focus trap, reduced-motion check, theme and motion preferences.
import { useEffect, useRef } from '../html.mjs';

const trapStack = []; // only the top-most trap handles keys (drawer + artifact viewer can stack)
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])';

/**
 * Trap focus inside the returned ref while `active`. Esc calls onClose.
 * Focus returns to the previously focused element on close.
 */
export function useFocusTrap(active, onClose) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!active) return undefined;
    const prev = document.activeElement;
    const root = ref.current;
    const items = () => [...(root ? root.querySelectorAll(FOCUSABLE) : [])].filter((el) => el.offsetParent !== null || el === document.activeElement);
    const first = root && (root.querySelector('[data-autofocus]') || items()[0] || root);
    if (first && first.focus) first.focus();
    const token = {};
    trapStack.push(token);
    const onKey = (e) => {
      if (trapStack[trapStack.length - 1] !== token) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (closeRef.current) closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !root) return;
      const list = items();
      if (!list.length) { e.preventDefault(); return; }
      const a = list[0];
      const z = list[list.length - 1];
      if (e.shiftKey && (document.activeElement === a || !root.contains(document.activeElement))) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      const i = trapStack.indexOf(token);
      if (i >= 0) trapStack.splice(i, 1);
      if (prev && prev.focus && document.contains(prev)) prev.focus();
    };
  }, [active]);
  return ref;
}

/** True when the OS asks for reduced motion or the manual toggle is on. Check before creating motion. */
export function reducedMotion() {
  if (document.documentElement.dataset.motion === 'reduce') return true;
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* blocked */ } }

export const THEMES = ['system', 'light', 'dark'];

export function loadTheme() {
  const t = lsGet('sf-theme');
  return THEMES.includes(t) ? t : 'system';
}

export function applyTheme(t) {
  const el = document.documentElement;
  if (t === 'light' || t === 'dark') el.dataset.theme = t; else delete el.dataset.theme;
  lsSet('sf-theme', t === 'system' ? null : t);
}

export function loadMotion() {
  return lsGet('sf-motion') === 'reduce';
}

export function applyMotion(reduce) {
  const el = document.documentElement;
  if (reduce) el.dataset.motion = 'reduce'; else delete el.dataset.motion;
  lsSet('sf-motion', reduce ? 'reduce' : null);
}

/** Keyboard activation for non-button elements (role=button). */
export function onActivate(fn) {
  return (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fn(e);
    }
  };
}
