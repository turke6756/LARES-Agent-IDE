// Minimal self-owned transient toast for the selection package.
// The dashboard has no global notification mechanism today, and this package
// must not edit existing files to mount a provider — so this renders
// imperatively into document.body. If an app-wide toast system lands later,
// swap this module's internals; callers only know showSelectionToast().

const CONTAINER_ID = 'selection-toast-container';
const TOAST_MS = 3500;

function ensureContainer(): HTMLElement {
  let el = document.getElementById(CONTAINER_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = CONTAINER_ID;
    el.style.cssText = [
      'position:fixed',
      'bottom:16px',
      'left:50%',
      'transform:translateX(-50%)',
      'z-index:9999',
      'display:flex',
      'flex-direction:column',
      'gap:8px',
      'align-items:center',
      'pointer-events:none',
    ].join(';');
    document.body.appendChild(el);
  }
  return el;
}

export type SelectionToastKind = 'info' | 'error';

export function showSelectionToast(message: string, kind: SelectionToastKind = 'info'): void {
  const container = ensureContainer();
  const toast = document.createElement('div');
  toast.setAttribute('role', 'status');
  toast.dataset.kind = kind;
  toast.textContent = message;
  toast.style.cssText = [
    'max-width:420px',
    'padding:8px 14px',
    'border-radius:6px',
    'font-size:13px',
    'line-height:1.4',
    'color:#fff',
    `background:${kind === 'error' ? 'rgba(185,28,28,0.95)' : 'rgba(30,30,30,0.92)'}`,
    'box-shadow:0 4px 12px rgba(0,0,0,0.35)',
    'opacity:0',
    'transition:opacity 150ms ease',
    'pointer-events:auto',
  ].join(';');
  container.appendChild(toast);

  // Fade in on the next frame, fade out + remove after the hold.
  requestAnimationFrame(() => { toast.style.opacity = '1'; });
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => {
      toast.remove();
      if (container.childElementCount === 0) container.remove();
    }, 200);
  }, TOAST_MS);
}
