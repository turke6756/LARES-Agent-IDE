const tabScrollFractions = new Map<string, number>();

export function setTabScrollFraction(tabId: string, fraction: number): void {
  if (!tabId || !Number.isFinite(fraction)) return;
  const clamped = Math.max(0, Math.min(1, fraction));
  tabScrollFractions.set(tabId, clamped);
}

export function getTabScrollFraction(tabId: string): number {
  if (!tabId) return 0;
  return tabScrollFractions.get(tabId) ?? 0;
}

export function clearTabScrollFraction(tabId: string): void {
  tabScrollFractions.delete(tabId);
}
