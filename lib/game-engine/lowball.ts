import type { Card } from './types';

const LOW_RANK: Record<string, number> = { A: 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, T: 10, J: 11, Q: 12, K: 13 };

export function qualifiesEightOrBetterA5(cards: Card[]): boolean {
  const unique = [...new Set(cards.map(c => LOW_RANK[c.rank]))].sort((a, b) => a - b);
  if (unique.length < 5) return false;
  const bestFive = unique.slice(0, 5);
  return Math.max(...bestFive) <= 8;
}
