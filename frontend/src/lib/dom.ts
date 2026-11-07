/**
 * Small DOM helpers shared by list-like components.
 */

/**
 * Scroll `container` (only it, never the page or other ancestors) so that `el` is visible.
 * Unlike `el.scrollIntoView()`, this cannot shift an `overflow: hidden` app shell.
 */
export function scrollIntoViewWithin(el: HTMLElement | null, container: HTMLElement | null, margin = 8): void {
  if (!el || !container) return
  const c = container.getBoundingClientRect()
  const r = el.getBoundingClientRect()
  if (r.top < c.top + margin) container.scrollTop -= c.top + margin - r.top
  else if (r.bottom > c.bottom - margin) container.scrollTop += r.bottom - (c.bottom - margin)
}
