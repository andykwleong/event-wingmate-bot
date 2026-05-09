# Event Wingmate Telegram Bot

A Telegram-first MVP for attending events with less friction:

- Paste a Luma link or event text.
- Get extracted event details.
- Get public transport and car directions links.
- Get introvert-friendly talking points.
- Receive day-before, leave-time, and networking nudges.

## Setup

1. Create a Telegram bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Copy `.env.example` to `.env`.
3. Fill in `TELEGRAM_BOT_TOKEN` and `HOME_ADDRESS`.
4. Run:

```bash
npm start
```

## Deploy on Railway

Use Railway when you want the bot to stay online 24/7 instead of running from your laptop.

1. Push this project to GitHub.
2. In Railway, create a new project from the GitHub repo.
3. Add these variables in Railway:

```bash
TELEGRAM_BOT_TOKEN=your_botfather_token
HOME_ADDRESS=your usual starting address
DEFAULT_TIMEZONE=Asia/Singapore
ALLOWED_USER_ID=your_telegram_user_id
DATA_FILE=./data/events.json
SUPABASE_URL=your_supabase_project_url
SUPABASE_SERVICE_ROLE_KEY=your_supabase_secret_or_service_role_key
```

4. Set the start command to:

```bash
npm start
```

5. Open the Railway app URL. It should say:

```text
Event Wingmate bot is running.
```

If `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are present, the bot stores owners and events in Supabase. Without them, it falls back to local JSON storage for testing.

Past events are deleted automatically two days after they start.

## Locking the Bot

The bot is private by default after the first `/start`.

The first Telegram user who sends `/start` becomes the owner. Everyone else will see:

```text
Sorry, this bot is private.
```

You can see your Telegram user ID with `/settings`. If you prefer to lock it manually, put that ID into `ALLOWED_USER_ID` in `bot-settings.txt`.

## Commands

- `/start` - intro and setup help
- `/help` - command list
- `/events` - list saved events
- `/settings` - show current bot settings
- Send any event text or Luma link to save an event and get prep

## MVP Notes

This first version uses Telegram long polling and local JSON storage. Travel support generates Google Maps directions links for public transport and driving. A later production version should add:

- Luma page fetching and structured parsing
- Google Calendar integration
- Google Maps Directions API or Citymapper integration
- Persistent database
- Hosted webhook deployment
