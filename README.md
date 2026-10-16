# Ledgerline

A single-user personal finance tracker for credit cards and a checking account:
record balances as they change, log payments, and see what the month ahead looks
like — including warnings when scheduled auto pays would overdraw checking.

Built with Next.js (App Router), Prisma on SQLite, Tailwind CSS, and Recharts.

## Features

- **Credit cards** — add any number of cards with credit limit, auto pay day,
  and an auto pay rule per card: statement (last month) balance, full balance,
  minimum payment, fixed amount, or none.
- **Balance tracking** — each card tracks *total balance* and *last month
  (statement) balance due this month*. Record a payment at any time; it updates
  the card and can optionally deduct from checking.
- **Checking account** — update the balance whenever it changes, with a reason
  ("Salary deposited", "Gift received", "Refund issued from insurance", …).
  Full history is kept for everything.
- **Predictions** — the net daily drift of your checking history projects the
  balance forward; upcoming auto pays are subtracted on the day they fire. You
  get: expected end-of-month checking balance, the lowest projected point,
  payoff headroom (what you could still pay this month while keeping a $500
  buffer), and warnings when an auto pay would overdraw the account.
- **Dashboard** — balance trend lines (90 days), a donut of debt distribution
  across cards, a monthly calendar marking balance updates, payments, payoff
  moments, and approaching auto pay dates, plus recent activity.

## Getting started (local)

```bash
cp .env.example .env        # then set APP_PASSWORD and SESSION_SECRET
npm install
npx prisma migrate dev      # creates prisma/data/app.db
npm run db:seed             # optional: ~3.5 months of demo data
npm run dev
```

Open http://localhost:3000 and sign in with `APP_PASSWORD`.

The seed is skipped automatically if the database already has data. To start
clean, delete `prisma/data/app.db` and rerun the migrate command.

## Running with Docker

```bash
cp .env.example .env        # set APP_PASSWORD and SESSION_SECRET
docker compose up --build
```

The container applies pending migrations on boot (`prisma migrate deploy`) and
stores the SQLite file in the `app-data` volume, so data survives rebuilds and
restarts. The image is a multi-stage build on `node:22-alpine` running Next.js
standalone output as a non-root user — ready for any container platform
(Cloud Run, ECS/Fargate, Fly.io, a VPS with compose, …). Configuration is
entirely env-driven: `DATABASE_URL`, `APP_PASSWORD`, `SESSION_SECRET`, `PORT`.

> For cloud deployment with SQLite, mount a persistent disk at `/app/data`.
> Platforms without persistent disks are the main reason to switch databases —
> see below.

## Switching databases

The app never talks to SQLite directly: all access goes through Prisma, money
is stored as integer cents, and no SQLite-specific column types or raw SQL are
used. Moving to Postgres (or MySQL) is three small steps:

1. In `prisma/schema.prisma`, change the datasource:
   ```prisma
   datasource db {
     provider = "postgresql"   // was "sqlite"
     url      = env("DATABASE_URL")
   }
   ```
2. Point `DATABASE_URL` at the new database, e.g.
   `postgresql://user:pass@host:5432/ledgerline`.
3. Recreate migrations for the new provider (Prisma migrations are
   provider-specific): delete `prisma/migrations/` and run
   `npx prisma migrate dev --name init`.

Nothing in `src/` changes. In Docker, the entrypoint's `migrate deploy` works
the same against the new URL; drop the volume mount if you no longer need the
local file.

## How predictions work

- **Drift**: `(latest checking balance − balance ~90 days ago) ÷ days` gives a
  net per-day figure that already averages salary, rent, and daily spending.
- **Projection**: walk forward 45 days, applying drift daily and subtracting
  each card's auto pay on its scheduled day (statement balance, full balance,
  minimum, or fixed — clamped to the card's outstanding total; auto pay days
  past a month's end are clamped to the last day).
- **Warnings**: an auto pay that leaves checking below $0 is flagged as an
  overdraft; below the $500 safety buffer as "tight". Both appear on the
  dashboard banner, the projection chart, and the calendar.
- **Payoff headroom**: the month's lowest projected balance minus the buffer —
  what you could safely pay toward cards beyond what's already scheduled.

Predictions only know what you record: the more regularly balances are
updated, the better the forecast.

## Project layout

```
prisma/schema.prisma   data model (SQLite now, portable by design)
prisma/seed.ts         deterministic demo data
src/lib/               db client, auth, server actions, queries,
                       prediction engine, calendar events, chart sampling
src/components/        charts, calendar, dialogs/forms, UI primitives
src/app/login          password sign-in
src/app/(app)/         dashboard, cards, card detail, checking
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | dev server |
| `npm run build` / `npm start` | production build / serve |
| `npm run db:migrate` | create/apply migrations in development |
| `npm run db:deploy` | apply committed migrations (production) |
| `npm run db:seed` | seed demo data (skips a non-empty database) |
