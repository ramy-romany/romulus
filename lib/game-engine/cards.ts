import type { Card } from './types';

const SUIT_SYMBOL: Record<Card['suit'], string> = { c: '♣', d: '♦', h: '♥', s: '♠' };
const SUIT_NAME: Record<Card['suit'], string> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
const RANK_TEXT: Record<Card['rank'], string> = { T: '10', J: 'J', Q: 'Q', K: 'K', A: 'A', '2': '2', '3': '3', '4': '4', '5': '5', '6': '6', '7': '7', '8': '8', '9': '9' };

export function formatCard(card: Card): string {
  return `${RANK_TEXT[card.rank]}${SUIT_SYMBOL[card.suit]}`;
}

export function cardColor(card: Card): 'red' | 'black' {
  return card.suit === 'd' || card.suit === 'h' ? 'red' : 'black';
}

export function cardTitle(card: Card): string {
  return `${RANK_TEXT[card.rank]} of ${SUIT_NAME[card.suit]}`;
}

export function parseCard(value: string): Card {
  return { rank: value[0] as Card['rank'], suit: value[1] as Card['suit'] };
}
