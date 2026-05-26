# Romulus MVP

Private real-time poker web app scaffold for invite-only cash games with no rake and no payment processing.

## Stack
- Next.js app router
- Supabase Auth, Postgres, Realtime
- PWA-ready structure
- TypeScript rules engine kept separate from UI

## First-run setup
1. `npm install`
2. Copy `.env.example` to `.env.local`
3. Create Supabase project
4. Run `supabase/schema.sql` in Supabase SQL editor
5. Add env vars
6. `npm run dev`

## Game philosophy
Server-trusted dealing and scoring. App auto-determines winners, with optional host/admin approval before pots are awarded.

## Real-money note
This app intentionally includes no payment processor, no rake, no public signup, and no casino/house role. It is designed as a private ledger and game platform for friends.
