import { newDeck, shuffle } from './deck';
import { GAME_CATALOG } from './games';
import type { Card, GameDefinition } from './types';

export type BoardState = {
  id: string;
  cards: Card[];
  removed?: boolean;
  removedReason?: string;
};

export type GameplayPlayerState = {
  userId: string;
  seatNumber: number;
  name: string;
  inHand: boolean;
  folded: boolean;
  allIn: boolean;
};

export type AceyDuecyState = {
  currentPlayerUserId: string | null;
  currentPlayerName: string;
  currentPlayerSeat: number | null;
  leftCard: Card | null;
  rightCard: Card | null;
  middleCard: Card | null;
  hasReplaced: boolean;
  mustBetAfterReplace: boolean;
  passCostCents: number;
  minBetCents: number;
  replaceMinBetCents: number;
  replacePenaltyCents: number;
  maxBetCents: number;
  deckRefreshes: number;
  cardsUsedThisDeck: number;
  turnNumber: number;
  lastOutcome?: string;
};

export type RomulusHandState = {
  version: 2 | 3;
  handNumber: number;
  gameId: string;
  gameName: string;
  boardCount: number;
  street: 'predeal' | 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' | 'complete';
  deck: Card[];
  holeCardsByUserId: Record<string, Card[]>;
  visibleCardsByUserId?: Record<string, Card[]>;
  boards: BoardState[];
  potCents: number;
  postedCentsByUserId: Record<string, number>;
  startedAt: string;
  messages: string[];
  requireApproval: boolean;
  approved?: boolean;

  // v0.3 gameplay fields. These are intentionally inside the hand summary so
  // the static PWA can test real-time play through Supabase without a new schema.
  maxSeats?: 6;
  dealerSeat?: number;
  smallBlindCents?: number;
  bigBlindCents?: number;
  currentBetCents?: number;
  minRaiseCents?: number;
  actingUserId?: string | null;
  actedUserIds?: string[];
  streetContribByUserId?: Record<string, number>;
  players?: GameplayPlayerState[];
  gameplayStatus?: 'betting' | 'showdown' | 'complete';
  lastActionAt?: string;
  resultApplied?: boolean;
  showdownRevealedUserIds?: string[];
  showdownResult?: {
    payoutsByUserId: Record<string, number>;
    highWinnerIds: string[];
    lowWinnerIds: string[];
    messages: string[];
    winnerBanners?: Array<{
      userId: string;
      name: string;
      amountCents: number;
      reason: string;
      kind: 'high' | 'low' | 'scoop' | 'uncontested' | 'split';
    }>;
    primaryBanner?: string;
  };

  aceyDuecy?: AceyDuecyState;
};

export type SeatForDeal = {
  user_id: string;
  seat_number: number;
  stack_cents: number;
  profiles?: { display_name?: string | null; username?: string | null } | null;
};

export function findGame(gameId: string): GameDefinition {
  return GAME_CATALOG.find((game) => game.id === gameId) ?? GAME_CATALOG[0];
}

function draw(deck: Card[], count: number): Card[] {
  return deck.splice(0, count);
}

function dealAceyOuterCards(deck: Card[]): { leftCard: Card; rightCard: Card } {
  const [leftCard, rightCard] = draw(deck, 2);
  return { leftCard, rightCard };
}

export function createInitialHandState(args: {
  handNumber: number;
  gameId: string;
  seatedPlayers: SeatForDeal[];
  bombPotCents: number;
  requireApproval: boolean;
}): RomulusHandState {
  const game = findGame(args.gameId);
  const deck = shuffle(newDeck());
  const activePlayers = [...args.seatedPlayers]
    .filter((seat) => game.id === 'acey-deucey' ? true : seat.stack_cents > 0)
    .sort((a, b) => a.seat_number - b.seat_number);

  if (game.id === 'acey-deucey') {
    const firstPlayer = activePlayers[0];
    const { leftCard, rightCard } = dealAceyOuterCards(deck);
    const postedCentsByUserId: Record<string, number> = {};
    for (const player of activePlayers) postedCentsByUserId[player.user_id] = args.bombPotCents;
    return {
      version: 3,
      handNumber: args.handNumber,
      gameId: game.id,
      gameName: game.displayName,
      boardCount: 1,
      street: 'preflop',
      deck,
      holeCardsByUserId: {},
      visibleCardsByUserId: {},
      boards: [{ id: 'Acey Deucey', cards: [leftCard, rightCard] }],
      potCents: activePlayers.length * args.bombPotCents,
      postedCentsByUserId,
      startedAt: new Date().toISOString(),
      messages: [
        `${game.displayName} started with ${activePlayers.length} player${activePlayers.length === 1 ? '' : 's'}.`,
        `Everyone donated ${Math.round(args.bombPotCents / 100)} into the Acey Deucey pot.`,
        firstPlayer ? `Action starts on ${firstPlayer.profiles?.display_name ?? firstPlayer.profiles?.username ?? `Seat ${firstPlayer.seat_number}`}.` : 'No eligible player found.',
      ],
      requireApproval: args.requireApproval,
      aceyDuecy: {
        currentPlayerUserId: firstPlayer?.user_id ?? null,
        currentPlayerName: firstPlayer?.profiles?.display_name ?? firstPlayer?.profiles?.username ?? (firstPlayer ? `Seat ${firstPlayer.seat_number}` : 'Player'),
        currentPlayerSeat: firstPlayer?.seat_number ?? null,
        leftCard,
        rightCard,
        middleCard: null,
        hasReplaced: false,
        mustBetAfterReplace: false,
        passCostCents: 500,
        minBetCents: 500,
        replaceMinBetCents: 5000,
        replacePenaltyCents: 10000,
        maxBetCents: 100000,
        deckRefreshes: 0,
        cardsUsedThisDeck: 2,
        turnNumber: 1,
      },
    };
  }

  const holeCardsByUserId: Record<string, Card[]> = {};
  const visibleCardsByUserId: Record<string, Card[]> = {};

  if (game.id === 'stud-minnesota') {
    for (const player of activePlayers) {
      const four = draw(deck, 4);
      // MVP automation: first card is exposed, second/third stay down, fourth is auto-discarded.
      // Later we will let the player choose discard/exposed card.
      holeCardsByUserId[player.user_id] = [four[1], four[2]];
      visibleCardsByUserId[player.user_id] = [four[0]];
    }
  } else if (game.family === 'stud') {
    for (const player of activePlayers) {
      const cards = draw(deck, 3);
      holeCardsByUserId[player.user_id] = [cards[0], cards[1]];
      visibleCardsByUserId[player.user_id] = [cards[2]];
    }
  } else {
    for (const player of activePlayers) {
      holeCardsByUserId[player.user_id] = draw(deck, game.holeCards);
    }
  }

  const boardCount = game.board?.count ?? 1;
  const postedCentsByUserId: Record<string, number> = {};
  for (const player of activePlayers) postedCentsByUserId[player.user_id] = game.isBombPotDefault ? args.bombPotCents : 0;

  return {
    version: 2,
    handNumber: args.handNumber,
    gameId: game.id,
    gameName: game.displayName,
    boardCount,
    street: game.family === 'stud' ? 'preflop' : 'preflop',
    deck,
    holeCardsByUserId,
    visibleCardsByUserId,
    boards: Array.from({ length: boardCount }, (_, i) => ({ id: `Board ${i + 1}`, cards: [] })),
    potCents: game.isBombPotDefault ? activePlayers.length * args.bombPotCents : 0,
    postedCentsByUserId,
    startedAt: new Date().toISOString(),
    messages: [
      `${game.displayName} started with ${activePlayers.length} player${activePlayers.length === 1 ? '' : 's'}.`,
      ...(game.isBombPotDefault ? [`Bomb pot posted: $${Math.round(args.bombPotCents / 100)} each.`] : []),
    ],
    requireApproval: args.requireApproval,
  };
}

export function advanceCommunityStreet(state: RomulusHandState): RomulusHandState {
  const copy: RomulusHandState = JSON.parse(JSON.stringify(state));
  const game = findGame(copy.gameId);
  if (game.family === 'stud') return advanceStudStreet(copy);

  if (copy.street === 'preflop') {
    for (const board of copy.boards) board.cards.push(...draw(copy.deck, 3));
    copy.street = 'flop';
    copy.messages.push('Flop dealt.');
    return copy;
  }

  if (copy.street === 'flop') {
    for (const board of copy.boards) board.cards.push(...draw(copy.deck, 1));
    copy.street = 'turn';
    copy.messages.push('Turn dealt.');
    return copy;
  }

  if (copy.street === 'turn') {
    for (const board of copy.boards) board.cards.push(...draw(copy.deck, 1));
    copy.street = 'river';
    copy.messages.push('River dealt.');
    if (game.board?.removeLowestRiverBoard) {
      removeLowestRiverBoard(copy);
    }
    return copy;
  }

  if (copy.street === 'river') {
    copy.street = 'showdown';
    copy.messages.push('Showdown. Players may show or muck.');
    return copy;
  }

  return copy;
}

function advanceStudStreet(copy: RomulusHandState): RomulusHandState {
  const users = Object.keys(copy.holeCardsByUserId);
  if (copy.street === 'preflop') {
    for (const userId of users) copy.visibleCardsByUserId![userId].push(...draw(copy.deck, 1));
    copy.street = 'flop';
    copy.messages.push('Next up card dealt.');
    return copy;
  }
  if (copy.street === 'flop') {
    for (const userId of users) copy.visibleCardsByUserId![userId].push(...draw(copy.deck, 1));
    copy.street = 'turn';
    copy.messages.push('Next up card dealt.');
    return copy;
  }
  if (copy.street === 'turn') {
    for (const userId of users) copy.visibleCardsByUserId![userId].push(...draw(copy.deck, 1));
    copy.street = 'river';
    copy.messages.push('Final down card dealt.');
    for (const userId of users) copy.holeCardsByUserId[userId].push(...draw(copy.deck, 1));
    return copy;
  }
  if (copy.street === 'river') {
    copy.street = 'showdown';
    copy.messages.push('Showdown. Minnesota replacement is still manual in this MVP.');
    return copy;
  }
  return copy;
}

const RIVER_RANK: Record<string, number> = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };
const SUIT_TIEBREAKER: Record<string, number> = { c: 1, d: 2, h: 3, s: 4 };

function removeLowestRiverBoard(state: RomulusHandState) {
  const candidates = state.boards
    .map((board, index) => ({ board, index, river: board.cards[board.cards.length - 1] }))
    .filter((entry) => entry.river);
  candidates.sort((a, b) => {
    const rank = RIVER_RANK[a.river.rank] - RIVER_RANK[b.river.rank];
    if (rank !== 0) return rank;
    return SUIT_TIEBREAKER[a.river.suit] - SUIT_TIEBREAKER[b.river.suit];
  });
  const removed = candidates[0]?.board;
  if (removed) {
    removed.removed = true;
    removed.removedReason = 'Lowest river card disappeared. Clubs are lowest suit.';
    state.messages.push(`${removed.id} disappeared because it had the smallest river.`);
  }
}
