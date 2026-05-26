# Romulus v0.2

Private real-time poker web app for invite-only dealer's choice cash games with no rake and no payment processing.

## What works in v0.2
- Supabase email/password auth using username-style login
- Lobby
- Create/open tables
- Sit/stand/kick players
- Buy-ins, cash-outs, stacks, and settlement optimizer
- Real-time chat and table messages
- Dealer's choice game selector and random game button
- Adjustable bomb-pot amount, button seat, and action clock
- Start hands and deal cards
- Multi-board PLO family layouts
- Get Fucked triple-board river removal using rank, then suit where clubs are lowest
- Stud and Stud Minnesota first-pass dealing shell
- Player show/muck choices
- Admin result approval and manual pot award

## What is still intentionally manual / next
- Full betting enforcement: call/raise/fold, side pots, all-in logic
- Pot-limit math
- Automatic hand ranking and hi/lo winner calculation
- Stud Minnesota player-selected discard/exposed/replacement card
- Server-side trusted dealing through an Edge Function or Worker

## Setup
1. `npm install`
2. Copy `.env.example` to `.env.local`
3. Fill in Supabase URL and anon key
4. Run `supabase/schema.sql` in Supabase SQL Editor
5. In Supabase Auth, create users manually with emails like `ramy@romulus.local`
6. Log into Romulus with username `ramy` and that password
7. Make yourself admin:
   ```sql
   update profiles set is_admin = true where username = 'ramy';
   ```
8. Local test: `npm run dev`
9. Cloudflare Pages build:
   - Build command: `npm run build`
   - Build output directory: `out`
   - Deploy command: leave blank

## Real-money note
This app includes no payment processor, no rake, no public signup, and no casino/house role. It is designed as a private game/ledger between friends.


## v0.2.4 Poker Room UI Pass

This build adds a real poker-room table view:

- Logged-in player is visually anchored at the bottom-center seat.
- Opponents rotate around the table relative to the current user.
- Oval felt table, rail, pot stack, board area, and seat pods.
- Visible hero hand/action tray with Fold, Call/Post, Pot, Raise, Show, Muck, Deal, and Approve controls.
- Theme controls for felt color, card back color, deck mode, and room style.
- Multi-board display inside the felt for Pastrami, CostaRica, and Get Fucked visual testing.

Important: the action tray is a visual/testing layer on top of the current manual pot system. Fully enforced betting flow, legal action calculation, automatic winners, and side pots are the next engine milestone.


## v0.3.1
- Adds explicit refresh after writes.
- Adds a 2.5-second sync fallback in case Supabase Realtime is not yet enabled.
- Adds SQL to enable Supabase Realtime publication for Romulus tables.

## v0.3.2
- Adds automatic showdown resolution for NLH, Omaha/PLO, PLO Hi/Lo, Pastrami, CostaRica-style high-across-board games, Get Fucked remaining-board high/low, and first-pass Stud high scoring.
- Applies showdown payouts to stacks automatically; admin approval can still be used as a review/status flag.
- Fixes poker wording: unopened action is Bet; only action over an existing bet is Raise.
- Improves iPhone gestures: card panel uses touch-action none so swiping the cards away can fold instead of scrolling the page.
- Enlarges the logged-in user's cards and community board cards; opponent cards are smaller.

Still next: side pots, full server-side trusted actions, Stud Minnesota replacement-card choice, and deeper split-pot edge cases.
