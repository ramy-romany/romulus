export type Suit = 'c' | 'd' | 'h' | 's';
export type Rank = '2'|'3'|'4'|'5'|'6'|'7'|'8'|'9'|'T'|'J'|'Q'|'K'|'A';

export type Card = {
  rank: Rank;
  suit: Suit;
};

export type BettingType = 'no-limit' | 'pot-limit' | 'fixed-limit';
export type LowRule = 'eight-or-better-a5';
export type GameFamily = 'holdem' | 'omaha' | 'stud' | 'acey-deucey';

export type BoardConfig = {
  count: 1 | 2 | 3;
  removeLowestRiverBoard?: boolean;
  highAcrossRemainingBoards?: boolean;
  lowAcrossRemainingBoards?: boolean;
};

export type GameDefinition = {
  id: string;
  displayName: string;
  family: GameFamily;
  summary: string;
  betting: BettingType;
  holeCards: number;
  maxPlayers: number;
  burnCards: boolean | 'skip-if-needed';
  isBombPotDefault: boolean;
  lowRule?: LowRule;
  board?: BoardConfig;
  customRules?: string[];
};

export type PlayerSeat = {
  userId: string;
  seat: number;
  stackCents: number;
  inHand: boolean;
  disconnectedAt?: string | null;
};

export type TableSettings = {
  smallBlindCents: number;
  bigBlindCents: number;
  defaultBombPotCents: number;
  actionClockSeconds: number;
  requireResultApproval: boolean;
};
