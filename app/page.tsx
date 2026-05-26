'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { GAME_CATALOG, playableWith } from '@/lib/game-engine/games';
import type { Card } from '@/lib/game-engine/types';
import { advanceCommunityStreet, createInitialHandState, findGame, type RomulusHandState, type SeatForDeal } from '@/lib/game-engine/handState';
import { formatCard, cardColor } from '@/lib/game-engine/cards';
import { optimizeSettlement } from '@/lib/game-engine/settlement';
import { centsToDollars, dollarsToCents } from '@/lib/money';
import { supabase, supabaseReady } from '@/lib/supabaseClient';

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
  type: 'buyin' | 'cashout' | 'adjustment';
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
  result_status: 'pending' | 'approved' | 'rejected';
  summary: RomulusHandState;
  created_at: string;
};

type TableMessage = {
  id: string;
  table_id: string;
  user_id: string | null;
  kind: 'chat' | 'system';
  body: string;
  created_at: string;
  profiles?: { username: string; display_name: string } | null;
};

const EMPTY_TABLE_NAME = 'Friday Night Romulus';

function usernameToEmail(username: string) {
  const trimmed = username.trim().toLowerCase();
  if (trimmed.includes('@')) return trimmed;
  return `${trimmed}@romulus.local`;
}

export default function HomePage() {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [authUsername, setAuthUsername] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authError, setAuthError] = useState('');

  const [tables, setTables] = useState<PokerTable[]>([]);
  const [activeTableId, setActiveTableId] = useState<string>('');
  const [activeTable, setActiveTable] = useState<PokerTable | null>(null);
  const [seats, setSeats] = useState<Seat[]>([]);
  const [messages, setMessages] = useState<TableMessage[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [hands, setHands] = useState<Hand[]>([]);
  const [chatBody, setChatBody] = useState('');
  const [newTableName, setNewTableName] = useState(EMPTY_TABLE_NAME);
  const [buyInDollars, setBuyInDollars] = useState('500');
  const [cashOutDollars, setCashOutDollars] = useState('0');
  const [manualBetDollars, setManualBetDollars] = useState('25');
  const [clockTick, setClockTick] = useState(Date.now());
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session ?? null);
      setLoading(false);
    });
    const { data: authSub } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });
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
    loadProfile(session.user.id, session.user.email ?? '');
  }, [session?.user?.id]);

  useEffect(() => {
    if (!session) return;
    loadTables();
    const channel = supabase
      .channel('romulus-lobby')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tables' }, () => loadTables())
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
    const channel = supabase
      .channel(`romulus-table-${activeTableId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tables', filter: `id=eq.${activeTableId}` }, () => refreshTable(activeTableId))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'table_seats', filter: `table_id=eq.${activeTableId}` }, () => refreshTable(activeTableId))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'table_messages', filter: `table_id=eq.${activeTableId}` }, () => refreshTable(activeTableId))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ledger_entries', filter: `table_id=eq.${activeTableId}` }, () => refreshTable(activeTableId))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hands', filter: `table_id=eq.${activeTableId}` }, () => refreshTable(activeTableId))
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [activeTableId]);

  async function loadProfile(userId: string, email: string) {
    const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle();
    if (error) {
      console.error(error);
      setNotice(`Profile error: ${error.message}`);
      return;
    }
    if (data) {
      setProfile(data as Profile);
      return;
    }
    const username = email.split('@')[0] || 'player';
    const displayName = username.charAt(0).toUpperCase() + username.slice(1);
    const { data: created, error: createError } = await supabase
      .from('profiles')
      .insert({ id: userId, username, display_name: displayName, is_admin: false })
      .select('*')
      .single();
    if (createError) {
      console.error(createError);
      setNotice(`Could not create profile: ${createError.message}`);
      return;
    }
    setProfile(created as Profile);
  }

  async function signIn() {
    setAuthError('');
    const { error } = await supabase.auth.signInWithPassword({
      email: usernameToEmail(authUsername),
      password: authPassword,
    });
    if (error) setAuthError(error.message);
  }

  async function signOut() {
    await supabase.auth.signOut();
    setActiveTableId('');
  }

  async function loadTables() {
    const { data, error } = await supabase.from('tables').select('*').order('created_at', { ascending: false });
    if (error) {
      console.error(error);
      setNotice(`Table load error: ${error.message}`);
      return;
    }
    setTables((data ?? []) as PokerTable[]);
  }

  async function refreshTable(tableId: string) {
    const [tableRes, seatsRes, messagesRes, ledgerRes, handsRes] = await Promise.all([
      supabase.from('tables').select('*').eq('id', tableId).maybeSingle(),
      supabase.from('table_seats').select('*, profiles(username, display_name)').eq('table_id', tableId).order('seat_number'),
      supabase.from('table_messages').select('*, profiles(username, display_name)').eq('table_id', tableId).order('created_at', { ascending: true }).limit(80),
      supabase.from('ledger_entries').select('*, profiles(username, display_name)').eq('table_id', tableId).order('created_at', { ascending: true }),
      supabase.from('hands').select('*').eq('table_id', tableId).order('hand_number', { ascending: false }).limit(20),
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
  }

  async function createTable() {
    if (!profile) return;
    const { data, error } = await supabase
      .from('tables')
      .insert({
        name: newTableName || EMPTY_TABLE_NAME,
        created_by: profile.id,
        small_blind_cents: 250,
        big_blind_cents: 500,
        default_bomb_pot_cents: 2500,
        bomb_pot_cents: 2500,
        action_clock_seconds: 30,
        require_result_approval: true,
        current_game_id: 'nlh',
        button_seat: 1,
      })
      .select('*')
      .single();
    if (error) {
      setNotice(error.message);
      return;
    }
    setActiveTableId((data as PokerTable).id);
    await postSystemMessage((data as PokerTable).id, `${profile.display_name} created the table.`);
  }

  function nextOpenSeat() {
    const taken = new Set(seats.map((seat) => seat.seat_number));
    for (let i = 1; i <= 9; i++) if (!taken.has(i)) return i;
    return null;
  }

  async function sitDown() {
    if (!profile || !activeTableId) return;
    const existing = seats.find((seat) => seat.user_id === profile.id);
    if (existing) return;
    const seat = nextOpenSeat();
    if (!seat) {
      setNotice('This table is full.');
      return;
    }
    const { error } = await supabase.from('table_seats').insert({ table_id: activeTableId, user_id: profile.id, seat_number: seat, stack_cents: 0, is_active: true });
    if (error) setNotice(error.message);
    else await postSystemMessage(activeTableId, `${profile.display_name} sat in seat ${seat}.`);
  }

  async function standUp(userId: string) {
    if (!activeTableId || !profile) return;
    const target = seats.find((seat) => seat.user_id === userId);
    if (!target) return;
    if (profile.id !== userId && !profile.is_admin) return;
    const { error } = await supabase.from('table_seats').delete().eq('table_id', activeTableId).eq('user_id', userId);
    if (error) setNotice(error.message);
    else await postSystemMessage(activeTableId, `${target.profiles?.display_name ?? 'Player'} left the table.`);
  }

  async function addBuyIn() {
    if (!profile || !activeTableId) return;
    const amount = dollarsToCents(buyInDollars);
    if (amount <= 0) return;
    const seat = seats.find((s) => s.user_id === profile.id);
    if (!seat) {
      setNotice('Sit down before buying in.');
      return;
    }
    const { error: ledgerError } = await supabase.from('ledger_entries').insert({ table_id: activeTableId, user_id: profile.id, type: 'buyin', amount_cents: amount });
    if (ledgerError) {
      setNotice(ledgerError.message);
      return;
    }
    const { error } = await supabase.from('table_seats').update({ stack_cents: seat.stack_cents + amount }).eq('table_id', activeTableId).eq('user_id', profile.id);
    if (error) setNotice(error.message);
    else await postSystemMessage(activeTableId, `${profile.display_name} bought in for ${centsToDollars(amount)}.`);
  }

  async function cashOut() {
    if (!profile || !activeTableId) return;
    const amount = dollarsToCents(cashOutDollars);
    if (amount <= 0) return;
    const seat = seats.find((s) => s.user_id === profile.id);
    if (!seat || seat.stack_cents < amount) {
      setNotice('Cash-out amount is higher than your stack.');
      return;
    }
    const { error: ledgerError } = await supabase.from('ledger_entries').insert({ table_id: activeTableId, user_id: profile.id, type: 'cashout', amount_cents: amount });
    if (ledgerError) {
      setNotice(ledgerError.message);
      return;
    }
    const { error } = await supabase.from('table_seats').update({ stack_cents: seat.stack_cents - amount }).eq('table_id', activeTableId).eq('user_id', profile.id);
    if (error) setNotice(error.message);
    else await postSystemMessage(activeTableId, `${profile.display_name} cashed out ${centsToDollars(amount)}.`);
  }

  async function postChat() {
    if (!profile || !activeTableId || !chatBody.trim()) return;
    const body = chatBody.trim();
    setChatBody('');
    const { error } = await supabase.from('table_messages').insert({ table_id: activeTableId, user_id: profile.id, kind: 'chat', body });
    if (error) setNotice(error.message);
  }

  async function postSystemMessage(tableId: string, body: string) {
    if (!profile) return;
    await supabase.from('table_messages').insert({ table_id: tableId, user_id: profile.id, kind: 'system', body });
  }

  async function updateTablePatch(patch: Partial<PokerTable>) {
    if (!activeTableId) return;
    const { error } = await supabase.from('tables').update(patch).eq('id', activeTableId);
    if (error) setNotice(error.message);
  }

  async function chooseGame(gameId: string) {
    const game = findGame(gameId);
    await updateTablePatch({ current_game_id: game.id });
    if (activeTableId && profile) await postSystemMessage(activeTableId, `${profile.display_name} chose ${game.displayName}.`);
  }

  async function chooseRandomGame() {
    const playable = GAME_CATALOG.filter((game) => playableWith(game, seatedPlayers.length || 1));
    const game = playable[Math.floor(Math.random() * playable.length)] ?? GAME_CATALOG[0];
    await chooseGame(game.id);
  }

  async function startHand() {
    if (!activeTable || !activeTableId || !profile) return;
    const activeSeats = seats.filter((seat) => seat.is_active && seat.stack_cents > 0);
    if (activeSeats.length < 2) {
      setNotice('Need at least two players with chips to start a hand.');
      return;
    }
    const gameId = activeTable.current_game_id || 'nlh';
    const game = findGame(gameId);
    if (!playableWith(game, activeSeats.length)) {
      setNotice(`${game.displayName} does not have enough cards for ${activeSeats.length} players.`);
      return;
    }
    const handNumber = (hands[0]?.hand_number ?? 0) + 1;
    const bombPotCents = activeTable.bomb_pot_cents ?? activeTable.default_bomb_pot_cents;
    const state = createInitialHandState({ handNumber, gameId, seatedPlayers: activeSeats as SeatForDeal[], bombPotCents, requireApproval: activeTable.require_result_approval });

    if (game.isBombPotDefault) {
      for (const seat of activeSeats) {
        await supabase.from('table_seats').update({ stack_cents: Math.max(0, seat.stack_cents - bombPotCents) }).eq('table_id', activeTableId).eq('user_id', seat.user_id);
      }
    }

    const dealer = seats.find((seat) => seat.seat_number === activeTable.button_seat) ?? activeSeats[0];
    const { error } = await supabase.from('hands').insert({
      table_id: activeTableId,
      hand_number: handNumber,
      game_id: gameId,
      dealer_user_id: dealer?.user_id ?? null,
      result_status: 'pending',
      summary: state,
    });
    if (error) setNotice(error.message);
    else await postSystemMessage(activeTableId, `Hand #${handNumber} started: ${game.displayName}.`);
  }

  async function updateActiveHand(state: RomulusHandState, resultStatus?: Hand['result_status']) {
    const hand = activeHand;
    if (!hand) return;
    const update: Partial<Hand> = { summary: state };
    if (resultStatus) update.result_status = resultStatus;
    const { error } = await supabase.from('hands').update(update).eq('id', hand.id);
    if (error) setNotice(error.message);
  }

  async function advanceStreet() {
    if (!activeHand) return;
    await updateActiveHand(advanceCommunityStreet(activeHand.summary));
  }

  async function addManualBet() {
    if (!profile || !activeTableId || !activeHand) return;
    const amount = dollarsToCents(manualBetDollars);
    if (amount <= 0) return;
    const seat = seats.find((s) => s.user_id === profile.id);
    if (!seat || seat.stack_cents < amount) {
      setNotice('Not enough chips in your stack.');
      return;
    }
    const state: RomulusHandState = JSON.parse(JSON.stringify(activeHand.summary));
    state.potCents += amount;
    state.postedCentsByUserId[profile.id] = (state.postedCentsByUserId[profile.id] ?? 0) + amount;
    state.messages.push(`${profile.display_name} put ${centsToDollars(amount)} into the pot.`);
    await supabase.from('table_seats').update({ stack_cents: seat.stack_cents - amount }).eq('table_id', activeTableId).eq('user_id', profile.id);
    await updateActiveHand(state);
  }

  async function markShowdown(choice: 'show' | 'muck') {
    if (!profile || !activeHand) return;
    const state: RomulusHandState & { showdownChoices?: Record<string, 'show' | 'muck'> } = JSON.parse(JSON.stringify(activeHand.summary));
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
    const state: RomulusHandState = JSON.parse(JSON.stringify(activeHand.summary));
    state.messages.push(`Pot awarded to ${winner.profiles?.display_name ?? 'winner'}: ${centsToDollars(pot)}.`);
    state.potCents = 0;
    state.street = 'complete';
    state.approved = !activeTable?.require_result_approval;
    await supabase.from('table_seats').update({ stack_cents: winner.stack_cents + pot }).eq('table_id', activeTableId).eq('user_id', userId);
    await updateActiveHand(state, activeTable?.require_result_approval ? 'pending' : 'approved');
  }

  async function approveResult() {
    if (!profile?.is_admin || !activeHand) return;
    const state: RomulusHandState = JSON.parse(JSON.stringify(activeHand.summary));
    state.approved = true;
    state.messages.push('Result approved by admin.');
    await updateActiveHand(state, 'approved');
  }

  async function startClock() {
    if (!activeTable) return;
    const seconds = activeTable.action_clock_seconds || 30;
    await updateTablePatch({ action_deadline: new Date(Date.now() + seconds * 1000).toISOString() });
  }

  const activeHand = hands[0] ?? null;
  const seatedPlayers = useMemo(() => seats.filter((seat) => seat.is_active), [seats]);
  const mySeat = profile ? seats.find((seat) => seat.user_id === profile.id) : null;
  const selectedGame = findGame(activeTable?.current_game_id || 'nlh');
  const playableGames = GAME_CATALOG.filter((game) => playableWith(game, seatedPlayers.length || 1));
  const secondsLeft = useMemo(() => {
    if (!activeTable?.action_deadline) return null;
    return Math.max(0, Math.ceil((new Date(activeTable.action_deadline).getTime() - clockTick) / 1000));
  }, [activeTable?.action_deadline, clockTick]);

  const settlementRows = useMemo(() => {
    const byUser = new Map<string, { userId: string; name: string; buyins: number; cashouts: number; stack: number }>();
    for (const seat of seats) {
      byUser.set(seat.user_id, { userId: seat.user_id, name: seat.profiles?.display_name ?? seat.profiles?.username ?? 'Player', buyins: 0, cashouts: 0, stack: seat.stack_cents });
    }
    for (const entry of ledger) {
      const existing = byUser.get(entry.user_id) ?? { userId: entry.user_id, name: entry.profiles?.display_name ?? entry.profiles?.username ?? 'Player', buyins: 0, cashouts: 0, stack: 0 };
      if (entry.type === 'buyin') existing.buyins += entry.amount_cents;
      if (entry.type === 'cashout') existing.cashouts += entry.amount_cents;
      byUser.set(entry.user_id, existing);
    }
    return [...byUser.values()].map((row) => ({ ...row, netCents: row.cashouts + row.stack - row.buyins }));
  }, [ledger, seats]);

  const optimizedPayments = useMemo(() => optimizeSettlement(settlementRows.map((row) => ({ userId: row.userId, name: row.name, netCents: row.netCents }))), [settlementRows]);

  if (!supabaseReady) {
    return (
      <main>
        <h1 className="logo">Romulus</h1>
        <div className="card">
          <h2>Missing Supabase settings</h2>
          <p>Add <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> to <code>.env.local</code> and to Cloudflare Pages environment variables.</p>
        </div>
      </main>
    );
  }

  if (loading) {
    return <main><h1 className="logo">Romulus</h1><p>Loading…</p></main>;
  }

  if (!session) {
    return (
      <main>
        <div className="hero">
          <div>
            <h1 className="logo">Romulus</h1>
            <p className="muted">Private real-time dealer’s choice poker. Admin-created accounts only. No rake. No payments inside the app.</p>
          </div>
        </div>
        <section className="grid" style={{ gridTemplateColumns: 'minmax(280px, 420px) 1fr' }}>
          <div className="card">
            <h2>Sign in</h2>
            <label>Username<input value={authUsername} onChange={(event) => setAuthUsername(event.target.value)} placeholder="ramy" autoCapitalize="none" /></label>
            <br />
            <label>Password<input type="password" value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} placeholder="••••••••" /></label>
            <br />
            <button onClick={signIn} disabled={!authUsername || !authPassword}>Enter Romulus</button>
            {authError && <p className="muted">{authError}</p>}
            <p className="muted">For now, create users in Supabase Auth as <code>username@romulus.local</code>.</p>
          </div>
          <div className="card">
            <h2>What this version can test</h2>
            <p>Login, lobby, create/join table, buy-ins, seats, real-time chat, dealer’s choice game selection, deal private cards, multi-board streets, Get Fucked board removal, timer, manual pot movement, settlement optimizer.</p>
            <p className="muted">Hand ranking and fully enforced betting come next. This v0.2 version is for real-time table testing.</p>
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
            <span className="pill">{profile?.display_name ?? session.user.email}</span>
            {profile?.is_admin && <span className="pill">Admin</span>}
            {activeTable && <span className="pill">{activeTable.name}</span>}
          </div>
        </div>
        <button className="secondary" onClick={signOut}>Sign out</button>
      </div>

      {notice && <div className="status row"><span>{notice}</span><button className="secondary" onClick={() => setNotice('')}>Clear</button></div>}

      {!activeTableId ? (
        <section className="grid" style={{ gridTemplateColumns: '350px 1fr' }}>
          <div className="card">
            <h2>Create table</h2>
            <label>Table name<input value={newTableName} onChange={(event) => setNewTableName(event.target.value)} /></label>
            <br />
            <button onClick={createTable}>Create Table</button>
          </div>
          <div className="card">
            <h2>Open tables</h2>
            <div className="grid">
              {tables.map((table) => (
                <div key={table.id} className="card">
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <div>
                      <h3>{table.name}</h3>
                      <p className="muted">Blinds {centsToDollars(table.small_blind_cents)} / {centsToDollars(table.big_blind_cents)} · Clock {table.action_clock_seconds}s</p>
                    </div>
                    <button onClick={() => setActiveTableId(table.id)}>Open</button>
                  </div>
                </div>
              ))}
              {!tables.length && <p className="muted">No tables yet. Create one to start testing.</p>}
            </div>
          </div>
        </section>
      ) : (
        <section className="table-grid">
          <aside className="grid">
            <div className="card">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <h2>Table</h2>
                <button className="secondary" onClick={() => setActiveTableId('')}>Lobby</button>
              </div>
              <p className="muted">{activeTable?.name}</p>
              <div className="row">
                <span className="pill">Game: {selectedGame.displayName}</span>
                <span className="pill">Button: Seat {activeTable?.button_seat ?? 1}</span>
                <span className="pill">Pot: {centsToDollars(activeHand?.summary.potCents ?? 0)}</span>
              </div>
              <hr />
              <button onClick={sitDown} disabled={Boolean(mySeat)}>Sit Down</button>
              {mySeat && <button className="secondary" onClick={() => standUp(profile!.id)}>Stand Up</button>}
              <hr />
              <label>Buy in amount<input value={buyInDollars} onChange={(event) => setBuyInDollars(event.target.value)} /></label>
              <br />
              <button onClick={addBuyIn} disabled={!mySeat}>Buy In</button>
              <hr />
              <label>Cash out amount<input value={cashOutDollars} onChange={(event) => setCashOutDollars(event.target.value)} /></label>
              <br />
              <button className="secondary" onClick={cashOut} disabled={!mySeat}>Cash Out</button>
            </div>

            <div className="card">
              <h2>Dealer Choice</h2>
              <label>Choose game
                <select value={selectedGame.id} onChange={(event) => chooseGame(event.target.value)}>
                  {playableGames.map((game) => <option key={game.id} value={game.id}>{game.displayName}</option>)}
                </select>
              </label>
              <br />
              <button className="secondary" onClick={chooseRandomGame}>Random Game</button>
              <hr />
              <label>Bomb pot amount<input value={String(Math.round((activeTable?.bomb_pot_cents ?? activeTable?.default_bomb_pot_cents ?? 2500) / 100))} onChange={(event) => updateTablePatch({ bomb_pot_cents: dollarsToCents(event.target.value) })} /></label>
              <br />
              <label>Action clock seconds<input value={String(activeTable?.action_clock_seconds ?? 30)} onChange={(event) => updateTablePatch({ action_clock_seconds: Number(event.target.value) || 30 })} /></label>
              <br />
              <label>Dealer button seat<input value={String(activeTable?.button_seat ?? 1)} onChange={(event) => updateTablePatch({ button_seat: Number(event.target.value) || 1 })} /></label>
              <br />
              <button onClick={startHand}>Start Hand</button>
            </div>
          </aside>

          <section className="grid">
            <div className="card">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <h2>Seats</h2>
                <div className="row">
                  <button className="secondary" onClick={() => updateTablePatch({ paused: !activeTable?.paused })}>{activeTable?.paused ? 'Resume' : 'Pause'}</button>
                  <button onClick={startClock}>Start Clock</button>
                  {secondsLeft !== null && <span className="pill">Clock: {secondsLeft}s</span>}
                </div>
              </div>
              <div className="seat-grid">
                {Array.from({ length: 9 }, (_, index) => {
                  const seatNumber = index + 1;
                  const seat = seats.find((s) => s.seat_number === seatNumber);
                  const holeCards = activeHand?.summary.holeCardsByUserId?.[seat?.user_id ?? ''] ?? [];
                  const visibleCards = activeHand?.summary.visibleCardsByUserId?.[seat?.user_id ?? ''] ?? [];
                  const showdownChoice = (activeHand?.summary as RomulusHandState & { showdownChoices?: Record<string, string> })?.showdownChoices?.[seat?.user_id ?? ''];
                  const canSeeHole = Boolean(seat && profile && (seat.user_id === profile.id || showdownChoice === 'show'));
                  return (
                    <div className="card seat" key={seatNumber}>
                      {activeTable?.button_seat === seatNumber && <span className="dealer">D</span>}
                      <h3>Seat {seatNumber}</h3>
                      {seat ? (
                        <>
                          <strong>{seat.profiles?.display_name ?? seat.profiles?.username ?? 'Player'}</strong>
                          <p className="muted">Stack {centsToDollars(seat.stack_cents)}</p>
                          {visibleCards.length > 0 && <CardRow cards={visibleCards} label="Up" />}
                          {holeCards.length > 0 && canSeeHole && <CardRow cards={holeCards} label="Hole" />}
                          {holeCards.length > 0 && !canSeeHole && <p className="muted">Hole cards hidden</p>}
                          {showdownChoice && <span className="pill">{showdownChoice}</span>}
                          {profile?.is_admin && profile.id !== seat.user_id && <p><button className="danger" onClick={() => standUp(seat.user_id)}>Kick</button></p>}
                          {profile?.is_admin && activeHand?.summary.potCents ? <p><button className="secondary" onClick={() => awardPotTo(seat.user_id)}>Award Pot</button></p> : null}
                        </>
                      ) : <p className="muted">Open</p>}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="card">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div>
                  <h2>Current Hand</h2>
                  <p className="muted">{activeHand ? `#${activeHand.hand_number} · ${activeHand.summary.gameName} · ${activeHand.summary.street}` : 'No hand running yet.'}</p>
                </div>
                {activeHand && <span className="pill">Result: {activeHand.result_status}</span>}
              </div>
              {activeHand ? (
                <>
                  <div className="grid">
                    {activeHand.summary.boards.map((board) => (
                      <div className={`board ${board.removed ? 'removed' : ''}`} key={board.id}>
                        <h3>{board.id} {board.removed && '(removed)'}</h3>
                        <CardRow cards={board.cards} />
                        {board.removedReason && <p className="muted">{board.removedReason}</p>}
                      </div>
                    ))}
                  </div>
                  <hr />
                  <div className="row">
                    <button onClick={advanceStreet} disabled={activeHand.summary.street === 'complete'}>Deal / Advance</button>
                    <button className="secondary" onClick={() => markShowdown('show')}>Show</button>
                    <button className="secondary" onClick={() => markShowdown('muck')}>Muck</button>
                    {profile?.is_admin && activeTable?.require_result_approval && <button onClick={approveResult}>Approve Result</button>}
                  </div>
                  <hr />
                  <div className="row">
                    <label style={{ maxWidth: 180 }}>Put chips in pot<input value={manualBetDollars} onChange={(event) => setManualBetDollars(event.target.value)} /></label>
                    <button className="secondary" onClick={addManualBet}>Post Chips</button>
                  </div>
                  <h3>Hand log</h3>
                  <div className="message-list">
                    {activeHand.summary.messages.map((message, index) => <div className="message" key={`${message}-${index}`}>{message}</div>)}
                  </div>
                </>
              ) : <p className="muted">Choose a game and press Start Hand.</p>}
            </div>
          </section>

          <aside className="grid">
            <div className="card">
              <h2>Chat</h2>
              <div className="message-list">
                {messages.map((message) => (
                  <div className="message" key={message.id}>
                    <small>{message.kind === 'system' ? 'System' : message.profiles?.display_name ?? 'Player'} · {new Date(message.created_at).toLocaleTimeString()}</small>
                    <div>{message.body}</div>
                  </div>
                ))}
              </div>
              <hr />
              <textarea rows={3} value={chatBody} onChange={(event) => setChatBody(event.target.value)} placeholder="Table chat…" />
              <br /><br />
              <button onClick={postChat}>Send</button>
            </div>

            <div className="card">
              <h2>Settlement</h2>
              <div className="grid">
                {settlementRows.map((row) => (
                  <div key={row.userId}>
                    <strong>{row.name}</strong>
                    <p className="muted">Buy-ins {centsToDollars(row.buyins)} · Cash-outs {centsToDollars(row.cashouts)} · Stack {centsToDollars(row.stack)} · Net {centsToDollars(row.netCents)}</p>
                  </div>
                ))}
              </div>
              <hr />
              <h3>Optimized payments</h3>
              {optimizedPayments.length ? optimizedPayments.map((payment, index) => (
                <p key={`${payment.from}-${payment.to}-${index}`}>{payment.from} pays {payment.to} <strong>{centsToDollars(payment.amountCents)}</strong></p>
              )) : <p className="muted">No payments needed yet.</p>}
            </div>
          </aside>
        </section>
      )}
    </main>
  );
}

function CardRow({ cards, label }: { cards: Card[]; label?: string }) {
  if (!cards.length) return <p className="muted">No cards yet</p>;
  return (
    <div>
      {label && <small className="muted">{label}</small>}
      <div>
        {cards.map((card, index) => (
          <span className={`card-face ${cardColor(card)}`} key={`${card.rank}${card.suit}${index}`}>{formatCard(card)}</span>
        ))}
      </div>
    </div>
  );
}
