import { GAME_CATALOG } from '@/lib/game-engine/games';

export default function HomePage() {
  return (
    <main style={{ maxWidth: 1100, margin: '0 auto', padding: 24 }}>
      <h1>Romulus</h1>
      <p>Private real-time cash-game app scaffold. Admin-created accounts only. No rake. No payments.</p>
      <section className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
        <div className="card">
          <h2>Table Defaults</h2>
          <p>Default big blind: $5</p>
          <p>Default bomb pot: 5× big blind</p>
          <p>Max players: 9</p>
        </div>
        <div className="card">
          <h2>Admin Controls</h2>
          <p>Create users, kick players, approve hand results, view history and settlement reports.</p>
        </div>
        <div className="card">
          <h2>Real Time</h2>
          <p>Realtime table, chat, table messages, reconnect-safe game state, and adjustable action clocks.</p>
        </div>
      </section>
      <h2>Game Catalog</h2>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
        {GAME_CATALOG.map(game => (
          <div className="card" key={game.id}>
            <h3>{game.displayName}</h3>
            <p>{game.summary}</p>
            <small>{game.betting} · {game.lowRule ?? 'high only'}</small>
          </div>
        ))}
      </div>
    </main>
  );
}
