# Event Wingmate Telegram Bot

Event Wingmate is a private Telegram bot that helps you prepare for events, get there on time, and actually talk to people once you arrive.

Paste a Luma link or event text, and the bot can save the event, extract the details, look up hidden Luma locations from your Google Calendar, calculate travel time, and generate low-pressure conversation prompts.

## Features

- Save events from Luma links or plain event text
- Extract event name, date/time, location, summary, and prep prompts with OpenAI
- Look up exact event locations from Google Calendar when Luma hides guest-only addresses
- Calculate public transport and driving time with Google Maps Routes API
- Send full prep 24 hours before the event, a leave-time reminder, and a networking nudge
- Generate event-specific prep questions and vary wording so prompts do not feel repeated
- Deduplicate repeated event links so reminders are not duplicated, while refreshing saved events when better details are found later
- Delete one saved event, all duplicate copies of that event, or bulk-delete all saved events from Telegram
- Keep the bot private to one Telegram user

## How It Works

```text
Telegram
  -> Railway-hosted Node.js bot
  -> Luma / event page fetch
  -> OpenAI extraction
  -> Google Calendar location lookup
  -> Google Maps Routes API
  -> Supabase storage
  -> Telegram reply and reminders
```

## Telegram Commands

- `/start` - welcome message
- `/help` - command list
- `/settings` - configuration and connection status
- `/events` - list upcoming saved events
- `/event_details 1` - manually generate full prep and travel for event 1
- `/events_details 1` - alias for `/event_details 1`
- `/delete_event 1` - delete event 1, including saved duplicate copies, and stop its reminders
- `/delete_all_events` - ask for confirmation before deleting all saved events
- `/delete_all_events confirm` - delete all saved events for the current chat
- `/connect_calendar` - connect read-only Google Calendar access
- `/debug_calendar` - show calendar events visible to the bot near the latest saved event

## Requirements

- Node.js 20+
- Telegram bot token from [BotFather](https://t.me/BotFather)
- Supabase project
- OpenAI API key
- Google Maps Platform key with Routes API enabled
- Google Cloud OAuth client with Google Calendar API enabled
- Railway account for 24/7 hosting

The bot can run locally with fewer services, but the full hosted workflow expects all of the above.

## Environment Variables

Create a local `.env` file from `.env.example` for local testing, and set the same variables in Railway for deployment.

```bash
TELEGRAM_BOT_TOKEN=
HOME_ADDRESS=
DEFAULT_TIMEZONE=Asia/Singapore
ALLOWED_USER_ID=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.4-mini
GOOGLE_MAPS_API_KEY=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=
DATA_FILE=./data/events.json
```

Never commit real secrets. Keep them in Railway variables or your local `.env`.

## Local Setup

1. Clone the repo.
2. Create a Telegram bot with BotFather.
3. Copy `.env.example` to `.env`.
4. Fill in at least:

```bash
TELEGRAM_BOT_TOKEN=
HOME_ADDRESS=
DEFAULT_TIMEZONE=Asia/Singapore
```

5. Run the bot:

```bash
npm start
```

6. In Telegram, send:

```text
/start
```

Without Supabase, the bot falls back to local JSON storage for testing.

## Supabase Setup

Create these tables in Supabase:

```sql
create table if not exists bot_owners (
  id bigint primary key generated always as identity,
  telegram_user_id text not null unique,
  google_refresh_token text,
  google_email text,
  google_connected_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists events (
  id text primary key,
  telegram_chat_id bigint not null,
  telegram_user_id text not null,
  title text not null,
  url text,
  raw_text text,
  location text not null,
  event_type text not null,
  starts_at timestamptz not null,
  summary text,
  audience text,
  networking_at timestamptz,
  prep jsonb not null default '{}'::jsonb,
  travel jsonb not null default '{}'::jsonb,
  reminders jsonb not null default '{"dayBefore": false, "leaveTime": false, "networking": false}'::jsonb,
  created_at timestamptz not null default now(),
  delete_after timestamptz not null
);

create index if not exists events_starts_at_idx on events (starts_at);
create index if not exists events_delete_after_idx on events (delete_after);
create index if not exists events_telegram_user_id_idx on events (telegram_user_id);

alter table public.bot_owners enable row level security;
alter table public.events enable row level security;

revoke all on public.bot_owners from anon, authenticated;
revoke all on public.events from anon, authenticated;
```

RLS should stay enabled because these tables live in Supabase's public schema. This bot is backend-only and uses a Supabase secret/service-role key from Railway, so it does not need public `anon` or `authenticated` table policies.

Use a Supabase secret/service-role key only in a backend environment such as Railway. Do not expose it in client-side code.

## Google Calendar Setup

1. In Google Cloud, enable Google Calendar API.
2. Configure OAuth consent.
3. Create an OAuth client of type `Web application`.
4. Add this redirect URI:

```text
https://your-railway-domain/auth/google/callback
```

5. Set these Railway variables:

```bash
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=https://your-railway-domain/auth/google/callback
```

6. In Telegram, run:

```text
/connect_calendar
```

The bot requests read-only calendar access. This is used to find exact event addresses after you register for Luma events that hide the location from public visitors.

## Railway Deployment

1. Push this repo to GitHub.
2. Create a Railway project from the GitHub repo.
3. Set the start command:

```bash
npm start
```

4. Add all required environment variables in Railway.
5. Ensure the public networking port points to `3000`, or use Railway's injected `PORT`.
6. Open:

```text
https://your-railway-domain/health
```

It should return:

```json
{"ok":true,"service":"event-wingmate"}
```

## Event Timing Behavior

- If an event starts within 24 hours, the bot immediately returns full prep, travel, openers, and a tiny mission.
- If an event is more than 24 hours away, the bot sends a lighter saved confirmation with three prep ideas.
- Future-event prep ideas prefer event-specific questions over generic openers, and wording varies within event categories.
- The 24-hour reminder uses the full prep format: venue, Luma link, summary, transit, car, map link, three openers, and tiny mission.
- The 1-hour leave reminder uses Google Maps links without a fixed origin, so Maps opens from the user's current location.
- The networking reminder sends 30 minutes before an extracted networking time, or 30 minutes after event start when no networking time is known.
- Use `/event_details 1` to manually generate full prep and travel for any saved event.
- Google Maps route details are used only for the immediate outgoing message and are not stored in Supabase.
- The 24-hour reminder may calculate one public transport route and one driving route when `GOOGLE_MAPS_API_KEY` is enabled; the result is sent immediately and not persisted.

## Google Maps Billing Safety

- Set a hard Google Cloud quota or budget before enabling `GOOGLE_MAPS_API_KEY`.
- Keep `GOOGLE_MAPS_API_KEY` unset if you only want free Google Maps direction links without route duration estimates.
- The bot avoids traffic-aware driving routes to reduce the chance of triggering more expensive Routes API SKUs.
- Do not call Google Maps Routes API during general background polling; call it only while constructing a due, outgoing message.
- Do not store Google Maps route duration, distance, step summaries, or other route output in Supabase.

If an older version of the bot stored route output, clear it from Supabase:

```sql
update public.events
set travel = '{}'::jsonb;
```

## Duplicate And Deletion Behavior

- Luma events are deduplicated by their Luma slug.
- Plain text events are deduplicated by normalized title and start time.
- If you paste the same event again and the fresh lookup finds better details, such as a Google Calendar location or travel time, the saved event is updated.
- `/delete_event 1` deletes all saved copies with the same fingerprint, so old test duplicates do not keep triggering reminders.
- `/delete_all_events confirm` deletes every saved event for the current Telegram chat.
- Expired events are automatically removed about 24 hours after the event starts.

## Privacy And Security

- The bot is private by default after the first `/start`, or you can set `ALLOWED_USER_ID`.
- Event data and Google refresh tokens are stored in Supabase.
- API keys should live only in Railway variables or local `.env`.
- Do not commit `.env`, `bot-settings.txt`, or `data/`.
- Google Calendar access is read-only.

## Limitations

- Luma sometimes hides exact locations from public visitors. The bot can only see those addresses through Google Calendar after you register or accept the event.
- Travel estimates are based on Google Routes API and may differ from Google Maps when opened later because live conditions change.
- Plain text invites should include title, date/time, location, and description in one message.
- Image/screenshot invite parsing is not implemented.

## License

Copyright (C) 2026 Andy Leong.

This project is licensed under the GNU Affero General Public License v3.0 or later. See [LICENSE](LICENSE).
