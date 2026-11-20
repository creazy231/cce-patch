// The gap between what iOS reports as the viewport and the screen in standalone mode: WebKit's viewport
// can be short by the top safe-area inset while drawing from y = 0 (WebKit bugs 237961 and 301994).

export function standaloneGap(m: {
  standalone: boolean;
  sat: number;
  lvh: number;
  innerHeight: number;
  keyboardOpen: boolean;
  last: number;
}): number {
  if (!Number.isFinite(m.sat) || !Number.isFinite(m.lvh) || !Number.isFinite(m.innerHeight) || !Number.isFinite(m.last)) return 0;
  if (!m.standalone || m.sat <= 0) return 0;
  if (m.keyboardOpen) return m.last;
  const d = m.lvh - m.innerHeight;
  return Math.abs(d - m.sat) <= 2 ? d : 0;
}
