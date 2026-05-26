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

## Cloudflare Pages install note
This package intentionally does not include package-lock.json. The app should install from the public npm registry during Cloudflare Pages builds.
Recommended Pages build command:

npm install --no-audit --no-fund --legacy-peer-deps --registry=https://registry.npmjs.org && npm run build

Recommended output directory: out
Recommended environment variables:
NODE_VERSION=20.19.0
SKIP_DEPENDENCY_INSTALL=true
