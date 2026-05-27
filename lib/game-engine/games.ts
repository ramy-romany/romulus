import type { GameDefinition } from './types';

export const GAME_CATALOG: GameDefinition[] = [
  {
    id: 'nlh', displayName: 'No-Limit Hold’em', family: 'holdem', betting: 'no-limit', holeCards: 2, maxPlayers: 6,
    burnCards: 'skip-if-needed', isBombPotDefault: false, board: { count: 1 }, summary: 'Classic NLH with blinds.'
  },
  ...[4,5,6].map(n => ({
    id: `plo-${n}`, displayName: `PLO ${n}`, family: 'omaha' as const, betting: 'pot-limit' as const, holeCards: n, maxPlayers: Math.floor(52 / n),
    burnCards: 'skip-if-needed' as const, isBombPotDefault: false, board: { count: 1 as const }, summary: `Pot-limit Omaha with ${n} hole cards.`
  })),
  ...[4,5,6].map(n => ({
    id: `plo-hilo-${n}`, displayName: `PLO Hi/Lo ${n}`, family: 'omaha' as const, betting: 'pot-limit' as const, holeCards: n, maxPlayers: Math.floor(52 / n),
    burnCards: 'skip-if-needed' as const, isBombPotDefault: false, lowRule: 'eight-or-better-a5' as const, board: { count: 1 as const }, summary: `PLO ${n} with A-5 8-or-better low.`
  })),
  ...[4,5,6].map(n => ({
    id: `pastrami-${n}`, displayName: `Pastrami ${n}`, family: 'omaha' as const, betting: 'pot-limit' as const, holeCards: n, maxPlayers: Math.floor(52 / n),
    burnCards: 'skip-if-needed' as const, isBombPotDefault: true, lowRule: 'eight-or-better-a5' as const,
    board: { count: 2 as const, highAcrossRemainingBoards: true, lowAcrossRemainingBoards: true },
    summary: `Double-board PLO Hi/Lo ${n}: best high and best low across both boards split.`
  })),
  ...[4,5,6].map(n => ({
    id: `costarica-${n}`, displayName: `CostaRica ${n}`, family: 'omaha' as const, betting: 'pot-limit' as const, holeCards: n, maxPlayers: Math.floor(52 / n),
    burnCards: 'skip-if-needed' as const, isBombPotDefault: true,
    board: { count: 2 as const, highAcrossRemainingBoards: true }, summary: `Double-board bomb pot PLO ${n}, high only.`
  })),
  ...[4,5,6].map(n => ({
    id: `get-fucked-${n}`, displayName: `Get Fucked ${n}`, family: 'omaha' as const, betting: 'pot-limit' as const, holeCards: n, maxPlayers: Math.floor(52 / n),
    burnCards: 'skip-if-needed' as const, isBombPotDefault: true, lowRule: 'eight-or-better-a5' as const,
    board: { count: 3 as const, removeLowestRiverBoard: true, highAcrossRemainingBoards: true, lowAcrossRemainingBoards: true },
    summary: `Triple-board bomb pot; lowest river board by rank/suit disappears; best high and low across remaining boards split.`
  })),

  {
    id: 'acey-deucey', displayName: 'Acey Deucey', family: 'acey-deucey', betting: 'pot-limit', holeCards: 0, maxPlayers: 6,
    burnCards: false, isBombPotDefault: true, board: { count: 1 },
    customRules: [
      'Every player antes 5× big blind into the pot.',
      'Acting player receives two open outer cards and may pass, bet, or replace the second card.',
      'Pass costs one big blind.',
      'Bet wins if the middle card lands strictly between the two outer cards.',
      'Outside cards lose the bet; matching either outer rank loses double the bet.',
      'Replacing the second card forces a minimum $50 bet; max bet is pot size capped at $1,000.',
      'After 55% of the deck is used, Romulus reshuffles a fresh deck and the hand continues.'
    ],
    summary: 'Acey Deucey: ante 5× blind, two outer cards, bet the middle card lands between them.'
  },
  {
    id: 'stud-7', displayName: '7-Card Stud', family: 'stud', betting: 'fixed-limit', holeCards: 7, maxPlayers: 6,
    burnCards: 'skip-if-needed', isBombPotDefault: false, summary: 'Fixed-limit 7-card stud.'
  },
  {
    id: 'stud-minnesota', displayName: 'Stud Minnesota', family: 'stud', betting: 'fixed-limit', holeCards: 7, maxPlayers: 6,
    burnCards: 'skip-if-needed', isBombPotDefault: true,
    customRules: [
      'Deal 4 cards to each player instead of 3.',
      'Each player discards 1 and exposes 1, leaving 1 up and 2 down.',
      'After final card, player may pay 2× bomb pot amount to replace one card.',
      'Replacement card is dealt in same state as replaced card: up if up, down if down.'
    ],
    summary: 'Your house-rule stud bomb-pot variant with optional paid replacement card.'
  }
];

export function playableWith(game: GameDefinition, playerCount: number): boolean {
  return playerCount <= game.maxPlayers;
}
