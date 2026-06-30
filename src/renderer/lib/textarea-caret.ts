// Caret-coordinate measurement for a <textarea>, via the standard "mirror div"
// technique: clone the textarea's box + text into a hidden div, drop a marker
// span at the caret, and read the span's offset. A <textarea> exposes no API
// for the pixel position of a character, so a layout-faithful mirror is the
// portable way to anchor an in-textarea dropdown (Slice D of the @-mention plan).
//
// NOTE: this needs real layout. Under jsdom every offset is 0 (no layout
// engine), so geometry can only be validated manually in the running app. Unit
// tests cover the NaN/fallback contract and pure arithmetic only.

// Style properties copied from the textarea onto the mirror so the mirror wraps
// text exactly as the textarea does. Anything affecting glyph metrics or line
// breaking must be here.
const COPIED_STYLES = [
  'boxSizing',
  'width',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'fontStretch',
  'fontSize',
  'fontSizeAdjust',
  'lineHeight',
  'fontFamily',
  'textAlign',
  'textTransform',
  'textIndent',
  'textDecoration',
  'letterSpacing',
  'wordSpacing',
  'tabSize',
] as const;

export function getCaretCoordinates(
  textarea: HTMLTextAreaElement,
  position: number,
): { top: number; left: number; height: number } {
  const doc = textarea.ownerDocument;
  const win = doc.defaultView ?? window;

  const div = doc.createElement('div');
  try {
    const style = div.style;
    const computed = win.getComputedStyle(textarea);

    // A textarea always wraps and never overflows its content box horizontally.
    style.whiteSpace = 'pre-wrap';
    style.wordWrap = 'break-word';
    // Render off-screen so the mirror is never visible.
    style.position = 'absolute';
    style.visibility = 'hidden';
    style.top = '0';
    style.left = '0';

    for (const prop of COPIED_STYLES) {
      // computed values are concrete px strings — copy them verbatim.
      style[prop] = computed[prop];
    }

    // Text up to the caret, then a zero-size marker at the caret itself.
    div.textContent = textarea.value.slice(0, position);
    const span = doc.createElement('span');
    // Non-empty content gives the span a measurable box even at a line start.
    span.textContent = textarea.value.slice(position) || '.';
    div.appendChild(span);

    doc.body.appendChild(div);

    const top = span.offsetTop - textarea.scrollTop;
    const left = span.offsetLeft - textarea.scrollLeft;
    const height = parseInt(computed.lineHeight, 10) || span.offsetHeight;

    return { top, left, height };
  } finally {
    // Always remove the mirror — even if measurement throws — so an exception
    // mid-measurement never leaks a detached node into the document body.
    if (div.parentNode) div.parentNode.removeChild(div);
  }
}
