import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";

const env = loadEnv();

const config = {
  token: env.TELEGRAM_BOT_TOKEN,
  homeAddress: env.HOME_ADDRESS || "Singapore",
  timezone: env.DEFAULT_TIMEZONE || "Asia/Singapore",
  allowedUserId: env.ALLOWED_USER_ID || "",
  dataFile: env.DATA_FILE || "./data/events.json",
  supabaseUrl: env.SUPABASE_URL || "",
  supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY || "",
  openaiApiKey: env.OPENAI_API_KEY || "",
  openaiModel: env.OPENAI_MODEL || "gpt-5.4-mini",
  googleMapsApiKey: env.GOOGLE_MAPS_API_KEY || "",
  googleClientId: env.GOOGLE_CLIENT_ID || "",
  googleClientSecret: env.GOOGLE_CLIENT_SECRET || "",
  googleRedirectUri: env.GOOGLE_REDIRECT_URI || "",
  port: Number(env.PORT || 3000)
};

if (!config.token) {
  console.error("Missing TELEGRAM_BOT_TOKEN. Copy .env.example to .env and add your BotFather token.");
  process.exit(1);
}

const apiBase = `https://api.telegram.org/bot${config.token}`;
const useSupabase = Boolean(config.supabaseUrl && config.supabaseServiceRoleKey);
let lastUpdateId = 0;
const sentReminderKeys = new Set();

await initializeStorage();
startHealthServer();
scheduleReminderLoop();
console.log(`Event Wingmate bot is running with ${useSupabase ? "Supabase" : "local file"} storage.`);
await pollForever();

function loadEnv() {
  const parsed = { ...process.env };
  readSettingsFileInto(parsed, "bot-settings.txt");
  readSettingsFileInto(parsed, ".env");
  return parsed;
}

function createHttpHandler() {
  return async (request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

    if (url.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, service: "event-wingmate" }));
      return;
    }

    if (url.pathname === "/auth/google") {
      await handleGoogleAuthStart(url, response);
      return;
    }

    if (url.pathname === "/auth/google/callback") {
      await handleGoogleAuthCallback(url, response);
      return;
    }

    response.writeHead(200, { "content-type": "text/plain" });
    response.end("Event Wingmate bot is running.\n");
  };
}

function startHealthServer() {
  const handler = createHttpHandler();
  const ports = [...new Set([config.port, 3000].filter(Boolean))];

  for (const port of ports) {
    const server = http.createServer(handler);
    server.on("error", (error) => {
      console.error(`Health server failed on port ${port}:`, error.message);
    });
    server.listen(port, () => {
      console.log(`Health server listening on port ${port}.`);
    });
  }
}

function readSettingsFileInto(target, filePath) {
  try {
    const raw = readFileSync(filePath, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const equalsIndex = trimmed.indexOf("=");
      if (equalsIndex === -1) continue;
      const key = trimmed.slice(0, equalsIndex).trim();
      const value = trimmed.slice(equalsIndex + 1).trim();
      target[key] = value.replace(/^["']|["']$/g, "");
    }
  } catch {
    // Settings files are optional. Real environment variables work too.
  }
}

async function handleGoogleAuthStart(url, response) {
  if (!isGoogleCalendarConfigured()) {
    sendTextResponse(response, 500, "Google Calendar is not configured in Railway yet.");
    return;
  }

  const userId = url.searchParams.get("user_id");
  if (!userId || !(await isAllowedUser(userId, "/connect_calendar"))) {
    sendTextResponse(response, 403, "This calendar connection link is not valid for this bot.");
    return;
  }

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", config.googleClientId);
  authUrl.searchParams.set("redirect_uri", config.googleRedirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/userinfo.email");
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", userId);

  response.writeHead(302, { location: authUrl.toString() });
  response.end();
}

async function handleGoogleAuthCallback(url, response) {
  const code = url.searchParams.get("code");
  const userId = url.searchParams.get("state");
  if (!code || !userId) {
    sendTextResponse(response, 400, "Missing Google authorization code.");
    return;
  }

  try {
    const tokens = await exchangeGoogleCode(code);
    if (!tokens.refresh_token) {
      sendTextResponse(response, 400, "Google did not return a refresh token. Try /connect_calendar again.");
      return;
    }

    const email = await fetchGoogleEmail(tokens.access_token);
    await saveGoogleConnection(userId, tokens.refresh_token, email);
    sendTextResponse(response, 200, "Google Calendar connected. You can close this tab and return to Telegram.");
  } catch (error) {
    console.error("Google auth callback failed:", error.message);
    sendTextResponse(response, 500, "Google Calendar connection failed. Check Railway logs.");
  }
}

function sendTextResponse(response, status, body) {
  response.writeHead(status, { "content-type": "text/plain" });
  response.end(`${body}\n`);
}

function isGoogleCalendarConfigured() {
  return Boolean(config.googleClientId && config.googleClientSecret && config.googleRedirectUri);
}

async function pollForever() {
  while (true) {
    try {
      const updates = await telegram("getUpdates", {
        offset: lastUpdateId + 1,
        timeout: 30,
        allowed_updates: ["message"]
      });

      for (const update of updates.result || []) {
        lastUpdateId = update.update_id;
        if (update.message) await handleMessage(update.message);
      }
    } catch (error) {
      console.error("Polling failed:", error.message);
      await sleep(3000);
    }
  }
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const userId = String(message.from?.id || "");
  const text = (message.text || "").trim();

  if (!(await isAllowedUser(userId, text))) {
    await sendMessage(chatId, "Sorry, this bot is private.");
    return;
  }

  if (!text) {
    await sendMessage(chatId, "Send me a Luma link or paste event details, and I will prep you for it.");
    return;
  }

  if (text === "/start") {
    await sendMessage(chatId, welcomeMessage());
    return;
  }

  if (text === "/help") {
    await sendMessage(chatId, helpMessage());
    return;
  }

  if (text === "/connect_calendar") {
    await sendMessage(chatId, calendarConnectMessage(userId));
    return;
  }

  if (text === "/settings") {
    await sendMessage(chatId, await settingsMessage(userId));
    return;
  }

  if (text === "/events") {
    await sendMessage(chatId, await eventsMessage(chatId));
    return;
  }

  const enrichedText = await enrichTextWithLinkedPage(text);
  const event = parseEvent(enrichedText, chatId, userId);
  event.rawText = text;
  event.sourceText = enrichedText;
  await enrichEventWithOpenAI(event);
  await enrichEventWithCalendar(event);
  await enrichEventWithTravel(event);
  await saveEvent(event);

  await sendMessage(chatId, eventPrepMessage(event), {
    disable_web_page_preview: true
  });
}

async function isAllowedUser(userId, text) {
  if (!userId) return false;
  if (config.allowedUserId) return userId === config.allowedUserId;

  const savedOwnerId = await readOwnerId();
  if (savedOwnerId) return userId === savedOwnerId;

  if (text === "/start" || text === "/claim") {
    await writeOwnerId(userId);
    return true;
  }

  return false;
}

function parseEvent(text, chatId, userId) {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const lumaUrl = text.match(/https?:\/\/(?:lu\.ma|luma\.com)\/\S+/i)?.[0];
  const url = lumaUrl || text.match(/https?:\/\/\S+/i)?.[0] || "";
  const date = extractDate(text);
  const location = extractLocation(lines, text);
  const title = extractTitle(lines, url);
  const eventType = inferEventType(text);
  const startsAt = date || nextLikelyEventTime();

  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    chatId,
    userId,
    title,
    url,
    rawText: text,
    sourceText: text,
    location,
    eventType,
    startsAt,
    summary: "",
    audience: "",
    networkingAt: null,
    prep: null,
    travel: null,
    deleteAfter: deleteAfterFor(startsAt),
    createdAt: new Date().toISOString(),
    reminders: {
      dayBefore: false,
      leaveTime: false,
      networking: false
    }
  };
}

async function enrichEventWithTravel(event) {
  if (!config.googleMapsApiKey) return;
  if (!shouldRouteToEventLocation(event)) return;

  const departureTime = recommendedDepartureDate(event.startsAt);
  const travel = {};

  try {
    travel.transit = await computeRoute({
      origin: config.homeAddress,
      destination: event.location,
      mode: "TRANSIT",
      departureTime
    });
  } catch (error) {
    console.error("Transit route failed:", error.message);
  }

  try {
    travel.driving = await computeRoute({
      origin: config.homeAddress,
      destination: event.location,
      mode: "DRIVE",
      departureTime
    });
  } catch (error) {
    console.error("Driving route failed:", error.message);
  }

  if (travel.transit || travel.driving) event.travel = travel;
}

function recommendedDepartureDate(startsAt) {
  const start = new Date(startsAt);
  const departure = new Date(start.getTime() - 60 * 60 * 1000);
  return departure > new Date() ? departure : new Date(Date.now() + 10 * 60 * 1000);
}

async function computeRoute({ origin, destination, mode, departureTime }) {
  const response = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": config.googleMapsApiKey,
      "x-goog-fieldmask": "routes.duration,routes.distanceMeters,routes.legs.steps.transitDetails,routes.legs.steps.navigationInstruction,routes.legs.steps.localizedValues"
    },
    body: JSON.stringify({
      origin: { address: origin },
      destination: { address: destination },
      travelMode: mode,
      routingPreference: mode === "DRIVE" ? "TRAFFIC_AWARE" : undefined,
      departureTime: departureTime.toISOString(),
      computeAlternativeRoutes: false,
      languageCode: "en",
      units: "METRIC"
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Google Routes request failed: ${response.status} ${body}`);
  }

  const data = await response.json();
  const route = data.routes?.[0];
  if (!route) throw new Error("Google Routes returned no route.");

  return {
    durationSeconds: parseDurationSeconds(route.duration),
    distanceMeters: route.distanceMeters || null,
    summary: summarizeRoute(route, mode)
  };
}

function parseDurationSeconds(duration) {
  if (!duration) return null;
  const match = String(duration).match(/^(\d+)s$/);
  return match ? Number(match[1]) : null;
}

function summarizeRoute(route, mode) {
  const steps = route.legs?.flatMap((leg) => leg.steps || []) || [];
  if (mode === "TRANSIT") {
    const transitSteps = steps
      .map((step) => step.transitDetails)
      .filter(Boolean)
      .map((details) => {
        const line = details.transitLine?.nameShort || details.transitLine?.name || "transit";
        const stop = details.stopDetails?.departureStop?.name;
        return stop ? `${line} from ${stop}` : line;
      });
    return transitSteps.slice(0, 3).join(" -> ");
  }

  return steps
    .map((step) => step.navigationInstruction?.instructions)
    .filter(Boolean)
    .slice(0, 2)
    .join(" -> ");
}

async function enrichTextWithLinkedPage(text) {
  const url = text.match(/https?:\/\/\S+/i)?.[0]?.replace(/[)\].,]+$/, "");
  if (!url) return text;

  try {
    const pageText = await fetchEventPageText(url);
    if (!pageText) return text;

    return [
      text,
      "",
      "Fetched page details:",
      pageText
    ].join("\n");
  } catch (error) {
    console.error("Page fetch failed, using message only:", error.message);
    return text;
  }
}

async function fetchEventPageText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 EventWingmateBot/0.1",
      accept: "text/html,application/xhtml+xml"
    },
    redirect: "follow"
  });

  if (!response.ok) throw new Error(`Page returned ${response.status}`);

  const html = await response.text();
  const locationHidden = isLumaExactLocationHidden(html);
  const pieces = [
    extractHtmlTitle(html),
    extractMetaContent(html, "description"),
    extractMetaContent(html, "og:title"),
    extractMetaContent(html, "og:description"),
    extractMetaContent(html, "og:site_name"),
    ...extractLumaNextDataDetails(html),
    locationHidden ? "Luma location status: exact location hidden until registration or calendar update" : "",
    ...(locationHidden ? [] : extractGoogleMapsDestinations(html)),
    ...extractJsonLdSummaries(html)
  ];

  return uniqueNonEmpty(pieces)
    .join("\n")
    .slice(0, 12000);
}

function isLumaExactLocationHidden(html) {
  return /please register to see the exact location of this event/i.test(html);
}

function extractLumaNextDataDetails(html) {
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i);
  if (!match) return [];

  try {
    const parsed = JSON.parse(match[1]);
    const data = parsed.props?.pageProps?.initialData?.data;
    const event = data?.event || data;
    const addressInfo = event?.geo_address_info || {};
    const exactLocation = extractExactLumaLocation(event, addressInfo);
    const locationIsHidden = event?.geo_address_visibility === "guests-only" || addressInfo.mode === "obfuscated";

    return uniqueNonEmpty([
      event?.name ? `Luma event title: ${event.name}` : "",
      event?.start_at ? `Luma event start: ${event.start_at}` : "",
      exactLocation ? `Luma exact location: ${exactLocation}` : "",
      !exactLocation && locationIsHidden ? "Luma location status: exact location hidden until registration or calendar update" : ""
    ]);
  } catch {
    return [];
  }
}

function extractExactLumaLocation(event, addressInfo) {
  const candidates = [
    event?.geo_address,
    event?.geo_address_json?.address,
    event?.geo_address_json?.formatted_address,
    event?.location?.name,
    event?.location?.address,
    event?.venue?.name && event?.venue?.address ? `${event.venue.name}, ${event.venue.address}` : "",
    addressInfo?.name && addressInfo?.address ? `${addressInfo.name}, ${addressInfo.address}` : "",
    addressInfo?.place_name && addressInfo?.address ? `${addressInfo.place_name}, ${addressInfo.address}` : "",
    addressInfo?.full_address,
    addressInfo?.formatted_address,
    addressInfo?.address
  ];

  return uniqueNonEmpty(candidates).find(hasSpecificLocation) || "";
}

function extractGoogleMapsDestinations(html) {
  return [...html.matchAll(/https?:\/\/[^"'<>\\\s]*google[^"'<>\\\s]*/gi)]
    .map((match) => decodeHtml(match[0]))
    .map((url) => extractGoogleMapsDestination(url))
    .filter(Boolean)
    .map((destination) => `Google Maps destination: ${destination}`);
}

function extractGoogleMapsDestination(url) {
  try {
    const parsed = new URL(url);
    const query = parsed.searchParams.get("query");
    const center = parsed.searchParams.get("center");
    return query || center || "";
  } catch {
    return "";
  }
}

function extractHtmlTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeHtml(match[1]) : "";
}

function extractMetaContent(html, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:name|property)=["']${escapedName}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${escapedName}["'][^>]*>`, "i")
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return decodeHtml(match[1]);
  }

  return "";
}

function extractJsonLdSummaries(html) {
  const matches = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const summaries = [];

  for (const match of matches) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        summaries.push(jsonLdSummary(item));
      }
    } catch {
      // Ignore malformed embedded metadata.
    }
  }

  return summaries;
}

function jsonLdSummary(item) {
  if (!item || typeof item !== "object") return "";
  const fields = [
    item.name,
    item.description,
    item.startDate,
    item.endDate,
    item.location?.name,
    item.location?.address?.streetAddress,
    item.location?.address?.addressLocality,
    item.location?.address?.addressCountry,
    item.location?.geo?.latitude && item.location?.geo?.longitude
      ? `Coordinates: ${item.location.geo.latitude},${item.location.geo.longitude}`
      : "",
    item.location?.latitude && item.location?.longitude
      ? `Coordinates: ${item.location.latitude},${item.location.longitude}`
      : ""
  ];
  return uniqueNonEmpty(fields).join("\n");
}

function uniqueNonEmpty(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function decodeHtml(value) {
  return String(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

async function enrichEventWithOpenAI(event) {
  if (!config.openaiApiKey) return;

  try {
    const extracted = await extractEventWithOpenAI(event.sourceText || event.rawText);
    if (extracted.title) event.title = extracted.title.slice(0, 120);
    if (extracted.url) event.url = extracted.url;
    if (hasSpecificLocation(extracted.location)) {
      event.location = extracted.location;
    } else if (!hasSpecificLocation(event.location)) {
      event.location = "Venue to confirm";
    }
    if (extracted.eventType) event.eventType = extracted.eventType;
    if (extracted.startsAtIso) {
      const startsAt = new Date(extracted.startsAtIso);
      if (!Number.isNaN(startsAt.getTime())) {
        event.startsAt = startsAt.toISOString();
        event.deleteAfter = deleteAfterFor(event.startsAt);
      }
    }
    if (extracted.networkingAtIso) {
      const networkingAt = new Date(extracted.networkingAtIso);
      if (!Number.isNaN(networkingAt.getTime())) event.networkingAt = networkingAt.toISOString();
    }
    event.summary = extracted.summary || "";
    event.audience = extracted.audience || "";
    event.prep = {
      conversationStarters: extracted.conversationStarters || [],
      talkingPoints: extracted.talkingPoints || [],
      socialMission: extracted.socialMission || "",
      encouragement: extracted.encouragement || "",
      missingInfo: extracted.missingInfo || []
    };

    if (isLocationHiddenFromBot(event.sourceText)) {
      event.location = "Location has yet to be updated";
      event.prep.missingInfo = [];
    }
  } catch (error) {
    console.error("OpenAI extraction failed, using rule-based parser:", error.message);
  }
}

async function enrichEventWithCalendar(event) {
  if (!isGoogleCalendarConfigured() || !useSupabase) return;

  try {
    const connection = await readGoogleConnection(event.userId);
    if (!connection?.google_refresh_token) return;

    const accessToken = await refreshGoogleAccessToken(connection.google_refresh_token);
    const calendarEvent = await findMatchingCalendarEvent(accessToken, event);
    const location = calendarEvent?.location?.trim();
    if (hasSpecificLocation(location)) {
      event.location = location;
      event.prep = {
        ...(event.prep || {}),
        missingInfo: []
      };
    }
  } catch (error) {
    console.error("Google Calendar lookup failed:", error.message);
  }
}

async function exchangeGoogleCode(code) {
  const body = new URLSearchParams({
    code,
    client_id: config.googleClientId,
    client_secret: config.googleClientSecret,
    redirect_uri: config.googleRedirectUri,
    grant_type: "authorization_code"
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });

  if (!response.ok) throw new Error(`Token exchange failed: ${response.status} ${await response.text()}`);
  return response.json();
}

async function refreshGoogleAccessToken(refreshToken) {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: config.googleClientId,
    client_secret: config.googleClientSecret,
    grant_type: "refresh_token"
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });

  if (!response.ok) throw new Error(`Token refresh failed: ${response.status} ${await response.text()}`);
  const data = await response.json();
  return data.access_token;
}

async function fetchGoogleEmail(accessToken) {
  const response = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { authorization: `Bearer ${accessToken}` }
  });

  if (!response.ok) return "";
  const data = await response.json();
  return data.email || "";
}

async function findMatchingCalendarEvent(accessToken, event) {
  const calendars = await listGoogleCalendars(accessToken);
  const searchableCalendars = calendars.filter((calendar) => !calendar.hidden);

  for (const calendar of searchableCalendars) {
    const match = await findMatchingCalendarEventInCalendar(accessToken, calendar.id, event);
    if (match) return match;
  }

  return null;
}

async function listGoogleCalendars(accessToken) {
  const response = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250", {
    headers: { authorization: `Bearer ${accessToken}` }
  });

  if (!response.ok) throw new Error(`Calendar list lookup failed: ${response.status} ${await response.text()}`);
  const data = await response.json();
  return data.items || [];
}

async function findMatchingCalendarEventInCalendar(accessToken, calendarId, event) {
  const start = new Date(event.startsAt);
  const timeMin = new Date(start.getTime() - 6 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date(start.getTime() + 12 * 60 * 60 * 1000).toISOString();
  const query = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "20",
    q: formatTitle(event.title)
  });

  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${query.toString()}`, {
    headers: { authorization: `Bearer ${accessToken}` }
  });

  if (!response.ok) throw new Error(`Calendar events lookup failed: ${response.status} ${await response.text()}`);
  const data = await response.json();
  const items = data.items || [];
  return items.find((item) => calendarEventLooksLikeMatch(item, event)) || items.find((item) => hasSpecificLocation(item.location)) || null;
}

function calendarEventLooksLikeMatch(calendarEvent, event) {
  const calendarTitle = normalizeTitle(calendarEvent.summary || "");
  const eventTitle = normalizeTitle(event.title || "");
  if (!calendarTitle || !eventTitle) return false;

  const calendarStart = new Date(calendarEvent.start?.dateTime || calendarEvent.start?.date || "");
  const eventStart = new Date(event.startsAt);
  const closeInTime = Math.abs(calendarStart.getTime() - eventStart.getTime()) < 3 * 60 * 60 * 1000;
  return closeInTime && (calendarTitle.includes(eventTitle.slice(0, 20)) || eventTitle.includes(calendarTitle.slice(0, 20)));
}

function normalizeTitle(title) {
  return formatTitle(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function extractEventWithOpenAI(rawText) {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string" },
      url: { type: "string" },
      startsAtIso: { type: "string" },
      location: { type: "string" },
      eventType: {
        type: "string",
        enum: ["startup", "tech", "product/design", "networking", "workshop", "arts/culture", "wellness", "general"]
      },
      summary: { type: "string" },
      audience: { type: "string" },
      networkingAtIso: { type: "string" },
      conversationStarters: {
        type: "array",
        items: { type: "string" }
      },
      talkingPoints: {
        type: "array",
        items: { type: "string" }
      },
      socialMission: { type: "string" },
      encouragement: { type: "string" },
      missingInfo: {
        type: "array",
        items: { type: "string" }
      }
    },
    required: [
      "title",
      "url",
      "startsAtIso",
      "location",
      "eventType",
      "summary",
      "audience",
      "networkingAtIso",
      "conversationStarters",
      "talkingPoints",
      "socialMission",
      "encouragement",
      "missingInfo"
    ]
  };

  const today = new Intl.DateTimeFormat("en-CA", {
    dateStyle: "full",
    timeZone: config.timezone
  }).format(new Date());

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.openaiApiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: config.openaiModel,
      input: [
        {
          role: "system",
          content: [
            "You extract event details for a private Telegram event companion.",
            `Assume the user's timezone is ${config.timezone}. Today's date is ${today}.`,
            "Return empty strings for unknown text fields and empty arrays for unknown lists.",
            "For location, only return a specific venue name, building, street address, or clearly routable place. Do not return only a city, country, region, or vague value like Singapore, Online, TBA, TBD, or venue to be announced.",
            "Do not infer the venue from prose like 'landing at AI Engineer Singapore' unless the text explicitly labels it as a venue/location/address or structured event metadata gives a specific Place/address.",
            "If fetched details include 'Google Maps destination:' or 'Coordinates:', use that exact coordinate pair as the location.",
            "If the event only exposes a city-level location and no coordinates or maps destination, put venue/address in missingInfo and return an empty location.",
            "For dates, return ISO 8601 strings with timezone offset when the event text provides enough information. If date or time is missing, return an empty string.",
            "Make introvert-friendly suggestions practical, specific, and low-pressure. Avoid generic hype.",
            "Make socialMission one concise question the user can ask someone at the event."
          ].join(" ")
        },
        {
          role: "user",
          content: rawText
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "event_intake",
          strict: true,
          schema
        }
      }
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI request failed: ${response.status} ${body}`);
  }

  const data = await response.json();
  const outputText = data.output_text || data.output?.flatMap((item) => item.content || [])
    .find((content) => content.type === "output_text")?.text;

  if (!outputText) throw new Error("OpenAI response did not include output_text.");
  return JSON.parse(outputText);
}

function deleteAfterFor(startsAt) {
  const date = new Date(startsAt);
  date.setDate(date.getDate() + 2);
  return date.toISOString();
}

function extractTitle(lines, url) {
  const firstUsefulLine = lines.find((line) => !line.startsWith("http") && !looksLikeDate(line));
  if (firstUsefulLine) return firstUsefulLine.slice(0, 90);
  if (url) return "Luma event";
  return "Untitled event";
}

function extractLocation(lines, text) {
  const venueLabels = ["location:", "venue:", "where:", "address:"];
  const labelled = lines.find((line) => venueLabels.some((label) => line.toLowerCase().startsWith(label)));
  if (labelled) return labelled.split(":").slice(1).join(":").trim();

  const atMatch = text.match(/\bat\s+([^.\n]+(?:street|road|avenue|ave|centre|center|hub|hall|hotel|office|sg|singapore)[^.\n]*)/i);
  if (atMatch) {
    const candidate = atMatch[1].trim();
    if (hasSpecificLocation(candidate)) return candidate;
  }

  return "Venue to confirm";
}

function shouldRouteToEventLocation(event) {
  if (isLocationHiddenFromBot(event.sourceText)) return false;
  return hasSpecificLocation(event.location) && (!hasMissingLocationInfo(event.prep?.missingInfo) || isCoordinateLocation(event.location));
}

function isLocationHiddenFromBot(sourceText = "") {
  return /Luma location status: exact location hidden/i.test(sourceText);
}

function hasMissingLocationInfo(missingInfo = []) {
  return missingInfo.some((item) => /\b(location|venue|address|street)\b/i.test(String(item)));
}

function hasSpecificLocation(location) {
  const normalized = String(location || "").trim().toLowerCase();
  if (!normalized) return false;

  const vagueLocations = new Set([
    "singapore",
    "sg",
    "online",
    "virtual",
    "tba",
    "tbd",
    "to be announced",
    "venue to confirm",
    "venue to be confirmed",
    "venue to be announced",
    "location to be announced",
    "location to confirm"
  ]);

  if (vagueLocations.has(normalized)) return false;
  if (isCoordinateLocation(location)) return true;
  if (/^(singapore|sg)[\s,.]*$/i.test(location)) return false;
  if (/\b(tba|tbd|to be announced|to be confirmed)\b/i.test(location)) return false;
  if (/\b(we'?re|we are|throwing|landing at|bring your|free boba|free coffee|sync-up|meetup|event)\b/i.test(location)) return false;
  if (location.length > 90 && !/\d/.test(location)) return false;

  return /[0-9]|\b(street|st|road|rd|avenue|ave|lane|ln|drive|dr|boulevard|blvd|way|place|plaza|tower|centre|center|hub|hall|hotel|office|building|mall|museum|gallery|campus|library|theatre|theater|auditorium|cafe|restaurant|studio|club|school|university|polytechnic|college|national|marina|raffles|orchard|bugis|tanjong|pagar|one-north|city hall|chinatown|sentosa)\b/i.test(location);
}

function isCoordinateLocation(location) {
  return /^-?\d{1,3}(?:\.\d+)?\s*,\s*-?\d{1,3}(?:\.\d+)?$/.test(String(location || "").trim());
}

function extractDate(text) {
  const explicitIso = text.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2})(?::(\d{2}))?)?\b/);
  if (explicitIso) {
    const [, year, month, day, hour = "19", minute = "00"] = explicitIso;
    return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)).toISOString();
  }

  const monthMatch = text.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})(?:,\s*(20\d{2}))?(?:.*?\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/i);
  if (monthMatch) {
    const [, monthName, day, year = String(new Date().getFullYear()), hourRaw = "7", minute = "00", meridiem = "pm"] = monthMatch;
    const monthIndex = monthNumber(monthName);
    let hour = Number(hourRaw);
    if (meridiem.toLowerCase() === "pm" && hour < 12) hour += 12;
    if (meridiem.toLowerCase() === "am" && hour === 12) hour = 0;
    return new Date(Number(year), monthIndex, Number(day), hour, Number(minute)).toISOString();
  }

  return null;
}

function looksLikeDate(line) {
  return /\b(?:20\d{2}-\d{1,2}-\d{1,2}|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i.test(line);
}

function monthNumber(name) {
  return ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(name.slice(0, 3).toLowerCase());
}

function nextLikelyEventTime() {
  const date = new Date();
  date.setDate(date.getDate() + 7);
  date.setHours(19, 0, 0, 0);
  return date.toISOString();
}

function inferEventType(text) {
  const lower = text.toLowerCase();
  if (matchesAny(lower, ["startup", "founder", "vc", "pitch", "demo day"])) return "startup";
  if (matchesAny(lower, ["ai", "machine learning", "llm", "agent", "developer", "hackathon"])) return "tech";
  if (matchesAny(lower, ["design", "product", "ux", "creative"])) return "product/design";
  if (matchesAny(lower, ["social", "mixer", "community", "networking"])) return "networking";
  if (matchesAny(lower, ["workshop", "masterclass", "training"])) return "workshop";
  return "general";
}

function matchesAny(text, terms) {
  return terms.some((term) => text.includes(term));
}

function eventPrepMessage(event) {
  const canRoute = shouldRouteToEventLocation(event);
  const transitUrl = canRoute ? mapsUrl(config.homeAddress, event.location, "transit") : "";
  const drivingUrl = canRoute ? mapsUrl(config.homeAddress, event.location, "driving") : "";
  const conversationStarters = event.prep?.conversationStarters || [];
  const starts = formatDateTime(event.startsAt);

  return [
    `Saved: ${formatTitle(event.title)}`,
    `When: ${starts}`,
    `Where: ${canRoute ? event.location : "Location has yet to be updated"}`,
    event.summary ? `Summary: ${event.summary}` : "",
    event.url ? `Link: ${event.url}` : "",
    "",
    "Getting there:",
    ...travelLines(event, transitUrl, drivingUrl),
    "",
    conversationStarters.length ? "Easy openers:" : "",
    ...formatOpeners(conversationStarters),
    "",
    "Tiny mission:",
    missionQuestion(event)
  ].filter(Boolean).join("\n");
}

function travelLines(event, transitUrl, drivingUrl) {
  if (!shouldRouteToEventLocation(event)) {
    return [
      "Travel time: not available until the location is updated."
    ];
  }

  if (!event.travel?.transit && !event.travel?.driving) {
    return [
      `Public transport: ${transitUrl}`,
      `Car: ${drivingUrl}`
    ];
  }

  const lines = [];
  if (event.travel?.transit) {
    lines.push(`Public transport: ${formatDuration(event.travel.transit.durationSeconds)}${leaveByText(event.startsAt, event.travel.transit.durationSeconds)}`);
    if (event.travel.transit.summary) lines.push(`Route: ${event.travel.transit.summary}`);
  } else {
    lines.push(`Public transport: ${transitUrl}`);
  }

  if (event.travel?.driving) {
    lines.push(`Car: ${formatDuration(event.travel.driving.durationSeconds)}${leaveByText(event.startsAt, event.travel.driving.durationSeconds)}`);
  } else {
    lines.push(`Car: ${drivingUrl}`);
  }

  lines.push(`Open in Maps: ${transitUrl}`);
  return lines;
}

function formatOpeners(conversationStarters) {
  return conversationStarters
    .slice(0, 3)
    .flatMap((point) => [`- ${point}`, ""]);
}

function missionQuestion(event) {
  const opener = cleanQuestion(event.prep?.conversationStarters?.[0]);
  if (opener) return `Ask someone "${opener}"`;

  const mission = cleanQuestion(event.prep?.socialMission);
  if (mission) return `Ask someone "${mission}"`;

  return "Ask someone \"Are you using this tool or topic in your own work?\"";
}

function cleanQuestion(value) {
  return String(value || "")
    .trim()
    .replace(/^ask someone\s+/i, "")
    .replace(/^["']|["']$/g, "")
    .trim();
}

function formatTitle(title) {
  return String(title || "Untitled event")
    .replace(/[“”]/g, "\"")
    .replace(/^"([^"]+)"(.*)$/u, "$1$2")
    .trim();
}

function leaveByText(startsAt, durationSeconds) {
  if (!durationSeconds) return "";
  const bufferMinutes = 15;
  const leaveAt = new Date(new Date(startsAt).getTime() - durationSeconds * 1000 - bufferMinutes * 60 * 1000);
  return `, leave by ${formatTime(leaveAt)}`;
}

function formatDuration(seconds) {
  if (!seconds) return "time unavailable";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours} hr ${remainingMinutes} min` : `${hours} hr`;
}

function talkingPointsFor(eventType) {
  const points = {
    startup: [
      "Ask what problem they are most obsessed with right now.",
      "Ask how they found their first users or customers.",
      "Share one honest thing you are curious about in the startup space."
    ],
    tech: [
      "Ask what tool or workflow has surprised them recently.",
      "Ask what they think is overhyped versus genuinely useful.",
      "Share a small project idea and ask how they would approach it."
    ],
    "product/design": [
      "Ask what user behavior they have changed their mind about.",
      "Ask what product they think has unusually good onboarding.",
      "Share a product detail you noticed and why it stuck with you."
    ],
    networking: [
      "Ask what brought them to the event.",
      "Ask what kind of people they were hoping to meet.",
      "Offer a short intro about yourself, then hand the spotlight back."
    ],
    workshop: [
      "Ask what they are hoping to learn today.",
      "Ask whether they have tried this topic in practice before.",
      "Compare notes after the first exercise or session."
    ],
    general: [
      "Ask what made the event worth coming to.",
      "Ask what they have been working on lately.",
      "Mention one part of the event description that caught your attention."
    ]
  };

  return points[eventType] || points.general;
}

function mapsUrl(origin, destination, mode) {
  const params = new URLSearchParams({
    api: "1",
    origin,
    destination,
    travelmode: mode
  });
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

function welcomeMessage() {
  return [
    "Hey, I am your Event Wingmate.",
    "",
    "Paste a Luma link or event text and I will save the event, generate travel links, suggest talking points, and nudge you before it is time to network.",
    "",
    "Use /help for commands."
  ].join("\n");
}

function helpMessage() {
  return [
    "Commands:",
    "/events - list saved events",
    "/connect_calendar - connect Google Calendar",
    "/settings - show current settings",
    "/help - show this message",
    "",
    "You can paste:",
    "- A Luma link",
    "- Event title, date, venue, and description",
    "- Any event invite text"
  ].join("\n");
}

function calendarConnectMessage(userId) {
  if (!isGoogleCalendarConfigured()) {
    return [
      "Google Calendar is not configured yet.",
      "",
      googleCalendarConfigStatus(),
      "",
      "Check that these exact Railway variables exist on the event-wingmate-bot service, then apply changes and wait for redeploy."
    ].join("\n");
  }

  const authUrl = new URL(config.googleRedirectUri);
  authUrl.pathname = "/auth/google";
  authUrl.search = "";
  authUrl.searchParams.set("user_id", userId);

  return [
    "Connect Google Calendar here:",
    authUrl.toString(),
    "",
    "I will only request read-only calendar access so I can find exact event locations."
  ].join("\n");
}

async function settingsMessage(userId) {
  const calendarConnection = useSupabase ? await readGoogleConnection(userId) : null;
  return [
    "Current settings:",
    `Home address: ${config.homeAddress}`,
    `Timezone: ${config.timezone}`,
    `Your Telegram user ID: ${userId}`,
    `Locked to user ID: ${config.allowedUserId || "first /start user"}`,
    `Storage: ${useSupabase ? "Supabase" : config.dataFile}`,
    googleCalendarConfigStatus(),
    `Google Calendar: ${calendarConnection?.google_refresh_token ? `connected${calendarConnection.google_email ? ` (${calendarConnection.google_email})` : ""}` : "not connected"}`
  ].join("\n");
}

function googleCalendarConfigStatus() {
  return [
    "Google Calendar config:",
    `GOOGLE_CLIENT_ID: ${config.googleClientId ? "present" : "missing"}`,
    `GOOGLE_CLIENT_SECRET: ${config.googleClientSecret ? "present" : "missing"}`,
    `GOOGLE_REDIRECT_URI: ${config.googleRedirectUri ? "present" : "missing"}`
  ].join("\n");
}

async function eventsMessage(chatId) {
  const events = await readEventsForChat(chatId);
  if (events.length === 0) return "No events saved yet. Paste a Luma link or event text to add one.";

  return events
    .slice(-10)
    .map((event, index) => `${index + 1}. ${event.title}\n${formatDateTime(event.startsAt)}\n${event.location}`)
    .join("\n\n");
}

function scheduleReminderLoop() {
  setInterval(async () => {
    try {
      await sendDueReminders();
    } catch (error) {
      console.error("Reminder loop failed:", error.message);
    }
  }, 60 * 1000);
}

async function sendDueReminders() {
  await deleteExpiredEvents();
  const events = await readUpcomingEvents();
  const now = Date.now();
  let changed = false;

  for (const event of events) {
    const startsAt = new Date(event.startsAt).getTime();
    const dueReminders = [
      {
        key: "dayBefore",
        dueAt: startsAt - 24 * 60 * 60 * 1000,
        message: dayBeforeMessage(event)
      },
      {
        key: "leaveTime",
        dueAt: startsAt - 60 * 60 * 1000,
        message: leaveTimeMessage(event)
      },
      {
        key: "networking",
        dueAt: event.networkingAt ? new Date(event.networkingAt).getTime() : startsAt + 30 * 60 * 1000,
        message: networkingMessage(event)
      }
    ];

    for (const reminder of dueReminders) {
      const reminderKey = `${event.id}:${reminder.key}`;
      const alreadySent = event.reminders?.[reminder.key] || sentReminderKeys.has(reminderKey);
      const isDue = now >= reminder.dueAt && now < reminder.dueAt + 10 * 60 * 1000;
      if (!alreadySent && isDue) {
        await sendMessage(event.chatId, reminder.message, { disable_web_page_preview: true });
        event.reminders = { ...event.reminders, [reminder.key]: true };
        sentReminderKeys.add(reminderKey);
        changed = true;
      }
    }
  }

  if (changed) await updateEvents(events);
}

function dayBeforeMessage(event) {
  const opener = event.prep?.conversationStarters?.[0] || talkingPointsFor(event.eventType)[0];
  const transitLine = !shouldRouteToEventLocation(event)
    ? "Travel time: not available yet because the venue is not specific."
    : event.travel?.transit
    ? `Public transport: ${formatDuration(event.travel.transit.durationSeconds)}${leaveByText(event.startsAt, event.travel.transit.durationSeconds)}`
    : `Public transport: ${mapsUrl(config.homeAddress, event.location, "transit")}`;
  return [
    `Tomorrow: ${event.title}`,
    "",
    `Venue: ${event.location}`,
    transitLine,
    "",
    "Pick one opener now so your future self has less to carry:",
    opener
  ].join("\n");
}

function leaveTimeMessage(event) {
  const transitDuration = event.travel?.transit?.durationSeconds;
  if (!shouldRouteToEventLocation(event)) {
    return [
      `Venue still missing for ${event.title}.`,
      "",
      "I cannot calculate travel time yet. Check the event page or calendar invite for the final location before leaving."
    ].join("\n");
  }

  return [
    `Leave soon for ${event.title}.`,
    "",
    transitDuration ? `Public transport should take about ${formatDuration(transitDuration)}. Give yourself breathing room and arrive as the person who planned this nicely.` : "Check the route now, give yourself breathing room, and arrive as the person who planned this nicely.",
    mapsUrl(config.homeAddress, event.location, "transit")
  ].join("\n");
}

function networkingMessage(event) {
  const encouragement = event.prep?.encouragement || "You are already there. The hard part is done.";
  const mission = event.prep?.socialMission || "Say hi to one person, ask what brought them here, and stay for one honest answer.";
  return [
    "Networking time.",
    "",
    `${encouragement} ${mission}`
  ].join("\n");
}

async function telegram(method, payload) {
  const response = await fetch(`${apiBase}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${method} failed: ${response.status} ${body}`);
  }

  return response.json();
}

async function sendMessage(chatId, text, options = {}) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    ...options
  });
}

async function initializeStorage() {
  if (useSupabase) return;
  await ensureDataFile();
}

async function ensureDataFile() {
  await fs.mkdir(path.dirname(config.dataFile), { recursive: true });
  try {
    await fs.access(config.dataFile);
  } catch {
    await fs.writeFile(config.dataFile, "[]\n", "utf8");
  }
}

async function readOwnerId() {
  if (useSupabase) {
    const owners = await supabaseRequest("/rest/v1/bot_owners?select=telegram_user_id&order=created_at.asc&limit=1");
    return owners[0]?.telegram_user_id || "";
  }

  try {
    const ownerFile = ownerFilePath();
    return (await fs.readFile(ownerFile, "utf8")).trim();
  } catch {
    return "";
  }
}

async function writeOwnerId(userId) {
  if (useSupabase) {
    await supabaseRequest("/rest/v1/bot_owners", {
      method: "POST",
      body: [{ telegram_user_id: userId }],
      headers: { prefer: "resolution=ignore-duplicates" }
    });
    return;
  }

  const ownerFile = ownerFilePath();
  await fs.mkdir(path.dirname(ownerFile), { recursive: true });
  await fs.writeFile(ownerFile, `${userId}\n`, "utf8");
}

async function readGoogleConnection(userId) {
  if (!useSupabase) return null;
  const query = new URLSearchParams({
    select: "google_refresh_token,google_email,google_connected_at",
    telegram_user_id: `eq.${userId}`,
    limit: "1"
  });
  const rows = await supabaseRequest(`/rest/v1/bot_owners?${query.toString()}`);
  return rows[0] || null;
}

async function saveGoogleConnection(userId, refreshToken, email) {
  if (!useSupabase) throw new Error("Google Calendar requires Supabase storage.");

  await supabaseRequest("/rest/v1/bot_owners", {
    method: "POST",
    body: [{
      telegram_user_id: userId,
      google_refresh_token: refreshToken,
      google_email: email || null,
      google_connected_at: new Date().toISOString()
    }],
    headers: { prefer: "resolution=merge-duplicates" }
  });
}

function ownerFilePath() {
  return path.join(path.dirname(config.dataFile), "owner.txt");
}

async function readEvents() {
  const raw = await fs.readFile(config.dataFile, "utf8");
  return JSON.parse(raw);
}

async function writeEvents(events) {
  await fs.mkdir(path.dirname(config.dataFile), { recursive: true });
  await fs.writeFile(config.dataFile, `${JSON.stringify(events, null, 2)}\n`, "utf8");
}

async function saveEvent(event) {
  if (useSupabase) {
    await supabaseRequest("/rest/v1/events", {
      method: "POST",
      body: [toSupabaseEvent(event)]
    });
    return;
  }

  const events = await readEvents();
  events.push(event);
  await writeEvents(events);
}

async function readEventsForChat(chatId) {
  if (useSupabase) {
    const query = new URLSearchParams({
      select: "*",
      telegram_chat_id: `eq.${chatId}`,
      order: "starts_at.asc",
      limit: "10"
    });
    const rows = await supabaseRequest(`/rest/v1/events?${query.toString()}`);
    return rows.map(fromSupabaseEvent);
  }

  return (await readEvents()).filter((event) => event.chatId === chatId);
}

async function readUpcomingEvents() {
  if (useSupabase) {
    const query = new URLSearchParams({
      select: "*",
      starts_at: `gte.${new Date(Date.now() - 60 * 60 * 1000).toISOString()}`,
      order: "starts_at.asc"
    });
    const rows = await supabaseRequest(`/rest/v1/events?${query.toString()}`);
    return rows.map(fromSupabaseEvent);
  }

  return readEvents();
}

async function updateEvents(events) {
  if (useSupabase) {
    for (const event of events) {
      await supabaseRequest(`/rest/v1/events?id=eq.${encodeURIComponent(event.id)}`, {
        method: "PATCH",
        body: {
          reminders: event.reminders
        }
      });
    }
    return;
  }

  await writeEvents(events);
}

async function deleteExpiredEvents() {
  if (useSupabase) {
    await supabaseRequest(`/rest/v1/events?delete_after=lt.${encodeURIComponent(new Date().toISOString())}`, {
      method: "DELETE"
    });
    return;
  }

  const events = await readEvents();
  const activeEvents = events.filter((event) => {
    const deleteAfter = event.deleteAfter || deleteAfterFor(event.startsAt);
    return new Date(deleteAfter).getTime() > Date.now();
  });
  if (activeEvents.length !== events.length) await writeEvents(activeEvents);
}

async function supabaseRequest(pathname, options = {}) {
  const response = await fetch(`${config.supabaseUrl}${pathname}`, {
    method: options.method || "GET",
    headers: {
      apikey: config.supabaseServiceRoleKey,
      authorization: `Bearer ${config.supabaseServiceRoleKey}`,
      "content-type": "application/json",
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Supabase request failed: ${response.status} ${body}`);
  }

  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function toSupabaseEvent(event) {
  return {
    id: event.id,
    telegram_chat_id: event.chatId,
    telegram_user_id: event.userId,
    title: event.title,
    url: event.url || null,
    raw_text: event.rawText,
    location: event.location,
    event_type: event.eventType,
    starts_at: event.startsAt,
    summary: event.summary || null,
    audience: event.audience || null,
    networking_at: event.networkingAt || null,
    prep: event.prep || {},
    travel: event.travel || {},
    reminders: event.reminders,
    created_at: event.createdAt,
    delete_after: event.deleteAfter
  };
}

function fromSupabaseEvent(row) {
  return {
    id: row.id,
    chatId: row.telegram_chat_id,
    userId: row.telegram_user_id,
    title: row.title,
    url: row.url || "",
    rawText: row.raw_text || "",
    sourceText: row.raw_text || "",
    location: row.location,
    eventType: row.event_type,
    startsAt: row.starts_at,
    summary: row.summary || "",
    audience: row.audience || "",
    networkingAt: row.networking_at || null,
    prep: row.prep || null,
    travel: row.travel || null,
    reminders: row.reminders || {},
    createdAt: row.created_at,
    deleteAfter: row.delete_after
  };
}

function formatDateTime(isoString) {
  return new Intl.DateTimeFormat("en-SG", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: config.timezone
  }).format(new Date(isoString));
}

function formatTime(date) {
  return new Intl.DateTimeFormat("en-SG", {
    timeStyle: "short",
    timeZone: config.timezone
  }).format(date);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
