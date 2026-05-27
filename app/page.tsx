"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent, TouchEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { GAME_CATALOG, playableWith } from "@/lib/game-engine/games";
import type { Card } from "@/lib/game-engine/types";
import {
  advanceCommunityStreet,
  createInitialHandState,
  findGame,
  type RomulusHandState,
  type SeatForDeal,
} from "@/lib/game-engine/handState";
import { formatCard, cardColor } from "@/lib/game-engine/cards";
import { optimizeSettlement } from "@/lib/game-engine/settlement";
import { resolveShowdown } from "@/lib/game-engine/handEvaluator";
import { centsToDollars, dollarsToCents } from "@/lib/money";
import { supabase, supabaseReady } from "@/lib/supabaseClient";

type Profile = {
  id: string;
  username: string;
  display_name: string;
  is_admin: boolean;
};

type PokerTable = {
  id: string;
  name: string;
  created_by: string | null;
  small_blind_cents: number;
  big_blind_cents: number;
  default_bomb_pot_cents: number;
  bomb_pot_cents?: number | null;
  action_clock_seconds: number;
  action_deadline?: string | null;
  require_result_approval: boolean;
  status: string;
  current_game_id?: string | null;
  button_seat?: number | null;
  paused?: boolean | null;
  created_at: string;
};

type Seat = {
  table_id: string;
  user_id: string;
  seat_number: number;
  stack_cents: number;
  is_active: boolean;
  profiles?: { username: string; display_name: string } | null;
};

type LedgerEntry = {
  id: string;
  table_id: string;
  user_id: string;
  type: "buyin" | "cashout" | "adjustment";
  amount_cents: number;
  created_at: string;
  profiles?: { username: string; display_name: string } | null;
};

type Hand = {
  id: string;
  table_id: string;
  hand_number: number;
  game_id: string;
  dealer_user_id: string | null;
  result_status: "pending" | "approved" | "rejected";
  summary: RomulusHandState;
  created_at: string;
};

type TableMessage = {
  id: string;
  table_id: string;
  user_id: string | null;
  kind: "chat" | "system";
  body: string;
  created_at: string;
  profiles?: { username: string; display_name: string } | null;
};

type WinnerAnnouncement = {
  handId: string;
  handNumber: number;
  primaryBanner: string;
  banners: NonNullable<NonNullable<RomulusHandState["showdownResult"]>["winnerBanners"]>;
};

const EMPTY_TABLE_NAME = "Friday Night Romulus";
const MAX_TABLE_SEATS = 6;

function usernameToEmail(username: string) {
  const trimmed = username.trim().toLowerCase();
  if (trimmed.includes("@")) return trimmed;
  return `${trimmed}@romulus.local`;
}


function deepCopyHandState(state: RomulusHandState): RomulusHandState {
  return JSON.parse(JSON.stringify(state)) as RomulusHandState;
}

function displayNameForSeat(seat: SeatForDeal | Seat) {
  return (
    seat.profiles?.display_name ?? seat.profiles?.username ?? `Seat ${seat.seat_number}`
  );
}

function orderedSeats<T extends { seat_number: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.seat_number - b.seat_number);
}

function nextOccupiedSeat<T extends { seat_number: number }>(
  seats: T[],
  fromSeat: number,
): T | null {
  const sorted = orderedSeats(seats);
  if (!sorted.length) return null;
  return sorted.find((seat) => seat.seat_number > fromSeat) ?? sorted[0];
}

function nextActingPlayer(
  state: RomulusHandState,
  fromSeat: number,
): string | null {
  const candidates = (state.players ?? []).filter(
    (player) => player.inHand && !player.folded && !player.allIn,
  );
  if (!candidates.length) return null;
  const sorted = [...candidates].sort((a, b) => a.seatNumber - b.seatNumber);
  return (
    sorted.find((player) => player.seatNumber > fromSeat) ?? sorted[0]
  ).userId;
}

function firstPostflopActor(state: RomulusHandState): string | null {
  return nextActingPlayer(state, state.dealerSeat ?? 1);
}

function activeGameplayPlayers(state: RomulusHandState) {
  return (state.players ?? []).filter((player) => player.inHand && !player.folded);
}

function playersWhoCanAct(state: RomulusHandState) {
  return activeGameplayPlayers(state).filter((player) => !player.allIn);
}

function ensureGameplayState(state: RomulusHandState) {
  state.currentBetCents = state.currentBetCents ?? 0;
  state.minRaiseCents = state.minRaiseCents ?? state.bigBlindCents ?? 500;
  state.actedUserIds = state.actedUserIds ?? [];
  state.streetContribByUserId = state.streetContribByUserId ?? {};
  state.postedCentsByUserId = state.postedCentsByUserId ?? {};
  state.players = state.players ?? [];
  state.gameplayStatus = state.gameplayStatus ?? "betting";
}

function bettingRoundComplete(state: RomulusHandState): boolean {
  ensureGameplayState(state);
  const currentBet = state.currentBetCents ?? 0;
  const acted = new Set(state.actedUserIds ?? []);
  return playersWhoCanAct(state).every((player) => {
    const posted = state.streetContribByUserId?.[player.userId] ?? 0;
    return acted.has(player.userId) && posted >= currentBet;
  });
}

function callAmountFor(state: RomulusHandState, userId: string): number {
  ensureGameplayState(state);
  const currentBet = state.currentBetCents ?? 0;
  const posted = state.streetContribByUserId?.[userId] ?? 0;
  return Math.max(0, currentBet - posted);
}

function minRaiseToFor(state: RomulusHandState): number {
  ensureGameplayState(state);
  const currentBet = state.currentBetCents ?? 0;
  const increment = state.minRaiseCents ?? state.bigBlindCents ?? 500;
  if (currentBet <= 0) return increment;
  return currentBet + increment;
}

function maxRaiseToFor(args: {
  state: RomulusHandState;
  seat: Seat | null;
  betting: "no-limit" | "pot-limit" | "fixed-limit";
}): number {
  const { state, seat, betting } = args;
  if (!seat) return 0;
  ensureGameplayState(state);
  const posted = state.streetContribByUserId?.[seat.user_id] ?? 0;
  const call = callAmountFor(state, seat.user_id);
  const stackCap = posted + seat.stack_cents;
  const currentBet = state.currentBetCents ?? 0;

  if (betting === "fixed-limit") {
    return Math.min(stackCap, minRaiseToFor(state));
  }
  if (betting === "pot-limit") {
    const potRaiseTo = currentBet + (state.potCents ?? 0) + call;
    return Math.min(stackCap, Math.max(potRaiseTo, minRaiseToFor(state)));
  }
  return stackCap;
}

export default function HomePage() {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [authUsername, setAuthUsername] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordNotice, setPasswordNotice] = useState("");
  const [autoStartNextHand, setAutoStartNextHand] = useState(true);
  const [winnerAnnouncement, setWinnerAnnouncement] = useState<WinnerAnnouncement | null>(null);

  const autoResolveKeyRef = useRef("");
  const autoNextHandKeyRef = useRef("");

  const [tables, setTables] = useState<PokerTable[]>([]);
  const [activeTableId, setActiveTableId] = useState<string>("");
  const [activeTable, setActiveTable] = useState<PokerTable | null>(null);
  const [seats, setSeats] = useState<Seat[]>([]);
  const [messages, setMessages] = useState<TableMessage[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [hands, setHands] = useState<Hand[]>([]);
  const [chatBody, setChatBody] = useState("");
  const [newTableName, setNewTableName] = useState(EMPTY_TABLE_NAME);
  const [buyInDollars, setBuyInDollars] = useState("500");
  const [cashOutDollars, setCashOutDollars] = useState("0");
  const [manualBetDollars, setManualBetDollars] = useState("25");
  const [clockTick, setClockTick] = useState(Date.now());
  const [notice, setNotice] = useState("");
  const [realtimeStatus, setRealtimeStatus] = useState("connecting");
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [feltTheme, setFeltTheme] = useState<
    "green" | "blue" | "burgundy" | "black"
  >("green");
  const [cardBackTheme, setCardBackTheme] = useState<
    "red" | "blue" | "black" | "gold"
  >("red");
  const [roomTheme, setRoomTheme] = useState<"dark" | "casino" | "minimal">(
    "dark",
  );
  const [deckMode, setDeckMode] = useState<"standard" | "four-color">(
    "standard",
  );

  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session ?? null);
      setLoading(false);
    });
    const { data: authSub } = supabase.auth.onAuthStateChange(
      (_event, nextSession) => {
        setSession(nextSession);
      },
    );
    return () => {
      mounted = false;
      authSub.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClockTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!session?.user) {
      setProfile(null);
      return;
    }
    loadProfile(session.user.id, session.user.email ?? "");
  }, [session?.user?.id]);

  useEffect(() => {
    if (!session) return;
    loadTables();
    const channel = supabase
      .channel("romulus-lobby")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "tables" },
        () => loadTables(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [session?.user?.id]);

  useEffect(() => {
    if (!activeTableId) {
      setActiveTable(null);
      setSeats([]);
      setMessages([]);
      setLedger([]);
      setHands([]);
      return;
    }
    refreshTable(activeTableId);
    setRealtimeStatus("connecting");
    const poller = window.setInterval(() => {
      refreshTable(activeTableId);
    }, 2500);
    const channel = supabase
      .channel(`romulus-table-${activeTableId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "tables",
          filter: `id=eq.${activeTableId}`,
        },
        () => refreshTable(activeTableId),
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "table_seats",
          filter: `table_id=eq.${activeTableId}`,
        },
        () => refreshTable(activeTableId),
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "table_messages",
          filter: `table_id=eq.${activeTableId}`,
        },
        () => refreshTable(activeTableId),
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "ledger_entries",
          filter: `table_id=eq.${activeTableId}`,
        },
        () => refreshTable(activeTableId),
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "hands",
          filter: `table_id=eq.${activeTableId}`,
        },
        () => refreshTable(activeTableId),
      )
      .subscribe((status) => {
        setRealtimeStatus(status);
        if (status === "SUBSCRIBED") refreshTable(activeTableId);
      });
    return () => {
      window.clearInterval(poller);
      supabase.removeChannel(channel);
    };
  }, [activeTableId]);

  async function loadProfile(userId: string, email: string) {
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .maybeSingle();
    if (error) {
      console.error(error);
      setNotice(`Profile error: ${error.message}`);
      return;
    }
    if (data) {
      setProfile(data as Profile);
      return;
    }
    const username = email.split("@")[0] || "player";
    const displayName = username.charAt(0).toUpperCase() + username.slice(1);
    const { data: created, error: createError } = await supabase
      .from("profiles")
      .insert({
        id: userId,
        username,
        display_name: displayName,
        is_admin: false,
      })
      .select("*")
      .single();
    if (createError) {
      console.error(createError);
      setNotice(`Could not create profile: ${createError.message}`);
      return;
    }
    setProfile(created as Profile);
  }

  async function signIn() {
    setAuthError("");
    const { error } = await supabase.auth.signInWithPassword({
      email: usernameToEmail(authUsername),
      password: authPassword,
    });
    if (error) setAuthError(error.message);
  }

  async function signOut() {
    await supabase.auth.signOut();
    setActiveTableId("");
  }

  async function changePassword() {
    setPasswordNotice("");
    const trimmed = newPassword.trim();
    if (trimmed.length < 8) {
      setPasswordNotice("Use at least 8 characters for the new password.");
      return;
    }
    const { error } = await supabase.auth.updateUser({ password: trimmed });
    if (error) {
      setPasswordNotice(error.message);
      return;
    }
    setNewPassword("");
    setPasswordNotice("Password updated.");
  }

  async function loadTables() {
    const { data, error } = await supabase
      .from("tables")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) {
      console.error(error);
      setNotice(`Table load error: ${error.message}`);
      return;
    }
    setTables((data ?? []) as PokerTable[]);
  }

  async function refreshTable(tableId: string) {
    const [tableRes, seatsRes, messagesRes, ledgerRes, handsRes] =
      await Promise.all([
        supabase.from("tables").select("*").eq("id", tableId).maybeSingle(),
        supabase
          .from("table_seats")
          .select("*, profiles(username, display_name)")
          .eq("table_id", tableId)
          .order("seat_number"),
        supabase
          .from("table_messages")
          .select("*, profiles(username, display_name)")
          .eq("table_id", tableId)
          .order("created_at", { ascending: true })
          .limit(80),
        supabase
          .from("ledger_entries")
          .select("*, profiles(username, display_name)")
          .eq("table_id", tableId)
          .order("created_at", { ascending: true }),
        supabase
          .from("hands")
          .select("*")
          .eq("table_id", tableId)
          .order("hand_number", { ascending: false })
          .limit(20),
      ]);

    if (tableRes.error) console.error(tableRes.error);
    if (seatsRes.error) console.error(seatsRes.error);
    if (messagesRes.error) console.error(messagesRes.error);
    if (ledgerRes.error) console.error(ledgerRes.error);
    if (handsRes.error) console.error(handsRes.error);

    setActiveTable((tableRes.data as PokerTable | null) ?? null);
    setSeats((seatsRes.data ?? []) as Seat[]);
    setMessages((messagesRes.data ?? []) as TableMessage[]);
    setLedger((ledgerRes.data ?? []) as LedgerEntry[]);
    setHands((handsRes.data ?? []) as Hand[]);
    setLastSyncAt(Date.now());
  }

  async function createTable() {
    if (!profile) return;
    const { data, error } = await supabase
      .from("tables")
      .insert({
        name: newTableName || EMPTY_TABLE_NAME,
        created_by: profile.id,
        small_blind_cents: 250,
        big_blind_cents: 500,
        default_bomb_pot_cents: 2500,
        bomb_pot_cents: 2500,
        action_clock_seconds: 30,
        require_result_approval: true,
        current_game_id: "nlh",
        button_seat: 1,
      })
      .select("*")
      .single();
    if (error) {
      setNotice(error.message);
      return;
    }
    setActiveTableId((data as PokerTable).id);
    await postSystemMessage(
      (data as PokerTable).id,
      `${profile.display_name} created the table.`,
    );
  }

  function nextOpenSeat() {
    const taken = new Set(seats.map((seat) => seat.seat_number));
    for (let i = 1; i <= MAX_TABLE_SEATS; i++) if (!taken.has(i)) return i;
    return null;
  }

  async function sitDown() {
    if (!profile || !activeTableId) return;
    const existing = seats.find((seat) => seat.user_id === profile.id);
    if (existing) return;
    const seat = nextOpenSeat();
    if (!seat) {
      setNotice("This table is full.");
      return;
    }
    const { error } = await supabase
      .from("table_seats")
      .insert({
        table_id: activeTableId,
        user_id: profile.id,
        seat_number: seat,
        stack_cents: 0,
        is_active: true,
      });
    if (error) setNotice(error.message);
    else
      await postSystemMessage(
        activeTableId,
        `${profile.display_name} sat in seat ${seat}.`,
      );
  }

  async function standUp(userId: string) {
    if (!activeTableId || !profile) return;
    const target = seats.find((seat) => seat.user_id === userId);
    if (!target) return;
    if (profile.id !== userId && !profile.is_admin) return;
    const { error } = await supabase
      .from("table_seats")
      .delete()
      .eq("table_id", activeTableId)
      .eq("user_id", userId);
    if (error) setNotice(error.message);
    else
      await postSystemMessage(
        activeTableId,
        `${target.profiles?.display_name ?? "Player"} left the table.`,
      );
  }

  async function addBuyIn() {
    if (!profile || !activeTableId) return;
    const amount = dollarsToCents(buyInDollars);
    if (amount <= 0) return;
    const seat = seats.find((s) => s.user_id === profile.id);
    if (!seat) {
      setNotice("Sit down before buying in.");
      return;
    }
    const { error: ledgerError } = await supabase
      .from("ledger_entries")
      .insert({
        table_id: activeTableId,
        user_id: profile.id,
        type: "buyin",
        amount_cents: amount,
      });
    if (ledgerError) {
      setNotice(ledgerError.message);
      return;
    }
    const { error } = await supabase
      .from("table_seats")
      .update({ stack_cents: seat.stack_cents + amount })
      .eq("table_id", activeTableId)
      .eq("user_id", profile.id);
    if (error) setNotice(error.message);
    else
      await postSystemMessage(
        activeTableId,
        `${profile.display_name} bought in for ${centsToDollars(amount)}.`,
      );
  }

  async function cashOut() {
    if (!profile || !activeTableId) return;
    const amount = dollarsToCents(cashOutDollars);
    if (amount <= 0) return;
    const seat = seats.find((s) => s.user_id === profile.id);
    if (!seat || seat.stack_cents < amount) {
      setNotice("Cash-out amount is higher than your stack.");
      return;
    }
    const { error: ledgerError } = await supabase
      .from("ledger_entries")
      .insert({
        table_id: activeTableId,
        user_id: profile.id,
        type: "cashout",
        amount_cents: amount,
      });
    if (ledgerError) {
      setNotice(ledgerError.message);
      return;
    }
    const { error } = await supabase
      .from("table_seats")
      .update({ stack_cents: seat.stack_cents - amount })
      .eq("table_id", activeTableId)
      .eq("user_id", profile.id);
    if (error) setNotice(error.message);
    else
      await postSystemMessage(
        activeTableId,
        `${profile.display_name} cashed out ${centsToDollars(amount)}.`,
      );
  }

  async function postChat() {
    if (!profile || !activeTableId || !chatBody.trim()) return;
    const body = chatBody.trim();
    setChatBody("");
    const { error } = await supabase
      .from("table_messages")
      .insert({
        table_id: activeTableId,
        user_id: profile.id,
        kind: "chat",
        body,
      });
    if (error) setNotice(error.message);
    else await refreshTable(activeTableId);
  }

  async function postSystemMessage(tableId: string, body: string) {
    if (!profile) return;
    await supabase
      .from("table_messages")
      .insert({ table_id: tableId, user_id: profile.id, kind: "system", body });
    if (tableId === activeTableId) await refreshTable(tableId);
  }

  async function updateTablePatch(patch: Partial<PokerTable>) {
    if (!activeTableId) return;
    const { error } = await supabase
      .from("tables")
      .update(patch)
      .eq("id", activeTableId);
    if (error) setNotice(error.message);
    else await refreshTable(activeTableId);
  }

  async function chooseGame(gameId: string) {
    const game = findGame(gameId);
    await updateTablePatch({ current_game_id: game.id });
    if (activeTableId && profile)
      await postSystemMessage(
        activeTableId,
        `${profile.display_name} chose ${game.displayName}.`,
      );
  }

  async function chooseRandomGame() {
    const playable = GAME_CATALOG.filter((game) =>
      playableWith(game, seatedPlayers.length || 1),
    );
    const game =
      playable[Math.floor(Math.random() * playable.length)] ?? GAME_CATALOG[0];
    await chooseGame(game.id);
  }

  async function startHand(options?: { force?: boolean; reason?: string }) {
    try {
      setNotice(options?.reason ?? "Starting hand…");

      if (!activeTableId) {
        setNotice("No active table selected.");
        return;
      }
      if (!profile) {
        setNotice(
          "Profile is still loading. Sign out and back in if this continues.",
        );
        return;
      }

      const [freshTableRes, freshSeatsRes, freshHandsRes] = await Promise.all([
        supabase.from("tables").select("*").eq("id", activeTableId).maybeSingle(),
        supabase
          .from("table_seats")
          .select("*, profiles(username, display_name)")
          .eq("table_id", activeTableId)
          .order("seat_number"),
        supabase
          .from("hands")
          .select("*")
          .eq("table_id", activeTableId)
          .order("hand_number", { ascending: false })
          .limit(1),
      ]);

      if (freshTableRes.error) {
        setNotice(`Could not load table: ${freshTableRes.error.message}`);
        return;
      }
      if (freshSeatsRes.error) {
        setNotice(`Could not load seats: ${freshSeatsRes.error.message}`);
        return;
      }
      if (freshHandsRes.error) {
        setNotice(`Could not load hands: ${freshHandsRes.error.message}`);
        return;
      }

      const table = freshTableRes.data as PokerTable | null;
      if (!table) {
        setNotice("Table data is still loading. Wait one second and try again.");
        return;
      }

      const latestHand = ((freshHandsRes.data ?? [])[0] as Hand | undefined) ?? null;
      const latestState = latestHand?.summary;
      const latestIsOpen = Boolean(
        latestHand &&
          latestState &&
          latestState.gameplayStatus !== "complete" &&
          latestState.street !== "complete",
      );
      if (latestIsOpen && !options?.force) {
        setNotice(
          "Finish or resolve the current hand before starting another one so the pot cannot disappear into an old hand.",
        );
        return;
      }

      const freshSeats = (freshSeatsRes.data ?? []) as Seat[];
      const activeSeats: Seat[] = orderedSeats(
        freshSeats.filter((seat) => seat.is_active && seat.stack_cents > 0),
      );
      if (activeSeats.length < 2) {
        setNotice(
          "Need at least two seated players with chips to start a hand.",
        );
        return;
      }
      if (activeSeats.length > MAX_TABLE_SEATS) {
        setNotice("Romulus is now set to a 6-max table.");
        return;
      }

      const gameId = table.current_game_id || "nlh";
      const game = findGame(gameId);
      if (!playableWith(game, activeSeats.length)) {
        setNotice(
          `${game.displayName} does not have enough cards for ${activeSeats.length} players.`,
        );
        return;
      }

      const handNumber = (latestHand?.hand_number ?? 0) + 1;
      const bombPotCents =
        table.bomb_pot_cents ?? table.default_bomb_pot_cents;
      let state = createInitialHandState({
        handNumber,
        gameId,
        seatedPlayers: activeSeats as SeatForDeal[],
        bombPotCents,
        requireApproval: table.require_result_approval,
      });
      state.version = 3;
      state.maxSeats = MAX_TABLE_SEATS;
      state.smallBlindCents = table.small_blind_cents;
      state.bigBlindCents = table.big_blind_cents;
      state.minRaiseCents = table.big_blind_cents;
      state.currentBetCents = 0;
      state.actedUserIds = [];
      state.streetContribByUserId = {};
      state.gameplayStatus = "betting";
      state.resultApplied = false;
      state.players = activeSeats.map((seat) => ({
        userId: seat.user_id,
        seatNumber: seat.seat_number,
        name: displayNameForSeat(seat),
        inHand: true,
        folded: false,
        allIn: false,
      }));

      const dealer =
        activeSeats.find((seat) => seat.seat_number === table.button_seat) ??
        activeSeats[0];
      state.dealerSeat = dealer.seat_number;

      const stackUpdates: Array<{ userId: string; amountCents: number }> = [];

      if (game.isBombPotDefault) {
        for (const seat of activeSeats) {
          const posted = Math.min(seat.stack_cents, bombPotCents);
          state.postedCentsByUserId[seat.user_id] = posted;
          state.streetContribByUserId[seat.user_id] = 0;
          stackUpdates.push({ userId: seat.user_id, amountCents: posted });
          const player = state.players!.find((item) => item.userId === seat.user_id);
          if (player && seat.stack_cents - posted <= 0) player.allIn = true;
        }
        if (game.family !== "stud") {
          state = advanceCommunityStreet(state);
        }
        state.currentBetCents = 0;
        state.minRaiseCents = table.big_blind_cents;
        state.actedUserIds = [];
        state.streetContribByUserId = {};
        state.actingUserId = firstPostflopActor(state);
      } else {
        const smallBlindSeat = nextOccupiedSeat(activeSeats, dealer.seat_number) ?? activeSeats[0];
        const bigBlindSeat =
          nextOccupiedSeat(activeSeats, smallBlindSeat.seat_number) ?? smallBlindSeat;
        const sb = Math.min(smallBlindSeat.stack_cents, table.small_blind_cents);
        const bb = Math.min(bigBlindSeat.stack_cents, table.big_blind_cents);
        state.potCents += sb + bb;
        state.postedCentsByUserId[smallBlindSeat.user_id] =
          (state.postedCentsByUserId[smallBlindSeat.user_id] ?? 0) + sb;
        state.postedCentsByUserId[bigBlindSeat.user_id] =
          (state.postedCentsByUserId[bigBlindSeat.user_id] ?? 0) + bb;
        state.streetContribByUserId[smallBlindSeat.user_id] = sb;
        state.streetContribByUserId[bigBlindSeat.user_id] = bb;
        state.currentBetCents = bb;
        state.minRaiseCents = table.big_blind_cents;
        stackUpdates.push({ userId: smallBlindSeat.user_id, amountCents: sb });
        stackUpdates.push({ userId: bigBlindSeat.user_id, amountCents: bb });
        const sbPlayer = state.players!.find((item) => item.userId === smallBlindSeat.user_id);
        const bbPlayer = state.players!.find((item) => item.userId === bigBlindSeat.user_id);
        if (sbPlayer && smallBlindSeat.stack_cents - sb <= 0) sbPlayer.allIn = true;
        if (bbPlayer && bigBlindSeat.stack_cents - bb <= 0) bbPlayer.allIn = true;
        state.messages.push(
          `${displayNameForSeat(smallBlindSeat)} posted small blind ${centsToDollars(sb)}.`,
        );
        state.messages.push(
          `${displayNameForSeat(bigBlindSeat)} posted big blind ${centsToDollars(bb)}.`,
        );
        const preflopStart =
          activeSeats.length === 2
            ? smallBlindSeat
            : nextOccupiedSeat(activeSeats, bigBlindSeat.seat_number);
        state.actingUserId = preflopStart?.user_id ?? null;
      }

      if (!state.actingUserId) {
        state.gameplayStatus = "showdown";
        state.street = "showdown";
        state.messages.push("Everyone is all-in. Runout complete or ready for showdown.");
      } else {
        const actor = state.players!.find((player) => player.userId === state.actingUserId);
        state.messages.push(`Action is on ${actor?.name ?? "next player"}.`);
      }
      state.lastActionAt = new Date().toISOString();

      for (const update of stackUpdates) {
        const seat = activeSeats.find((item) => item.user_id === update.userId);
        if (!seat || update.amountCents <= 0) continue;
        const { error: stackError } = await supabase
          .from("table_seats")
          .update({
            stack_cents: Math.max(0, seat.stack_cents - update.amountCents),
          })
          .eq("table_id", activeTableId)
          .eq("user_id", update.userId);
        if (stackError) {
          setNotice(`Could not post forced bet: ${stackError.message}`);
          return;
        }
      }

      const { error } = await supabase.from("hands").insert({
        table_id: activeTableId,
        hand_number: handNumber,
        game_id: gameId,
        dealer_user_id: dealer?.user_id ?? null,
        result_status: "pending",
        summary: state,
      });

      if (error) {
        setNotice(`Could not start hand: ${error.message}`);
        return;
      }

      const nextButtonSeat = nextOccupiedSeat(activeSeats, dealer.seat_number);
      if (nextButtonSeat) {
        await supabase
          .from("tables")
          .update({ button_seat: nextButtonSeat.seat_number })
          .eq("id", activeTableId);
      }

      await postSystemMessage(
        activeTableId,
        `Hand #${handNumber} started: ${game.displayName}.`,
      );
      await refreshTable(activeTableId);
      setNotice(`Hand #${handNumber} started.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(error);
      setNotice(`Start hand crashed: ${message}`);
    }
  }

  async function updateActiveHand(
    state: RomulusHandState,
    resultStatus?: Hand["result_status"],
  ) {
    const hand = activeHand;
    if (!hand) return;
    const update: Partial<Hand> = { summary: state };
    if (resultStatus) update.result_status = resultStatus;
    const { error } = await supabase
      .from("hands")
      .update(update)
      .eq("id", hand.id);
    if (error) setNotice(error.message);
    else if (activeTableId) await refreshTable(activeTableId);
  }

  function scheduleNextHand(completedHandId: string) {
    if (!autoStartNextHand || !activeTableId || activeTable?.paused) return;
    if (autoNextHandKeyRef.current === completedHandId) return;
    autoNextHandKeyRef.current = completedHandId;
    window.setTimeout(() => {
      startHand({ force: true, reason: "Starting next hand…" });
    }, 5600);
  }

  function finishBettingRound(state: RomulusHandState): RomulusHandState {
    ensureGameplayState(state);
    const game = findGame(state.gameId);

    if (state.street === "river") {
      state.street = "showdown";
      state.gameplayStatus = "showdown";
      state.actingUserId = null;
      state.messages.push("Betting is complete. Showdown.");
      return state;
    }

    if (state.street === "showdown" || state.street === "complete") {
      state.actingUserId = null;
      return state;
    }

    const next = advanceCommunityStreet(state);
    ensureGameplayState(next);
    next.currentBetCents = 0;
    next.minRaiseCents = state.bigBlindCents ?? activeTable?.big_blind_cents ?? 500;
    next.streetContribByUserId = {};
    next.actedUserIds = [];
    next.gameplayStatus = "betting";

    if (game.family === "stud") {
      next.actingUserId = firstPostflopActor(next);
    } else {
      next.actingUserId = firstPostflopActor(next);
    }

    if (!next.actingUserId) {
      next.street = "showdown";
      next.gameplayStatus = "showdown";
      next.messages.push("Everyone is all-in. Showdown.");
    } else {
      const actor = next.players?.find((player) => player.userId === next.actingUserId);
      next.messages.push(`Action is on ${actor?.name ?? "next player"}.`);
    }
    return next;
  }

  async function autoResolveShowdown(state: RomulusHandState): Promise<boolean> {
    if (!activeTableId || !activeHand || state.resultApplied || (state.potCents ?? 0) <= 0) return false;

    const { data: latestHandRow, error: latestHandError } = await supabase
      .from("hands")
      .select("*")
      .eq("id", activeHand.id)
      .maybeSingle();
    if (latestHandError) {
      setNotice(`Could not verify hand before resolving: ${latestHandError.message}`);
      return false;
    }
    const latestHand = latestHandRow as Hand | null;
    if (latestHand?.summary?.resultApplied) return true;

    const workingState = deepCopyHandState(state);
    ensureGameplayState(workingState);

    // If everyone is all-in before the river, finish running out the board before scoring.
    const canAct = playersWhoCanAct(workingState);
    while (
      canAct.length <= 1 &&
      workingState.street !== "river" &&
      workingState.street !== "showdown" &&
      workingState.street !== "complete"
    ) {
      const advanced = advanceCommunityStreet(workingState);
      Object.assign(workingState, advanced);
    }
    if (workingState.street === "river") {
      workingState.street = "showdown";
      workingState.gameplayStatus = "showdown";
      workingState.actingUserId = null;
      workingState.messages.push("Runout complete. Showdown.");
    }

    const resolution = resolveShowdown(workingState);
    workingState.messages.push(...resolution.messages);

    if (!resolution.supported) {
      await updateActiveHand(workingState);
      setNotice(resolution.messages.join(" "));
      return false;
    }

    const { data: freshSeatsData, error: freshSeatsError } = await supabase
      .from("table_seats")
      .select("*, profiles(username, display_name)")
      .eq("table_id", activeTableId);
    if (freshSeatsError) {
      setNotice(`Could not load fresh stacks for payout: ${freshSeatsError.message}`);
      return false;
    }
    const freshSeats = (freshSeatsData ?? []) as Seat[];

    for (const [userId, payout] of Object.entries(resolution.payoutsByUserId)) {
      if (payout <= 0) continue;
      const seat = freshSeats.find((item) => item.user_id === userId);
      if (!seat) continue;
      const { error } = await supabase
        .from("table_seats")
        .update({ stack_cents: seat.stack_cents + payout })
        .eq("table_id", activeTableId)
        .eq("user_id", userId);
      if (error) {
        setNotice(`Could not pay showdown winner: ${error.message}`);
        return false;
      }
    }

    workingState.showdownResult = {
      payoutsByUserId: resolution.payoutsByUserId,
      highWinnerIds: resolution.highWinnerIds,
      lowWinnerIds: resolution.lowWinnerIds,
      messages: resolution.messages,
      winnerBanners: resolution.winnerBanners,
      primaryBanner: resolution.primaryBanner,
    };
    workingState.resultApplied = true;
    workingState.potCents = 0;
    workingState.street = "complete";
    workingState.gameplayStatus = "complete";
    workingState.actingUserId = null;
    workingState.messages.push("Showdown payouts applied automatically.");
    await updateActiveHand(
      workingState,
      activeTable?.require_result_approval ? "pending" : "approved",
    );
    if (activeTableId) await refreshTable(activeTableId);
    if (activeHand?.id) scheduleNextHand(activeHand.id);
    return true;
  }

  async function resolveAndSaveGameplayState(state: RomulusHandState) {
    ensureGameplayState(state);
    const remaining = activeGameplayPlayers(state);
    const canAct = playersWhoCanAct(state);

    if (remaining.length === 1) {
      const winner = remaining[0];
      const seat = seats.find((item) => item.user_id === winner.userId);
      const pot = state.potCents;
      state.potCents = 0;
      state.street = "complete";
      state.gameplayStatus = "complete";
      state.actingUserId = null;
      const uncontestedBanner = `${winner.name} WINS uncontested · ${centsToDollars(pot)}`;
      state.messages.push(uncontestedBanner);
      state.showdownResult = {
        payoutsByUserId: { [winner.userId]: pot },
        highWinnerIds: [winner.userId],
        lowWinnerIds: [],
        messages: [uncontestedBanner],
        primaryBanner: uncontestedBanner,
        winnerBanners: [
          {
            userId: winner.userId,
            name: winner.name,
            amountCents: pot,
            reason: "wins uncontested",
            kind: "uncontested",
          },
        ],
      };
      state.resultApplied = true;
      if (seat && pot > 0 && activeTableId) {
        await supabase
          .from("table_seats")
          .update({ stack_cents: seat.stack_cents + pot })
          .eq("table_id", activeTableId)
          .eq("user_id", winner.userId);
      }
      await updateActiveHand(state, activeTable?.require_result_approval ? "pending" : "approved");
      if (activeHand?.id) scheduleNextHand(activeHand.id);
      return;
    }

    if (canAct.length <= 1) {
      const resolved = await autoResolveShowdown(state);
      if (resolved) return;
      state = finishBettingRound(state);
      if (state.gameplayStatus === "showdown") {
        const resolvedAfterStreet = await autoResolveShowdown(state);
        if (resolvedAfterStreet) return;
      }
    } else if (bettingRoundComplete(state)) {
      state = finishBettingRound(state);
      if (state.gameplayStatus === "showdown") {
        const resolved = await autoResolveShowdown(state);
        if (resolved) return;
      }
    } else {
      const currentActor = state.players?.find((player) => player.userId === state.actingUserId);
      state.actingUserId = nextActingPlayer(state, currentActor?.seatNumber ?? state.dealerSeat ?? 1);
      const actor = state.players?.find((player) => player.userId === state.actingUserId);
      if (actor) state.messages.push(`Action is on ${actor.name}.`);
    }

    state.lastActionAt = new Date().toISOString();
    await updateActiveHand(state);
    if (activeTableId) await refreshTable(activeTableId);
  }

  async function performAction(
    action: "fold" | "check-call" | "raise",
    raiseToCents?: number,
  ) {
    if (!profile || !activeTableId || !activeTable || !activeHand) return;
    if (activeTable.paused) {
      setNotice("The table is paused.");
      return;
    }
    const state = deepCopyHandState(activeHand.summary);
    ensureGameplayState(state);

    if (state.gameplayStatus !== "betting" || state.actingUserId !== profile.id) {
      setNotice("It is not your turn yet.");
      return;
    }

    const seat = seats.find((item) => item.user_id === profile.id);
    const player = state.players?.find((item) => item.userId === profile.id);
    if (!seat || !player || player.folded || player.allIn) return;

    if (action === "fold") {
      player.folded = true;
      player.inHand = false;
      state.actedUserIds = [...new Set([...(state.actedUserIds ?? []), profile.id])];
      state.messages.push(`${player.name} folded.`);
      await resolveAndSaveGameplayState(state);
      return;
    }

    const posted = state.streetContribByUserId?.[profile.id] ?? 0;
    const currentBet = state.currentBetCents ?? 0;
    const callCents = Math.min(seat.stack_cents, Math.max(0, currentBet - posted));

    let targetStreetContribution = posted + callCents;
    let isRaise = false;

    if (action === "raise") {
      const game = findGame(state.gameId);
      const minTo = minRaiseToFor(state);
      const maxTo = maxRaiseToFor({ state, seat, betting: game.betting });
      targetStreetContribution = Math.min(
        maxTo,
        Math.max(minTo, raiseToCents ?? minTo),
      );
      if (targetStreetContribution <= currentBet) {
        targetStreetContribution = posted + callCents;
      } else {
        isRaise = true;
      }
    }

    const amountToPutIn = Math.min(
      seat.stack_cents,
      Math.max(0, targetStreetContribution - posted),
    );

    if (amountToPutIn > 0) {
      const { error } = await supabase
        .from("table_seats")
        .update({ stack_cents: Math.max(0, seat.stack_cents - amountToPutIn) })
        .eq("table_id", activeTableId)
        .eq("user_id", profile.id);
      if (error) {
        setNotice(error.message);
        return;
      }
    }

    state.potCents += amountToPutIn;
    state.postedCentsByUserId[profile.id] =
      (state.postedCentsByUserId[profile.id] ?? 0) + amountToPutIn;
    state.streetContribByUserId![profile.id] = posted + amountToPutIn;

    if (seat.stack_cents - amountToPutIn <= 0) {
      player.allIn = true;
      state.messages.push(`${player.name} is all-in.`);
    }

    if (isRaise) {
      const oldBet = state.currentBetCents ?? 0;
      state.currentBetCents = state.streetContribByUserId![profile.id];
      state.minRaiseCents = Math.max(
        state.bigBlindCents ?? activeTable.big_blind_cents,
        state.currentBetCents - oldBet,
      );
      state.actedUserIds = [profile.id];
      const wasOpeningBet = oldBet <= 0;
      state.messages.push(
        `${player.name} ${wasOpeningBet ? "bet" : "raised to"} ${centsToDollars(state.currentBetCents)}.`,
      );
    } else {
      state.actedUserIds = [...new Set([...(state.actedUserIds ?? []), profile.id])];
      if (callCents > 0) {
        state.messages.push(`${player.name} called ${centsToDollars(callCents)}.`);
      } else {
        state.messages.push(`${player.name} checked.`);
      }
    }

    await resolveAndSaveGameplayState(state);
  }

  async function advanceStreet() {
    if (!activeHand) return;
    const state = deepCopyHandState(activeHand.summary);
    const next = finishBettingRound(state);
    if (next.gameplayStatus === "showdown") {
      const resolved = await autoResolveShowdown(next);
      if (resolved) return;
    }
    await updateActiveHand(next);
  }

  async function addManualBet() {
    if (!profile || !activeTableId || !activeHand) return;
    const amount = dollarsToCents(manualBetDollars);
    if (amount <= 0) return;
    const seat = seats.find((s) => s.user_id === profile.id);
    if (!seat || seat.stack_cents < amount) {
      setNotice("Not enough chips in your stack.");
      return;
    }
    const state: RomulusHandState = JSON.parse(
      JSON.stringify(activeHand.summary),
    );
    state.potCents += amount;
    state.postedCentsByUserId[profile.id] =
      (state.postedCentsByUserId[profile.id] ?? 0) + amount;
    state.messages.push(
      `${profile.display_name} put ${centsToDollars(amount)} into the pot.`,
    );
    await supabase
      .from("table_seats")
      .update({ stack_cents: seat.stack_cents - amount })
      .eq("table_id", activeTableId)
      .eq("user_id", profile.id);
    await updateActiveHand(state);
  }

  async function markShowdown(choice: "show" | "muck") {
    if (!profile || !activeHand) return;
    const state: RomulusHandState & {
      showdownChoices?: Record<string, "show" | "muck">;
    } = JSON.parse(JSON.stringify(activeHand.summary));
    state.showdownChoices = state.showdownChoices ?? {};
    state.showdownChoices[profile.id] = choice;
    state.messages.push(`${profile.display_name} chose to ${choice}.`);
    await updateActiveHand(state);
  }

  async function awardPotTo(userId: string) {
    if (!profile?.is_admin || !activeHand || !activeTableId) return;
    const winner = seats.find((s) => s.user_id === userId);
    if (!winner) return;
    const pot = activeHand.summary.potCents;
    if (pot <= 0) return;
    const state: RomulusHandState = JSON.parse(
      JSON.stringify(activeHand.summary),
    );
    const winnerName = winner.profiles?.display_name ?? winner.profiles?.username ?? "Winner";
    const manualBanner = `${winnerName} WINS by admin award · ${centsToDollars(pot)}`;
    state.messages.push(manualBanner);
    state.showdownResult = {
      payoutsByUserId: { [userId]: pot },
      highWinnerIds: [userId],
      lowWinnerIds: [],
      messages: [manualBanner],
      primaryBanner: manualBanner,
      winnerBanners: [
        {
          userId,
          name: winnerName,
          amountCents: pot,
          reason: "wins by admin award",
          kind: "split",
        },
      ],
    };
    state.resultApplied = true;
    state.potCents = 0;
    state.street = "complete";
    state.gameplayStatus = "complete";
    state.actingUserId = null;
    state.approved = !activeTable?.require_result_approval;
    await supabase
      .from("table_seats")
      .update({ stack_cents: winner.stack_cents + pot })
      .eq("table_id", activeTableId)
      .eq("user_id", userId);
    await updateActiveHand(
      state,
      activeTable?.require_result_approval ? "pending" : "approved",
    );
    if (activeHand?.id) scheduleNextHand(activeHand.id);
  }

  async function approveResult() {
    if (!profile?.is_admin || !activeHand) return;
    const state: RomulusHandState = JSON.parse(
      JSON.stringify(activeHand.summary),
    );
    state.approved = true;
    state.messages.push("Result approved by admin.");
    await updateActiveHand(state, "approved");
  }

  async function startClock() {
    if (!activeTable) return;
    const seconds = activeTable.action_clock_seconds || 30;
    await updateTablePatch({
      action_deadline: new Date(Date.now() + seconds * 1000).toISOString(),
    });
  }

  const activeHand = hands[0] ?? null;
  const seatedPlayers = useMemo(
    () => seats.filter((seat) => seat.is_active),
    [seats],
  );
  const mySeat = profile
    ? seats.find((seat) => seat.user_id === profile.id)
    : null;
  const selectedGame = findGame(activeTable?.current_game_id || "nlh");
  const playableGames = GAME_CATALOG.filter((game) =>
    playableWith(game, seatedPlayers.length || 1),
  );
  const secondsLeft = useMemo(() => {
    if (!activeTable?.action_deadline) return null;
    return Math.max(
      0,
      Math.ceil(
        (new Date(activeTable.action_deadline).getTime() - clockTick) / 1000,
      ),
    );
  }, [activeTable?.action_deadline, clockTick]);


  const gameplayControls = useMemo(() => {
    if (!activeHand || !profile || !mySeat) {
      return {
        isMyTurn: false,
        actingName: "",
        canCheck: false,
        callCents: 0,
        minRaiseToCents: 0,
        maxRaiseToCents: 0,
        canRaise: false,
      };
    }
    const state = activeHand.summary;
    ensureGameplayState(state);
    const actor = state.players?.find((player) => player.userId === state.actingUserId);
    const callCents = callAmountFor(state, profile.id);
    const minRaiseToCents = minRaiseToFor(state);
    const maxRaiseToCents = maxRaiseToFor({
      state,
      seat: mySeat,
      betting: selectedGame.betting,
    });
    return {
      isMyTurn:
        state.gameplayStatus === "betting" &&
        state.actingUserId === profile.id &&
        !activeTable?.paused,
      actingName: actor?.name ?? "",
      canCheck: callCents === 0,
      callCents,
      minRaiseToCents,
      maxRaiseToCents,
      canRaise: maxRaiseToCents >= minRaiseToCents && mySeat.stack_cents > callCents,
    };
  }, [activeHand, profile?.id, mySeat?.stack_cents, selectedGame.betting, activeTable?.paused]);

  useEffect(() => {
    if (!profile?.is_admin || !activeHand) return;
    const state = activeHand.summary;
    const shouldResolve =
      !state.resultApplied &&
      (state.potCents ?? 0) > 0 &&
      (state.gameplayStatus === "showdown" || state.street === "showdown");
    if (!shouldResolve) return;
    const key = `${activeHand.id}:${state.potCents}:${state.street}:${state.messages.length}`;
    if (autoResolveKeyRef.current === key) return;
    autoResolveKeyRef.current = key;
    const timer = window.setTimeout(() => {
      autoResolveShowdown(deepCopyHandState(state));
    }, 650);
    return () => window.clearTimeout(timer);
  }, [
    profile?.is_admin,
    activeHand?.id,
    activeHand?.summary.gameplayStatus,
    activeHand?.summary.street,
    activeHand?.summary.potCents,
    activeHand?.summary.messages.length,
  ]);

  useEffect(() => {
    if (!activeHand?.summary.showdownResult?.winnerBanners?.length) return;
    const primaryBanner =
      activeHand.summary.showdownResult.primaryBanner ||
      activeHand.summary.showdownResult.messages?.slice(-1)?.[0] ||
      "Hand complete.";
    const nextAnnouncement: WinnerAnnouncement = {
      handId: activeHand.id,
      handNumber: activeHand.hand_number,
      primaryBanner,
      banners: activeHand.summary.showdownResult.winnerBanners,
    };
    setWinnerAnnouncement(nextAnnouncement);
    const timer = window.setTimeout(() => {
      setWinnerAnnouncement((current) =>
        current?.handId === activeHand.id ? null : current,
      );
    }, 8500);
    return () => window.clearTimeout(timer);
  }, [
    activeHand?.id,
    activeHand?.hand_number,
    activeHand?.summary.showdownResult?.primaryBanner,
    activeHand?.summary.showdownResult?.winnerBanners?.length,
  ]);

  useEffect(() => {
    if (!gameplayControls.canRaise) return;
    const current = dollarsToCents(manualBetDollars);
    if (
      current < gameplayControls.minRaiseToCents ||
      current > gameplayControls.maxRaiseToCents
    ) {
      setManualBetDollars(String(Math.round(gameplayControls.minRaiseToCents / 100)));
    }
  }, [
    gameplayControls.canRaise,
    gameplayControls.minRaiseToCents,
    gameplayControls.maxRaiseToCents,
    activeHand?.id,
    activeHand?.summary.actingUserId,
  ]);

  const settlementRows = useMemo(() => {
    const byUser = new Map<
      string,
      {
        userId: string;
        name: string;
        buyins: number;
        cashouts: number;
        stack: number;
      }
    >();
    for (const seat of seats) {
      byUser.set(seat.user_id, {
        userId: seat.user_id,
        name:
          seat.profiles?.display_name ?? seat.profiles?.username ?? "Player",
        buyins: 0,
        cashouts: 0,
        stack: seat.stack_cents,
      });
    }
    for (const entry of ledger) {
      const existing = byUser.get(entry.user_id) ?? {
        userId: entry.user_id,
        name:
          entry.profiles?.display_name ?? entry.profiles?.username ?? "Player",
        buyins: 0,
        cashouts: 0,
        stack: 0,
      };
      if (entry.type === "buyin") existing.buyins += entry.amount_cents;
      if (entry.type === "cashout") existing.cashouts += entry.amount_cents;
      byUser.set(entry.user_id, existing);
    }
    return [...byUser.values()].map((row) => ({
      ...row,
      netCents: row.cashouts + row.stack - row.buyins,
    }));
  }, [ledger, seats]);

  const optimizedPayments = useMemo(
    () =>
      optimizeSettlement(
        settlementRows.map((row) => ({
          userId: row.userId,
          name: row.name,
          netCents: row.netCents,
        })),
      ),
    [settlementRows],
  );

  if (!supabaseReady) {
    return (
      <main>
        <h1 className="logo">Romulus</h1>
        <div className="card">
          <h2>Missing Supabase settings</h2>
          <p>
            Add <code>NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
            <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> to{" "}
            <code>.env.local</code> and to Cloudflare Pages environment
            variables.
          </p>
        </div>
      </main>
    );
  }

  if (loading) {
    return (
      <main>
        <h1 className="logo">Romulus</h1>
        <p>Loading…</p>
      </main>
    );
  }

  if (!session) {
    return (
      <main>
        <div className="hero">
          <div>
            <h1 className="logo">Romulus</h1>
            <p className="muted">
              Private real-time dealer’s choice poker. Admin-created accounts
              only. No rake. No payments inside the app.
            </p>
          </div>
        </div>
        <section
          className="grid"
          style={{ gridTemplateColumns: "minmax(280px, 420px) 1fr" }}
        >
          <div className="card">
            <h2>Sign in</h2>
            <label>
              Username
              <input
                value={authUsername}
                onChange={(event) => setAuthUsername(event.target.value)}
                placeholder="ramy"
                autoCapitalize="none"
              />
            </label>
            <br />
            <label>
              Password
              <input
                type="password"
                value={authPassword}
                onChange={(event) => setAuthPassword(event.target.value)}
                placeholder="••••••••"
              />
            </label>
            <br />
            <button onClick={signIn} disabled={!authUsername || !authPassword}>
              Enter Romulus
            </button>
            {authError && <p className="muted">{authError}</p>}
            <p className="muted">
              For now, create users in Supabase Auth as{" "}
              <code>username@romulus.local</code>.
            </p>
          </div>
          <div className="card">
            <h2>What this version can test</h2>
            <p>
              Login, lobby, create/join table, buy-ins, seats, real-time chat,
              dealer’s choice game selection, deal private cards, multi-board
              streets, Get Fucked board removal, timer, manual pot movement,
              settlement optimizer.
            </p>
            <p className="muted">
              This v0.3 version adds 6-max gameplay flow. Automatic hand ranking,
              side pots, and advanced split-pot resolution come next.
            </p>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main>
      <div className="hero">
        <div>
          <h1 className="logo">Romulus</h1>
          <div className="row">
            <span className="pill">
              {profile?.display_name ?? session.user.email}
            </span>
            {profile?.is_admin && <span className="pill">Admin</span>}
            {activeTable && <span className="pill">{activeTable.name}</span>}
            {activeTable && (
              <span className="pill">
                Sync: {realtimeStatus}
                {lastSyncAt ? ` · ${new Date(lastSyncAt).toLocaleTimeString()}` : ""}
              </span>
            )}
          </div>
        </div>
        <button className="secondary" onClick={signOut}>
          Sign out
        </button>
      </div>

      {notice && (
        <div className="status row">
          <span>{notice}</span>
          <button className="secondary" onClick={() => setNotice("")}>
            Clear
          </button>
        </div>
      )}

      {!activeTableId ? (
        <section className="grid" style={{ gridTemplateColumns: "350px 1fr" }}>
          <div className="card">
            <h2>Create table</h2>
            <label>
              Table name
              <input
                value={newTableName}
                onChange={(event) => setNewTableName(event.target.value)}
              />
            </label>
            <br />
            <button onClick={createTable}>Create Table</button>
          </div>
          <div className="card">
            <h2>Open tables</h2>
            <div className="grid">
              {tables.map((table) => (
                <div key={table.id} className="card">
                  <div
                    className="row"
                    style={{ justifyContent: "space-between" }}
                  >
                    <div>
                      <h3>{table.name}</h3>
                      <p className="muted">
                        Blinds {centsToDollars(table.small_blind_cents)} /{" "}
                        {centsToDollars(table.big_blind_cents)} · Clock{" "}
                        {table.action_clock_seconds}s
                      </p>
                    </div>
                    <button onClick={() => setActiveTableId(table.id)}>
                      Open
                    </button>
                  </div>
                </div>
              ))}
              {!tables.length && (
                <p className="muted">
                  No tables yet. Create one to start testing.
                </p>
              )}
            </div>
          </div>
        </section>
      ) : (
        <section className="table-grid">
          <aside className="grid">
            <div className="card">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <h2>Table</h2>
                <button
                  className="secondary"
                  onClick={() => setActiveTableId("")}
                >
                  Lobby
                </button>
              </div>
              <p className="muted">{activeTable?.name}</p>
              <div className="row">
                <span className="pill">Game: {selectedGame.displayName}</span>
                <span className="pill">
                  Button: Seat {activeTable?.button_seat ?? 1}
                </span>
                <span className="pill">
                  Pot: {centsToDollars(activeHand?.summary.potCents ?? 0)}
                </span>
              </div>
              <hr />
              <button onClick={sitDown} disabled={Boolean(mySeat)}>
                Sit Down
              </button>
              {mySeat && (
                <button
                  className="secondary"
                  onClick={() => standUp(profile!.id)}
                >
                  Stand Up
                </button>
              )}
              <hr />
              <label>
                Buy in amount
                <input
                  value={buyInDollars}
                  onChange={(event) => setBuyInDollars(event.target.value)}
                />
              </label>
              <br />
              <button onClick={addBuyIn} disabled={!mySeat}>
                Buy In
              </button>
              <hr />
              <label>
                Cash out amount
                <input
                  value={cashOutDollars}
                  onChange={(event) => setCashOutDollars(event.target.value)}
                />
              </label>
              <br />
              <button
                className="secondary"
                onClick={cashOut}
                disabled={!mySeat}
              >
                Cash Out
              </button>
              <hr />
              <h3>Account</h3>
              <label>
                New password
                <input
                  type="password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  placeholder="At least 8 characters"
                />
              </label>
              <br />
              <button
                className="secondary"
                onClick={changePassword}
                disabled={newPassword.trim().length < 8}
              >
                Change Password
              </button>
              {passwordNotice && <p className="muted">{passwordNotice}</p>}
            </div>

            <div className="card">
              <h2>Dealer Choice</h2>
              <label>
                Choose game
                <select
                  value={selectedGame.id}
                  onChange={(event) => chooseGame(event.target.value)}
                >
                  {playableGames.map((game) => (
                    <option key={game.id} value={game.id}>
                      {game.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <br />
              <button className="secondary" onClick={chooseRandomGame}>
                Random Game
              </button>
              <hr />
              <label>
                Bomb pot amount
                <input
                  value={String(
                    Math.round(
                      (activeTable?.bomb_pot_cents ??
                        activeTable?.default_bomb_pot_cents ??
                        2500) / 100,
                    ),
                  )}
                  onChange={(event) =>
                    updateTablePatch({
                      bomb_pot_cents: dollarsToCents(event.target.value),
                    })
                  }
                />
              </label>
              <br />
              <label>
                Action clock seconds
                <input
                  value={String(activeTable?.action_clock_seconds ?? 30)}
                  onChange={(event) =>
                    updateTablePatch({
                      action_clock_seconds: Number(event.target.value) || 30,
                    })
                  }
                />
              </label>
              <br />
              <label>
                Dealer button seat
                <input
                  value={String(activeTable?.button_seat ?? 1)}
                  onChange={(event) =>
                    updateTablePatch({
                      button_seat: Number(event.target.value) || 1,
                    })
                  }
                />
              </label>
              <br />
              <button onClick={() => startHand()}>Start Hand</button>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={autoStartNextHand}
                  onChange={(event) => setAutoStartNextHand(event.target.checked)}
                />
                Auto-start next hand after payout
              </label>
              <hr />
              <h3>Table Look</h3>
              <label>
                Felt color
                <select
                  value={feltTheme}
                  onChange={(event) =>
                    setFeltTheme(event.target.value as typeof feltTheme)
                  }
                >
                  <option value="green">Classic green</option>
                  <option value="blue">Blue</option>
                  <option value="burgundy">Burgundy</option>
                  <option value="black">Black</option>
                </select>
              </label>
              <br />
              <label>
                Card backs
                <select
                  value={cardBackTheme}
                  onChange={(event) =>
                    setCardBackTheme(event.target.value as typeof cardBackTheme)
                  }
                >
                  <option value="red">Red</option>
                  <option value="blue">Blue</option>
                  <option value="black">Black</option>
                  <option value="gold">Gold</option>
                </select>
              </label>
              <br />
              <label>
                Deck style
                <select
                  value={deckMode}
                  onChange={(event) =>
                    setDeckMode(event.target.value as typeof deckMode)
                  }
                >
                  <option value="standard">Standard 2-color</option>
                  <option value="four-color">4-color suits</option>
                </select>
              </label>
              <br />
              <label>
                Room style
                <select
                  value={roomTheme}
                  onChange={(event) =>
                    setRoomTheme(event.target.value as typeof roomTheme)
                  }
                >
                  <option value="dark">Dark private room</option>
                  <option value="casino">Bright casino</option>
                  <option value="minimal">Minimal</option>
                </select>
              </label>
            </div>
          </aside>

          <section className="grid">
            <PokerRoom
              profile={profile}
              activeTable={activeTable}
              activeHand={activeHand}
              seats={seats}
              selectedGameName={selectedGame.displayName}
              secondsLeft={secondsLeft}
              cardBackTheme={cardBackTheme}
              feltTheme={feltTheme}
              roomTheme={roomTheme}
              deckMode={deckMode}
              manualBetDollars={manualBetDollars}
              setManualBetDollars={setManualBetDollars}
              gameplayControls={gameplayControls}
              onAdvanceStreet={advanceStreet}
              onResolveShowdown={() => {
                if (activeHand) autoResolveShowdown(deepCopyHandState(activeHand.summary));
              }}
              onStartClock={startClock}
              onPauseToggle={() =>
                updateTablePatch({ paused: !activeTable?.paused })
              }
              onFold={() => performAction("fold")}
              onCallOrCheck={() => performAction("check-call")}
              onRaise={(raiseToCents) => performAction("raise", raiseToCents)}
              onShow={() => markShowdown("show")}
              onMuck={() => markShowdown("muck")}
              onPostChips={addManualBet}
              onApproveResult={approveResult}
              onAwardPot={awardPotTo}
              onKick={standUp}
              winnerAnnouncement={winnerAnnouncement}
            />
          </section>

          <aside className="grid">
            <div className="card">
              <h2>Chat</h2>
              <div className="message-list">
                {messages.map((message) => (
                  <div className="message" key={message.id}>
                    <small>
                      {message.kind === "system"
                        ? "System"
                        : (message.profiles?.display_name ?? "Player")}{" "}
                      · {new Date(message.created_at).toLocaleTimeString()}
                    </small>
                    <div>{message.body}</div>
                  </div>
                ))}
              </div>
              <hr />
              <textarea
                rows={3}
                value={chatBody}
                onChange={(event) => setChatBody(event.target.value)}
                placeholder="Table chat…"
              />
              <br />
              <br />
              <button onClick={postChat}>Send</button>
            </div>

            <div className="card">
              <h2>Settlement</h2>
              <div className="grid">
                {settlementRows.map((row) => (
                  <div key={row.userId}>
                    <strong>{row.name}</strong>
                    <p className="muted">
                      Buy-ins {centsToDollars(row.buyins)} · Cash-outs{" "}
                      {centsToDollars(row.cashouts)} · Stack{" "}
                      {centsToDollars(row.stack)} · Net{" "}
                      {centsToDollars(row.netCents)}
                    </p>
                  </div>
                ))}
              </div>
              <hr />
              <h3>Optimized payments</h3>
              {optimizedPayments.length ? (
                optimizedPayments.map((payment, index) => (
                  <p key={`${payment.from}-${payment.to}-${index}`}>
                    {payment.from} pays {payment.to}{" "}
                    <strong>{centsToDollars(payment.amountCents)}</strong>
                  </p>
                ))
              ) : (
                <p className="muted">No payments needed yet.</p>
              )}
            </div>
          </aside>
        </section>
      )}
    </main>
  );
}

const SEAT_POSITIONS = [
  { x: 50, y: 88, label: "You" },
  { x: 83, y: 68, label: "Lower right" },
  { x: 78, y: 28, label: "Upper right" },
  { x: 50, y: 14, label: "Across" },
  { x: 22, y: 28, label: "Upper left" },
  { x: 17, y: 68, label: "Lower left" },
];

type DeckMode = "standard" | "four-color";
type CardBackTheme = "red" | "blue" | "black" | "gold";

type PokerRoomProps = {
  profile: Profile | null;
  activeTable: PokerTable | null;
  activeHand: Hand | null;
  seats: Seat[];
  selectedGameName: string;
  secondsLeft: number | null;
  cardBackTheme: CardBackTheme;
  feltTheme: "green" | "blue" | "burgundy" | "black";
  roomTheme: "dark" | "casino" | "minimal";
  deckMode: DeckMode;
  manualBetDollars: string;
  setManualBetDollars: (value: string) => void;
  gameplayControls: {
    isMyTurn: boolean;
    actingName: string;
    canCheck: boolean;
    callCents: number;
    minRaiseToCents: number;
    maxRaiseToCents: number;
    canRaise: boolean;
  };
  onAdvanceStreet: () => void;
  onResolveShowdown: () => void;
  onStartClock: () => void;
  onPauseToggle: () => void;
  onFold: () => void;
  onCallOrCheck: () => void;
  onRaise: (raiseToCents: number) => void;
  onShow: () => void;
  onMuck: () => void;
  onPostChips: () => void;
  onApproveResult: () => void;
  onAwardPot: (userId: string) => void;
  onKick: (userId: string) => void;
  winnerAnnouncement: WinnerAnnouncement | null;
};

function PokerRoom({
  profile,
  activeTable,
  activeHand,
  seats,
  selectedGameName,
  secondsLeft,
  cardBackTheme,
  feltTheme,
  roomTheme,
  deckMode,
  manualBetDollars,
  setManualBetDollars,
  gameplayControls,
  onAdvanceStreet,
  onResolveShowdown,
  onStartClock,
  onPauseToggle,
  onFold,
  onCallOrCheck,
  onRaise,
  onShow,
  onMuck,
  onPostChips,
  onApproveResult,
  onAwardPot,
  onKick,
  winnerAnnouncement,
}: PokerRoomProps) {
  const mySeat = profile
    ? seats.find((seat) => seat.user_id === profile.id)
    : null;
  const myHoleCards =
    activeHand?.summary.holeCardsByUserId?.[profile?.id ?? ""] ?? [];
  const potDollars = centsToDollars(activeHand?.summary.potCents ?? 0);
  const potAmountForButton = String(
    Math.max(
      5,
      Math.round(
        (activeHand?.summary.potCents ?? activeTable?.big_blind_cents ?? 500) /
          100,
      ),
    ),
  );
  const raiseTargetCents = Math.min(
    gameplayControls.maxRaiseToCents || 0,
    Math.max(
      gameplayControls.minRaiseToCents || 0,
      dollarsToCents(manualBetDollars || "0"),
    ),
  );
  const raiseTargetDollars = centsToDollars(raiseTargetCents);
  const tableClass = `poker-room room-${roomTheme} felt-${feltTheme}`;
  const pointerStart = useRef<{ x: number; y: number; time: number } | null>(null);
  const lastTapTime = useRef(0);

  function handleGestureStart(event: PointerEvent<HTMLElement>) {
    pointerStart.current = {
      x: event.clientX,
      y: event.clientY,
      time: Date.now(),
    };
  }

  function handleGestureEnd(event: PointerEvent<HTMLElement>) {
    const start = pointerStart.current;
    pointerStart.current = null;
    if (!start || !activeHand) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) > 75 && Math.abs(dx) > Math.abs(dy) * 1.15) {
      if (gameplayControls.isMyTurn) onFold();
      return;
    }
    const now = Date.now();
    if (now - lastTapTime.current < 320) {
      if (gameplayControls.isMyTurn && gameplayControls.canCheck) {
        onCallOrCheck();
      }
      lastTapTime.current = 0;
      return;
    }
    lastTapTime.current = now;
  }

  function handleTouchStart(event: TouchEvent<HTMLElement>) {
    if (gameplayControls.isMyTurn) event.preventDefault();
    const touch = event.touches[0];
    if (!touch) return;
    pointerStart.current = { x: touch.clientX, y: touch.clientY, time: Date.now() };
  }

  function handleTouchEnd(event: TouchEvent<HTMLElement>) {
    const touch = event.changedTouches[0];
    const start = pointerStart.current;
    pointerStart.current = null;
    if (!touch || !start || !activeHand) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dx) > 75 && Math.abs(dx) > Math.abs(dy) * 1.15) {
      event.preventDefault();
      if (gameplayControls.isMyTurn) onFold();
      return;
    }
    const now = Date.now();
    if (now - lastTapTime.current < 320) {
      event.preventDefault();
      if (gameplayControls.isMyTurn && gameplayControls.canCheck) {
        onCallOrCheck();
      }
      lastTapTime.current = 0;
      return;
    }
    lastTapTime.current = now;
  }

  function handleScreenDoubleClick() {
    if (gameplayControls.isMyTurn && gameplayControls.canCheck) {
      onCallOrCheck();
    }
  }

  function positionFor(seatNumber: number) {
    const baseSeat = mySeat?.seat_number ?? 1;
    const offset = (seatNumber - baseSeat + MAX_TABLE_SEATS) % MAX_TABLE_SEATS;
    return SEAT_POSITIONS[offset] ?? SEAT_POSITIONS[0];
  }

  return (
    <div className={tableClass} onDoubleClick={handleScreenDoubleClick}>
      <div className="room-topbar">
        <div>
          <div className="room-title">
            {activeTable?.name ?? "Romulus Table"}
          </div>
          <div className="room-subtitle">
            {selectedGameName} · Pot {potDollars}
            {gameplayControls.actingName ? ` · Action: ${gameplayControls.actingName}` : ""}
          </div>
        </div>
        <div className="row room-actions">
          <button className="secondary" onClick={onPauseToggle}>
            {activeTable?.paused ? "Resume" : "Pause"}
          </button>
          <button className="secondary" onClick={onStartClock}>
            Clock
          </button>
          {secondsLeft !== null && (
            <span className={`clock-chip ${secondsLeft <= 5 ? "urgent" : ""}`}>
              {secondsLeft}s
            </span>
          )}
        </div>
      </div>

      <div className="poker-stage">
        <div className="poker-table-surface">
          <div className="table-rail" />
          <div className="table-felt">
            <div className="table-logo">ROMULUS</div>
            <div className="pot-stack">
              <div className="chip-stack">
                <span />
                <span />
                <span />
              </div>
              <strong>{potDollars}</strong>
              <small>
                {activeHand
                  ? `Hand #${activeHand.hand_number} · ${activeHand.summary.street}`
                  : "No hand running"}
              </small>
            </div>

            {winnerAnnouncement && (
              <div className="winner-announcement" aria-live="polite">
                <div className="winner-kicker">Hand #{winnerAnnouncement.handNumber} result</div>
                <strong>{winnerAnnouncement.primaryBanner}</strong>
                {winnerAnnouncement.banners.length > 1 && (
                  <div className="winner-splits">
                    {winnerAnnouncement.banners.map((banner) => (
                      <span key={`${winnerAnnouncement.handId}-${banner.userId}-${banner.kind}`}>
                        {banner.name}: {centsToDollars(banner.amountCents)} · {banner.reason}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="community-zone">
              {activeHand ? (
                activeHand.summary.boards.map((board) => (
                  <div
                    className={`felt-board ${board.removed ? "removed" : ""}`}
                    key={board.id}
                  >
                    <div className="board-label">
                      {board.id}
                      {board.removed ? " · removed" : ""}
                    </div>
                    <CardRow cards={board.cards} deckMode={deckMode} />
                    {board.removedReason && (
                      <small className="muted">{board.removedReason}</small>
                    )}
                  </div>
                ))
              ) : (
                <div className="no-hand-card">
                  <strong>Choose a game and start a hand</strong>
                  <span>Cards, boards, pot, and action will live here.</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {Array.from({ length: MAX_TABLE_SEATS }, (_, index) => {
          const seatNumber = index + 1;
          const seat = seats.find(
            (candidate) => candidate.seat_number === seatNumber,
          );
          const position = positionFor(seatNumber);
          const isMe = Boolean(seat && profile && seat.user_id === profile.id);
          const holeCards =
            activeHand?.summary.holeCardsByUserId?.[seat?.user_id ?? ""] ?? [];
          const visibleCards =
            activeHand?.summary.visibleCardsByUserId?.[seat?.user_id ?? ""] ??
            [];
          const showdownChoice = (
            activeHand?.summary as RomulusHandState & {
              showdownChoices?: Record<string, string>;
            }
          )?.showdownChoices?.[seat?.user_id ?? ""];
          const canSeeHole = Boolean(
            seat &&
            profile &&
            (seat.user_id === profile.id || showdownChoice === "show"),
          );
          const currentBet =
            activeHand?.summary.postedCentsByUserId?.[seat?.user_id ?? ""] ?? 0;
          const isActing = Boolean(seat && activeHand?.summary.actingUserId === seat.user_id);
          return (
            <div
              className={`table-seat-pod ${isMe ? "is-me" : ""} ${isActing ? "is-acting" : ""} ${!seat ? "is-empty" : ""}`}
              key={seatNumber}
              style={{ left: `${position.x}%`, top: `${position.y}%` }}
              title={position.label}
            >
              {(activeHand?.summary.dealerSeat ?? activeTable?.button_seat) === seatNumber && (
                <span className="dealer-button">D</span>
              )}
              {seat ? (
                <>
                  <div className="avatar-ring">
                    {(
                      seat.profiles?.display_name ??
                      seat.profiles?.username ??
                      "?"
                    )
                      .slice(0, 1)
                      .toUpperCase()}
                  </div>
                  <div className="seat-name">
                    {isMe
                      ? "You"
                      : (seat.profiles?.display_name ??
                        seat.profiles?.username ??
                        "Player")}
                  </div>
                  <div className="seat-stack">
                    {centsToDollars(seat.stack_cents)}
                  </div>
                  {currentBet > 0 && (
                    <div className="seat-bet">
                      Bet {centsToDollars(currentBet)}
                    </div>
                  )}
                  {visibleCards.length > 0 && (
                    <CardRow
                      cards={visibleCards}
                      label="Up"
                      deckMode={deckMode}
                    />
                  )}
                  {holeCards.length > 0 && canSeeHole && (
                    <CardRow
                      cards={holeCards}
                      label={isMe ? undefined : "Shown"}
                      deckMode={deckMode}
                    />
                  )}
                  {holeCards.length > 0 && !canSeeHole && (
                    <CardBacks
                      count={Math.min(holeCards.length, 6)}
                      color={cardBackTheme}
                    />
                  )}
                  {showdownChoice && (
                    <span className="seat-choice">{showdownChoice}</span>
                  )}
                  {profile?.is_admin && profile.id !== seat.user_id && (
                    <button
                      className="mini danger"
                      onClick={() => onKick(seat.user_id)}
                    >
                      Kick
                    </button>
                  )}
                  {profile?.is_admin && activeHand?.summary.potCents ? (
                    <button
                      className="mini secondary"
                      onClick={() => onAwardPot(seat.user_id)}
                    >
                      Award
                    </button>
                  ) : null}
                </>
              ) : (
                <>
                  <div className="empty-seat-dot" />
                  <div className="seat-name">Seat {seatNumber}</div>
                  <div className="seat-stack">Open</div>
                </>
              )}
            </div>
          );
        })}
      </div>

      <div className="hero-action-tray iphone-action-tray">
        <div
          className="my-hand-panel gesture-zone"
          onPointerDown={handleGestureStart}
          onPointerMove={(event) => { if (gameplayControls.isMyTurn) event.preventDefault(); }}
          onPointerUp={handleGestureEnd}
          onTouchStart={handleTouchStart}
          onTouchMove={(event) => event.preventDefault()}
          onTouchEnd={handleTouchEnd}
        >
          <div>
            <small className="muted">
              Your hand · swipe cards left/right to fold · double tap to check
            </small>
            {myHoleCards.length ? (
              <CardRow cards={myHoleCards} deckMode={deckMode} hero />
            ) : (
              <div className="muted">No private cards yet.</div>
            )}
          </div>
          <div className="hand-tools compact-hand-tools">
            <button
              className="secondary"
              onClick={onShow}
              disabled={!activeHand}
            >
              Show
            </button>
            <button
              className="secondary"
              onClick={onMuck}
              disabled={!activeHand}
            >
              Muck
            </button>
          </div>
        </div>

        <div className="turn-action-panel">
          <div className={`turn-banner ${gameplayControls.isMyTurn ? "your-turn" : ""}`}>
            {gameplayControls.isMyTurn
              ? "Your action"
              : gameplayControls.actingName
                ? `Waiting on ${gameplayControls.actingName}`
                : activeHand
                  ? "Hand running"
                  : "Start a hand"}
          </div>
          <div className="two-button-actions">
            <button
              className="action-main call-button"
              onClick={onCallOrCheck}
              disabled={!gameplayControls.isMyTurn}
            >
              {gameplayControls.canCheck
                ? "Check"
                : `Call ${centsToDollars(gameplayControls.callCents)}`}
            </button>
            <button
              className="action-main raise-button"
              onClick={() => onRaise(raiseTargetCents)}
              disabled={!gameplayControls.isMyTurn || !gameplayControls.canRaise}
            >
              {activeHand?.summary.currentBetCents ? "Raise to" : "Bet"} {raiseTargetDollars}
            </button>
          </div>
          <div className="raise-slider-box">
            <div className="slider-label-row">
              <span>Min {centsToDollars(gameplayControls.minRaiseToCents)}</span>
              <span>Max {centsToDollars(gameplayControls.maxRaiseToCents)}</span>
            </div>
            <input
              type="range"
              min={gameplayControls.minRaiseToCents || 0}
              max={Math.max(
                gameplayControls.minRaiseToCents || 0,
                gameplayControls.maxRaiseToCents || 0,
              )}
              step={100}
              value={raiseTargetCents || 0}
              onChange={(event) =>
                setManualBetDollars(String(Math.round(Number(event.target.value) / 100)))
              }
              disabled={!gameplayControls.canRaise}
            />
            <div className="quick-bets portrait-quick-bets">
              <button
                className="mini secondary"
                onClick={() => setManualBetDollars(String(Math.round((activeTable?.big_blind_cents ?? 500) / 100)))}
              >
                BB
              </button>
              <button
                className="mini secondary"
                onClick={() => setManualBetDollars(potAmountForButton)}
              >
                Pot
              </button>
              <button
                className="mini danger ghost-fold"
                onClick={onFold}
                disabled={!gameplayControls.isMyTurn}
              >
                Fold
              </button>
              <button
                className="mini secondary"
                onClick={onAdvanceStreet}
                disabled={!activeHand || activeHand.summary.street === "complete"}
              >
                Deal
              </button>
              {profile?.is_admin && activeHand && activeHand.summary.potCents > 0 && (
                <button className="mini" onClick={onResolveShowdown}>
                  Resolve
                </button>
              )}
              {profile?.is_admin && activeTable?.require_result_approval && (
                <button className="mini" onClick={onApproveResult}>
                  Approve
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {activeHand && (
        <div className="hand-log-strip">
          {activeHand.summary.messages.slice(-4).map((message, index) => (
            <span key={`${message}-${index}`}>{message}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function CardBacks({ count, color }: { count: number; color: CardBackTheme }) {
  return (
    <div className="card-backs">
      {Array.from({ length: count }, (_, index) => (
        <span className={`card-back back-${color}`} key={index} />
      ))}
    </div>
  );
}

function CardRow({
  cards,
  label,
  deckMode = "standard",
  hero = false,
}: {
  cards: Card[];
  label?: string;
  deckMode?: DeckMode;
  hero?: boolean;
}) {
  if (!cards.length) return <p className="muted">No cards yet</p>;
  return (
    <div className={hero ? "hero-card-row" : undefined}>
      {label && <small className="muted">{label}</small>}
      <div>
        {cards.map((card, index) => (
          <span
            className={`card-face ${cardColor(card)} ${deckMode === "four-color" ? `suit-${card.suit}` : ""} ${hero ? "hero-card" : ""}`}
            key={`${card.rank}${card.suit}${index}`}
          >
            {formatCard(card)}
          </span>
        ))}
      </div>
    </div>
  );
}
