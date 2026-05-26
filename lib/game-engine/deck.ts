import type { Card, Rank, Suit } from './types';

const RANKS: Rank[] = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
const SUITS: Suit[] = ['c','d','h','s'];

export function newDeck(): Card[] {
  return SUITS.flatMap(suit => RANKS.map(rank => ({ rank, suit })));
}

export function shuffle(deck: Card[], random = Math.random): Card[] {
  const copy = [...deck];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function cardToString(card: Card): string {
  return `${card.rank}${card.suit}`;
}
