# Event Wingmate Bot Handoff

## Project

Event Wingmate is a private Telegram bot for event attendance prep.

The bot accepts a Luma link or event text, extracts event details, checks Google Calendar for exact event locations when Luma hides them, calculates travel time, stores the event, and sends reminders.

## Repo

- GitHub: `https://github.com/andykwleong/event-wingmate-bot`
- Main file: `src/bot.js`
- Runtime: Node.js, no external npm dependencies currently
- Start command: `npm start`
- Syntax check: `npm run check`
- License: AGPL-3.0-or-later

## Hosting And Services

- Telegram: bot UI
- Railway: 24/7 Node.js host
- Supabase: event storage, owner data, Google Calendar refresh token
- OpenAI API: event extraction, summary, conversation openers, mission
- Google Maps Routes API: public transport and driving travel time
- Google Calendar API: read-only lookup for exact locations on accepted calendar events

## Important Railway Variables

Do not commit real values.

- `TELEGRAM_BOT_TOKEN`
- `HOME_ADDRESS`
- `DEFAULT_TIMEZONE`
- `ALLOWED_USER_ID`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `GOOGLE_MAPS_API_KEY`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`

`GOOGLE_REDIRECT_URI` should look like:

```text
https://event-wingmate-bot-production.up.railway.app/auth/google/callback
```

## Telegram Commands

- `/start` - welcome
- `/help` - command list
- `/settings` - show config status, including Google Calendar connection
- `/events` - list upcoming saved events with date/time and location status
- `/event_details 1` - manually generate full prep and travel for a saved event
- `/events_details 1` - alias for `/event_details 1`
- `/delete_event 1` - delete a saved event by number
- `/delete_all_events` - ask for confirmation before deleting all saved events for the chat
- `/delete_all_events confirm` - delete all saved events for the chat and stop their reminders
- `/connect_calendar` - start Google Calendar OAuth
- `/debug_calendar` - show calendar events visible near the latest saved event time

## Current Behavior

- Luma links are supported.
- Plain text event details are supported if title, date/time, location, and description are in one message.
- If an event starts within 24 hours, the bot immediately replies with full prep, travel, openers, and tiny mission.
- If an event is more than 24 hours away, the bot sends a lighter saved confirmation with three prep suggestions.
- Future-event prep suggestions should prefer event-specific questions over generic openers like "What brought you here?" and should vary wording within event categories.
- `/event_details [number]` can manually generate full prep and travel for any saved event.
- If Luma hides the exact location, the bot checks Google Calendar for a matching accepted event.
- If Google Calendar has the location, that location overrides the hidden Luma status.
- If no exact location is available, the bot says: `Location has yet to be updated`.
- Google Maps routing only runs when a specific location is available.
- Duplicate Luma links are deduped by Luma slug.
- When a duplicate event is pasted, fresh extraction/calendar/travel data should update the saved event if it fills missing details.
- Plain text events are deduped by normalized title and start time.
- Deleting an event removes all saved copies with the same event fingerprint from Supabase, so future reminders stop.
- Bulk deletion removes all events for the current Telegram chat after explicit confirmation.
- Events are deleted automatically from Supabase two days after the event start.
- Day-before reminders are scheduled 24 hours before event start and should include the full prep format: venue, summary, transit, car, map link, three openers, and tiny mission.
- Leave-time reminders are scheduled 1 hour before event start.
- Networking reminders are scheduled 30 minutes after event start unless a networking time is extracted.

## Reply Format

The event reply is intentionally compact:

```text
Saved: ...
When: ...
Where: ...

Event Summary:
...
Link: ...

Getting there:
Public transport: ...
Route: ...
Car: ...
Open in Maps: Here

Easy openers:
- ...

- ...

- ...

Tiny mission:
...
```

The Maps URL is sent as a Telegram HTML hyperlink:

```html
Open in Maps: <a href="...">Here</a>
```

## Notes For Future Work

- Keep secrets in Railway variables only.
- Keep `bot-settings.txt`, `.env`, and `data/` ignored.
- Keep `README.md`, `SECURITY.md`, `LICENSE`, and `AGENTS.md` current before making the repo public.
- Run `npm run check` before committing.
- Push to GitHub to trigger Railway redeploy.
- If Google Calendar location lookup fails, use `/debug_calendar` first before changing matching logic.
- Current matching searches all visible Google calendars, then matches by time, title, title word overlap, or Luma URL slug.
- The OpenAI prompt is tuned to make openers sound casual and introvert-friendly; avoid making it stiff or salesy.
