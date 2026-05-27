import { findGame, type RomulusHandState } from './handState';
import type { Card } from './types';
import { formatCard } from './cards';

const RANK_VALUE: Record<Card['rank'], number> = {
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 7,
  '8': 8,
  '9': 9,
  T: 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
};

const LOW_VALUE: Record<Card['rank'], number> = {
  A: 1,
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 7,
  '8': 8,
  '9': 9,
  T: 10,
  J: 11,
  Q: 12,
  K: 13,
};

type HighScore = {
  score: number[];
  label: string;
  cards: Card[];
};

type LowScore = {
  score: number[]; // descending A-5 low values, lower is better lexicographically
  label: string;
  cards: Card[];
};

type PlayerResult = {
  userId: string;
  name: string;
  high?: HighScore;
  low?: LowScore;
};

export type WinnerBanner = {
  userId: string;
  name: string;
  amountCents: number;
  reason: string;
  kind: 'high' | 'low' | 'scoop' | 'uncontested' | 'split';
};

export type ShowdownResolution = {
  supported: boolean;
  messages: string[];
  payoutsByUserId: Record<string, number>;
  highWinnerIds: string[];
  lowWinnerIds: string[];
  winnerBanners: WinnerBanner[];
  primaryBanner: string;
};

function combinations<T>(items: T[], count: number): T[][] {
  const results: T[][] = [];
  function walk(start: number, combo: T[]) {
    if (combo.length === count) {
      results.push([...combo]);
      return;
    }
    for (let i = start; i <= items.length - (count - combo.length); i++) {
      combo.push(items[i]);
      walk(i + 1, combo);
      combo.pop();
    }
  }
  walk(0, []);
  return results;
}

function compareHigh(a: HighScore | undefined, b: HighScore | undefined): number {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const length = Math.max(a.score.length, b.score.length);
  for (let i = 0; i < length; i++) {
    const av = a.score[i] ?? 0;
    const bv = b.score[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function compareLow(a: LowScore | undefined, b: LowScore | undefined): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const length = Math.max(a.score.length, b.score.length);
  for (let i = 0; i < length; i++) {
    const av = a.score[i] ?? 99;
    const bv = b.score[i] ?? 99;
    if (av !== bv) return av - bv; // lower is better
  }
  return 0;
}

function rankCounts(cards: Card[]) {
  const byRank = new Map<number, Card[]>();
  for (const card of cards) {
    const value = RANK_VALUE[card.rank];
    byRank.set(value, [...(byRank.get(value) ?? []), card]);
  }
  return byRank;
}

function straightHigh(values: number[]): number | null {
  const unique = [...new Set(values)].sort((a, b) => b - a);
  if (unique.includes(14)) unique.push(1);
  for (let i = 0; i <= unique.length - 5; i++) {
    const run = unique.slice(i, i + 5);
    if (run.every((value, index) => index === 0 || value === run[index - 1] - 1)) {
      return run[0] === 1 ? 5 : run[0];
    }
  }
  return null;
}

function evaluateFiveHigh(cards: Card[]): HighScore {
  const values = cards.map((card) => RANK_VALUE[card.rank]).sort((a, b) => b - a);
  const counts = [...rankCounts(cards).entries()]
    .map(([rank, rankCards]) => ({ rank, count: rankCards.length }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);
  const isFlush = cards.every((card) => card.suit === cards[0].suit);
  const straight = straightHigh(values);

  if (isFlush && straight) {
    return { score: [8, straight], label: straight === 14 ? 'Royal flush' : `${rankText(straight)}-high straight flush`, cards };
  }

  if (counts[0]?.count === 4) {
    const quad = counts[0].rank;
    const kicker = values.find((value) => value !== quad) ?? 0;
    return { score: [7, quad, kicker], label: `Four of a kind, ${rankPlural(quad)}`, cards };
  }

  if (counts[0]?.count === 3 && counts[1]?.count === 2) {
    return { score: [6, counts[0].rank, counts[1].rank], label: `Full house, ${rankPlural(counts[0].rank)} over ${rankPlural(counts[1].rank)}`, cards };
  }

  if (isFlush) {
    return { score: [5, ...values], label: `${rankText(values[0])}-high flush`, cards };
  }

  if (straight) {
    return { score: [4, straight], label: `${rankText(straight)}-high straight`, cards };
  }

  if (counts[0]?.count === 3) {
    const trip = counts[0].rank;
    const kickers = values.filter((value) => value !== trip).slice(0, 2);
    return { score: [3, trip, ...kickers], label: `Three of a kind, ${rankPlural(trip)}`, cards };
  }

  if (counts[0]?.count === 2 && counts[1]?.count === 2) {
    const highPair = Math.max(counts[0].rank, counts[1].rank);
    const lowPair = Math.min(counts[0].rank, counts[1].rank);
    const kicker = values.find((value) => value !== highPair && value !== lowPair) ?? 0;
    return { score: [2, highPair, lowPair, kicker], label: `Two pair, ${rankPlural(highPair)} and ${rankPlural(lowPair)}`, cards };
  }

  if (counts[0]?.count === 2) {
    const pair = counts[0].rank;
    const kickers = values.filter((value) => value !== pair).slice(0, 3);
    return { score: [1, pair, ...kickers], label: `Pair of ${rankPlural(pair)}`, cards };
  }

  return { score: [0, ...values], label: `${rankText(values[0])}-high`, cards };
}

function bestHighFromCombos(combos: Card[][]): HighScore | undefined {
  let best: HighScore | undefined;
  for (const combo of combos) {
    const score = evaluateFiveHigh(combo);
    if (!best || compareHigh(score, best) > 0) best = score;
  }
  return best;
}

function bestHoldemHigh(hole: Card[], board: Card[]): HighScore | undefined {
  if (hole.length + board.length < 5) return undefined;
  return bestHighFromCombos(combinations([...hole, ...board], 5));
}

function bestOmahaHigh(hole: Card[], board: Card[]): HighScore | undefined {
  if (hole.length < 2 || board.length < 3) return undefined;
  const combos: Card[][] = [];
  for (const h of combinations(hole, 2)) {
    for (const b of combinations(board, 3)) combos.push([...h, ...b]);
  }
  return bestHighFromCombos(combos);
}

function evaluateFiveLow(cards: Card[]): LowScore | undefined {
  const values = cards.map((card) => LOW_VALUE[card.rank]);
  const unique = new Set(values);
  if (unique.size !== 5) return undefined;
  if (Math.max(...values) > 8) return undefined;
  const descending = [...values].sort((a, b) => b - a);
  return { score: descending, label: `${descending.map(lowRankText).join('-')} low`, cards };
}

function bestLowFromCombos(combos: Card[][]): LowScore | undefined {
  let best: LowScore | undefined;
  for (const combo of combos) {
    const score = evaluateFiveLow(combo);
    if (!score) continue;
    if (!best || compareLow(score, best) < 0) best = score;
  }
  return best;
}

function bestHoldemLow(hole: Card[], board: Card[]): LowScore | undefined {
  if (hole.length + board.length < 5) return undefined;
  return bestLowFromCombos(combinations([...hole, ...board], 5));
}

function bestOmahaLow(hole: Card[], board: Card[]): LowScore | undefined {
  if (hole.length < 2 || board.length < 3) return undefined;
  const combos: Card[][] = [];
  for (const h of combinations(hole, 2)) {
    for (const b of combinations(board, 3)) combos.push([...h, ...b]);
  }
  return bestLowFromCombos(combos);
}

function rankText(value: number) {
  const names: Record<number, string> = {
    14: 'Ace', 13: 'King', 12: 'Queen', 11: 'Jack', 10: 'Ten', 9: 'Nine', 8: 'Eight', 7: 'Seven', 6: 'Six', 5: 'Five', 4: 'Four', 3: 'Three', 2: 'Two', 1: 'Ace',
  };
  return names[value] ?? String(value);
}

function lowRankText(value: number) {
  if (value === 1) return 'A';
  if (value === 10) return 'T';
  if (value === 11) return 'J';
  if (value === 12) return 'Q';
  if (value === 13) return 'K';
  return String(value);
}

function rankPlural(value: number) {
  if (value === 14) return 'Aces';
  if (value === 13) return 'Kings';
  if (value === 12) return 'Queens';
  if (value === 11) return 'Jacks';
  if (value === 10) return 'Tens';
  if (value === 9) return 'Nines';
  if (value === 8) return 'Eights';
  if (value === 7) return 'Sevens';
  if (value === 6) return 'Sixes';
  if (value === 5) return 'Fives';
  if (value === 4) return 'Fours';
  if (value === 3) return 'Threes';
  return 'Twos';
}

function splitCents(amount: number, userIds: string[]): Record<string, number> {
  const payouts: Record<string, number> = {};
  if (!amount || !userIds.length) return payouts;
  const base = Math.floor(amount / userIds.length);
  let remainder = amount - base * userIds.length;
  for (const userId of [...userIds].sort()) {
    payouts[userId] = (payouts[userId] ?? 0) + base + (remainder > 0 ? 1 : 0);
    remainder -= 1;
  }
  return payouts;
}

function addPayouts(target: Record<string, number>, source: Record<string, number>) {
  for (const [userId, amount] of Object.entries(source)) {
    target[userId] = (target[userId] ?? 0) + amount;
  }
}

function bestPlayerResults(state: RomulusHandState): PlayerResult[] {
  const game = findGame(state.gameId);
  const remainingBoards = (state.boards ?? []).filter((board) => !board.removed);
  const players = (state.players ?? [])
    .filter((player) => player.inHand && !player.folded)
    .map((player) => ({ userId: player.userId, name: player.name }));

  return players.map((player) => {
    const hole = state.holeCardsByUserId[player.userId] ?? [];
    const visible = state.visibleCardsByUserId?.[player.userId] ?? [];
    let high: HighScore | undefined;
    let low: LowScore | undefined;

    if (game.family === 'stud') {
      high = bestHighFromCombos(combinations([...hole, ...visible], 5));
    } else {
      for (const board of remainingBoards) {
        const boardHigh = game.family === 'omaha' ? bestOmahaHigh(hole, board.cards) : bestHoldemHigh(hole, board.cards);
        if (boardHigh && (!high || compareHigh(boardHigh, high) > 0)) high = boardHigh;

        if (game.lowRule) {
          const boardLow = game.family === 'omaha' ? bestOmahaLow(hole, board.cards) : bestHoldemLow(hole, board.cards);
          if (boardLow && (!low || compareLow(boardLow, low) < 0)) low = boardLow;
        }
      }
    }

    return { ...player, high, low };
  });
}


function playerResultsForSingleBoard(state: RomulusHandState, boardCards: Card[]): PlayerResult[] {
  const game = findGame(state.gameId);
  return (state.players ?? [])
    .filter((player) => player.inHand && !player.folded)
    .map((player) => {
      const hole = state.holeCardsByUserId[player.userId] ?? [];
      const high = game.family === 'omaha' ? bestOmahaHigh(hole, boardCards) : bestHoldemHigh(hole, boardCards);
      return { userId: player.userId, name: player.name, high };
    });
}

function resolveCostaRicaByBoard(state: RomulusHandState): ShowdownResolution {
  const boards = (state.boards ?? []).filter((board) => !board.removed);
  const pot = state.potCents ?? 0;
  const payoutsByUserId: Record<string, number> = {};
  const messages: string[] = [];
  const highWinnerIds: string[] = [];
  const winnerLabelsByUser = new Map<string, string>();

  if (!boards.length || pot <= 0) {
    return { supported: false, messages: ['No CostaRica board or pot to award.'], payoutsByUserId, highWinnerIds, lowWinnerIds: [], winnerBanners: [], primaryBanner: '' };
  }

  const baseShare = Math.floor(pot / boards.length);
  let remainder = pot - baseShare * boards.length;
  for (const board of boards) {
    const boardPot = baseShare + (remainder > 0 ? 1 : 0);
    remainder -= 1;
    const results = playerResultsForSingleBoard(state, board.cards);
    const boardWinners = winningHighIds(results);
    if (!boardWinners.length) continue;
    highWinnerIds.push(...boardWinners);
    addPayouts(payoutsByUserId, splitCents(boardPot, boardWinners));
    const best = resultById(results, boardWinners[0])?.high;
    const names = namesFor(results, boardWinners);
    const label = best?.label ? titleCaseReason(best.label) : 'best high';
    messages.push(`CostaRica: ${board.id} high goes to ${names} with ${best?.label ?? 'best high'} for ${moneyText(boardPot)}.`);
    for (const id of boardWinners) {
      winnerLabelsByUser.set(id, `${winnerLabelsByUser.get(id) ? `${winnerLabelsByUser.get(id)} + ` : ''}${board.id} ${label}`);
    }
  }

  if (!Object.keys(payoutsByUserId).length) {
    return { supported: false, messages: ['Automatic CostaRica showdown could not score this hand. Use manual Award.'], payoutsByUserId, highWinnerIds: [...new Set(highWinnerIds)], lowWinnerIds: [], winnerBanners: [], primaryBanner: '' };
  }

  const namesById = new Map((state.players ?? []).map((player) => [player.userId, player.name]));
  const winnerBanners = Object.entries(payoutsByUserId).map(([userId, amountCents]) => ({
    userId,
    name: namesById.get(userId) ?? 'Player',
    amountCents,
    kind: 'high' as const,
    reason: `wins board high with ${winnerLabelsByUser.get(userId) ?? 'best high'}`,
  }));
  const primaryBanner = winnerBanners.map(bannerLine).join(' · ');
  if (primaryBanner) messages.push(primaryBanner);

  return {
    supported: true,
    messages,
    payoutsByUserId,
    highWinnerIds: [...new Set(highWinnerIds)],
    lowWinnerIds: [],
    winnerBanners,
    primaryBanner,
  };
}

function winningHighIds(results: PlayerResult[]): string[] {
  const valid = results.filter((result) => result.high);
  if (!valid.length) return [];
  let best = valid[0].high;
  for (const result of valid.slice(1)) {
    if (compareHigh(result.high, best) > 0) best = result.high;
  }
  return valid.filter((result) => compareHigh(result.high, best) === 0).map((result) => result.userId);
}

function winningLowIds(results: PlayerResult[]): string[] {
  const valid = results.filter((result) => result.low);
  if (!valid.length) return [];
  let best = valid[0].low;
  for (const result of valid.slice(1)) {
    if (compareLow(result.low, best) < 0) best = result.low;
  }
  return valid.filter((result) => compareLow(result.low, best) === 0).map((result) => result.userId);
}

function resultById(results: PlayerResult[], userId: string) {
  return results.find((result) => result.userId === userId);
}

function namesFor(results: PlayerResult[], ids: string[]) {
  return ids.map((id) => resultById(results, id)?.name ?? 'Player').join(' / ');
}

function titleCaseReason(label: string) {
  return label
    .replace(/\b[a-z]/g, (match) => match.toUpperCase())
    .replace(/-High/g, '-high')
    .replace(/-Better/g, '-better');
}

function buildWinnerBanners(args: {
  results: PlayerResult[];
  payoutsByUserId: Record<string, number>;
  highWinnerIds: string[];
  lowWinnerIds: string[];
  lowPotExists: boolean;
}): WinnerBanner[] {
  const { results, payoutsByUserId, highWinnerIds, lowWinnerIds, lowPotExists } = args;
  const highSet = new Set(highWinnerIds);
  const lowSet = new Set(lowWinnerIds);
  return Object.entries(payoutsByUserId)
    .filter(([, amount]) => amount > 0)
    .map(([userId, amountCents]) => {
      const result = resultById(results, userId);
      const name = result?.name ?? 'Player';
      const high = result?.high?.label ? titleCaseReason(result.high.label) : '';
      const low = result?.low?.label ? titleCaseReason(result.low.label) : '';
      const wonHigh = highSet.has(userId);
      const wonLow = lowSet.has(userId);
      const isSplit = highWinnerIds.length > 1 || lowWinnerIds.length > 1;

      if (wonHigh && wonLow) {
        return {
          userId,
          name,
          amountCents,
          kind: 'scoop' as const,
          reason: high && low ? `scoops with ${high} and ${low}` : 'scoops the pot',
        };
      }

      if (wonHigh) {
        return {
          userId,
          name,
          amountCents,
          kind: isSplit ? 'split' as const : 'high' as const,
          reason: high
            ? `${lowPotExists ? 'wins high' : 'wins'} with ${high}`
            : `${lowPotExists ? 'wins high' : 'wins'} the pot`,
        };
      }

      if (wonLow) {
        return {
          userId,
          name,
          amountCents,
          kind: isSplit ? 'split' as const : 'low' as const,
          reason: low ? `wins low with ${low}` : 'wins low',
        };
      }

      return { userId, name, amountCents, kind: 'split' as const, reason: 'wins a share of the pot' };
    });
}

function bannerLine(banner: WinnerBanner) {
  return `${banner.name} ${banner.reason} · ${moneyText(banner.amountCents)}`;
}

function moneyText(amountCents: number) {
  const dollars = amountCents / 100;
  return dollars.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function resolveShowdown(state: RomulusHandState): ShowdownResolution {
  const game = findGame(state.gameId);
  if (game.id.startsWith('costarica-')) {
    return resolveCostaRicaByBoard(state);
  }

  const results = bestPlayerResults(state);
  const highWinnerIds = winningHighIds(results);
  const lowWinnerIds = game.lowRule ? winningLowIds(results) : [];
  const payoutsByUserId: Record<string, number> = {};
  const messages: string[] = [];
  const pot = state.potCents ?? 0;

  if (pot <= 0) {
    return { supported: false, messages: ['No pot to award.'], payoutsByUserId, highWinnerIds, lowWinnerIds, winnerBanners: [], primaryBanner: '' };
  }
  if (!highWinnerIds.length) {
    return { supported: false, messages: ['Automatic showdown could not score this hand yet. Use manual Award for this hand.'], payoutsByUserId, highWinnerIds, lowWinnerIds, winnerBanners: [], primaryBanner: '' };
  }

  if (game.lowRule && lowWinnerIds.length) {
    const lowHalf = Math.floor(pot / 2);
    const highHalf = pot - lowHalf;
    addPayouts(payoutsByUserId, splitCents(highHalf, highWinnerIds));
    addPayouts(payoutsByUserId, splitCents(lowHalf, lowWinnerIds));
    const high = resultById(results, highWinnerIds[0])?.high;
    const low = resultById(results, lowWinnerIds[0])?.low;
    messages.push(`Auto showdown: high goes to ${namesFor(results, highWinnerIds)}${high ? ` with ${high.label}` : ''}.`);
    messages.push(`Auto showdown: low goes to ${namesFor(results, lowWinnerIds)}${low ? ` with ${low.label}` : ''}.`);
  } else {
    addPayouts(payoutsByUserId, splitCents(pot, highWinnerIds));
    const high = resultById(results, highWinnerIds[0])?.high;
    messages.push(`Auto showdown: ${namesFor(results, highWinnerIds)} win${highWinnerIds.length === 1 ? 's' : ''} ${game.lowRule ? 'the full pot; no qualifying 8-or-better low.' : ''}${high ? ` with ${high.label}` : ''}.`);
  }

  const cardLine = highWinnerIds
    .map((id) => {
      const high = resultById(results, id)?.high;
      return high ? `${resultById(results, id)?.name ?? 'Winner'}: ${high.cards.map(formatCard).join(' ')}` : '';
    })
    .filter(Boolean)
    .join(' · ');
  if (cardLine) messages.push(`Winning high cards: ${cardLine}.`);

  const winnerBanners = buildWinnerBanners({
    results,
    payoutsByUserId,
    highWinnerIds,
    lowWinnerIds,
    lowPotExists: Boolean(game.lowRule && lowWinnerIds.length > 0),
  });
  const primaryBanner = winnerBanners.map(bannerLine).join(' · ');
  if (primaryBanner) messages.push(primaryBanner);

  return {
    supported: true,
    messages,
    payoutsByUserId,
    highWinnerIds,
    lowWinnerIds,
    winnerBanners,
    primaryBanner,
  };
}
