export function dollarsToCents(value: string | number): number {
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[$,]/g, ''));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

export function centsToDollars(cents: number | null | undefined): string {
  const value = (cents ?? 0) / 100;
  return value.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}
