export type PlayerResult = { userId: string; name: string; netCents: number };
export type SettlementPayment = { from: string; to: string; amountCents: number };

export function optimizeSettlement(results: PlayerResult[]): SettlementPayment[] {
  const debtors = results.filter(r => r.netCents < 0).map(r => ({ ...r, amount: -r.netCents })).sort((a,b) => b.amount - a.amount);
  const creditors = results.filter(r => r.netCents > 0).map(r => ({ ...r, amount: r.netCents })).sort((a,b) => b.amount - a.amount);
  const payments: SettlementPayment[] = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].amount, creditors[j].amount);
    if (amount > 0) payments.push({ from: debtors[i].name, to: creditors[j].name, amountCents: amount });
    debtors[i].amount -= amount;
    creditors[j].amount -= amount;
    if (debtors[i].amount === 0) i++;
    if (creditors[j].amount === 0) j++;
  }
  return payments;
}
