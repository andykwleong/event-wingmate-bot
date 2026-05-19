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
  authUrl.searchParams.set("scope", "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/userinfo.email");
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

  if (text === "/event_details" || text.startsWith("/event_details ") || text === "/events_details" || text.startsWith("/events_details ")) {
    await sendMessage(chatId, await eventDetailsMessage(chatId, text), {
      disable_web_page_preview: true,
      parse_mode: "HTML"
    });
    return;
  }

  if (text === "/delete_event" || text.startsWith("/delete_event ")) {
    await sendMessage(chatId, await deleteEventMessage(chatId, text));
    return;
  }

  if (text === "/delete_all_events" || text === "/delete_all_events confirm") {
    await sendMessage(chatId, await deleteAllEventsMessage(chatId, text));
    return;
  }

  if (text === "/debug_calendar") {
    await sendMessage(chatId, await debugCalendarMessage(chatId, userId));
    return;
  }

  const enrichedText = await enrichTextWithLinkedPage(text);
  const event = parseEvent(enrichedText, chatId, userId);
  event.rawText = text;
  event.sourceText = enrichedText;
  await enrichEventWithOpenAI(event);
  await enrichEventWithCalendar(event);
  if (isWithinNext24Hours(event.startsAt)) {
    await enrichEventWithTravel(event);
  }
  const existingEvent = await findDuplicateEvent(event);
  if (existingEvent) {
    const mergedEvent = mergeDuplicateEvent(existingEvent, event);
    if (eventNeedsUpdate(existingEvent, mergedEvent)) await updateEvent(mergedEvent);

    await sendMessage(chatId, duplicateEventMessage(mergedEvent), {
      disable_web_page_preview: true,
      parse_mode: "HTML"
    });
    return;
  }

  await saveEvent(event);

  await sendMessage(chatId, eventResponseMessage(event), {
    disable_web_page_preview: true,
    parse_mode: "HTML"
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
  if (!config.googleMapsApiKey) return false;
  if (!shouldRouteToEventLocation(event)) return false;
  event.travel = {};

  const departureTime = recommendedDepartureDate(event.startsAt);

  try {
    event.travel.transit = await computeRoute({
      origin: config.homeAddress,
      destination: event.location,
      mode: "TRANSIT",
      departureTime
    });
  } catch (error) {
    console.error("Transit route failed:", error.message);
  }

  try {
    event.travel.driving = await computeRoute({
      origin: config.homeAddress,
      destination: event.location,
      mode: "DRIVE",
      departureTime
    });
  } catch (error) {
    console.error("Driving route failed:", error.message);
  }

  return true;
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
    const location = bestCalendarLocation(calendarEvent);
    if (hasSpecificLocation(location)) {
      event.location = location;
      event.locationSource = "google_calendar";
      event.prep = {
        ...(event.prep || {}),
        missingInfo: []
      };
    }
  } catch (error) {
    console.error("Google Calendar lookup failed:", error.message);
  }
}

function bestCalendarLocation(calendarEvent) {
  if (!calendarEvent) return "";

  const candidates = uniqueNonEmpty([
    calendarEvent.location,
    extractCalendarDescriptionLocation(calendarEvent.description)
  ]).filter(hasSpecificLocation);

  return candidates.find((candidate) => !isCoordinateLocation(candidate)) || candidates[0] || "";
}

function extractCalendarDescriptionLocation(description = "") {
  const text = decodeCalendarText(description);
  const labelled = text.match(/\b(?:location|venue|where|address)\s*:\s*([^\n]+)/i)?.[1];
  if (labelled && hasSpecificLocation(cleanCalendarLocation(labelled))) {
    return cleanCalendarLocation(labelled);
  }

  return "";
}

function decodeCalendarText(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function cleanCalendarLocation(value) {
  return String(value || "")
    .replace(/\s+(?:https?:\/\/|www\.).*$/i, "")
    .replace(/\s+\b(?:details|description|organizer|host|when|date|time)\s*:.*$/i, "")
    .trim();
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
  const calendars = await listGoogleCalendars(accessToken).catch((error) => {
    console.error("Calendar list failed, falling back to primary calendar:", error.message);
    return [{ id: "primary", summary: "Primary" }];
  });
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
  const queriedItems = await fetchCalendarEvents(accessToken, calendarId, {
    timeMin,
    timeMax,
    q: formatTitle(event.title)
  });
  const timeWindowItems = await fetchCalendarEvents(accessToken, calendarId, { timeMin, timeMax });
  const items = dedupeCalendarEvents([...queriedItems, ...timeWindowItems]);

  return items.find((item) => calendarEventLooksLikeMatch(item, event) && hasSpecificLocation(item.location))
    || items.find((item) => calendarEventLooksLikeMatch(item, event))
    || null;
}

async function fetchCalendarEvents(accessToken, calendarId, { timeMin, timeMax, q = "" }) {
  const query = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "50"
  });
  if (q) query.set("q", q);

  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${query.toString()}`, {
    headers: { authorization: `Bearer ${accessToken}` }
  });

  if (!response.ok) throw new Error(`Calendar events lookup failed: ${response.status} ${await response.text()}`);
  const data = await response.json();
  return data.items || [];
}

function dedupeCalendarEvents(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.id || `${item.summary}:${item.start?.dateTime || item.start?.date}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function calendarEventLooksLikeMatch(calendarEvent, event) {
  const calendarTitle = normalizeTitle(calendarEvent.summary || "");
  const eventTitle = normalizeTitle(event.title || "");
  if (!calendarTitle || !eventTitle) return false;

  const calendarStart = new Date(calendarEvent.start?.dateTime || calendarEvent.start?.date || "");
  const eventStart = new Date(event.startsAt);
  const closeInTime = Math.abs(calendarStart.getTime() - eventStart.getTime()) < 3 * 60 * 60 * 1000;
  return closeInTime && (
    calendarTitle.includes(eventTitle)
    || eventTitle.includes(calendarTitle)
    || compactTitle(calendarTitle).includes(compactTitle(eventTitle))
    || compactTitle(eventTitle).includes(compactTitle(calendarTitle))
    || sharedTitleWordCount(calendarTitle, eventTitle) >= 2
    || calendarEventContainsUrl(calendarEvent, event.url)
  );
}

function sharedTitleWordCount(left, right) {
  const ignored = new Set(["with", "the", "and", "for", "this", "that", "singapore", "event"]);
  const leftWords = new Set(left.split(" ").filter((word) => word.length > 2 && !ignored.has(word)));
  return right.split(" ").filter((word) => leftWords.has(word)).length;
}

function calendarEventContainsUrl(calendarEvent, url) {
  if (!url) return false;
  const slug = url.match(/luma\.com\/([^?/\s]+)/i)?.[1];
  if (!slug) return false;
  return [calendarEvent.description, calendarEvent.htmlLink, calendarEvent.location]
    .some((value) => String(value || "").includes(slug));
}

function normalizeTitle(title) {
  return formatTitle(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function compactTitle(title) {
  return normalizeTitle(title).replace(/\s+/g, "");
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
            "Write for an introvert who wants one natural, low-pressure conversation, not generic networking.",
            "Conversation starters must sound like something a person would casually say out loud. Keep each under 16 words.",
            "Make the first conversation starter the warmest and safest opener: about why they came, what caught their eye, or what they are hoping to try. Put more technical questions second or third.",
            "Avoid stiff phrases like 'most wanted to replace', 'how are you thinking about', 'what is one problem', or corporate wording.",
            "Use contractions where natural. Avoid hype.",
            "Make socialMission one concise, human action that is not identical to any conversation starter. It can suggest when to use one opener, but should not repeat it verbatim."
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
  date.setDate(date.getDate() + 1);
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
  if (event.locationSource === "google_calendar") return hasSpecificLocation(event.location);
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

  return compactMessage([
    `Saved: ${escapeHtml(formatTitle(event.title))}`,
    `When: ${escapeHtml(starts)}`,
    `Where: ${escapeHtml(canRoute ? event.location : "Location has yet to be updated")}`,
    "",
    event.summary ? "Event Summary:" : "",
    event.summary ? escapeHtml(event.summary) : "",
    event.url ? `Link: ${escapeHtml(event.url)}` : "",
    "",
    "Getting there:",
    ...travelLines(event, transitUrl, drivingUrl),
    "",
    conversationStarters.length ? "Easy openers:" : "",
    ...formatOpeners(conversationStarters),
    conversationStarters.length ? "" : "",
    "Tiny mission:",
    escapeHtml(missionQuestion(event))
  ]);
}

function eventResponseMessage(event) {
  return isWithinNext24Hours(event.startsAt) ? eventPrepMessage(event) : futureEventSavedMessage(event);
}

function futureEventSavedMessage(event) {
  return compactMessage([
    `Saved: ${escapeHtml(formatTitle(event.title))}`,
    `When: ${escapeHtml(formatDateTime(event.startsAt))}`,
    `Where: ${escapeHtml(shouldRouteToEventLocation(event) ? event.location : "Location has yet to be updated")}`,
    "",
    "I’ll send the full prep and travel reminder 24 hours before the event.",
    "",
    "Prep ideas:",
    ...prepSuggestionLines(event)
  ]);
}

function prepSuggestionLines(event) {
  const starters = event.prep?.conversationStarters || [];
  const opener = prepOpenerForEvent(event, starters);
  const suggestions = [
    event.summary ? `Skim the event theme: ${event.summary}` : "",
    opener ? `Keep one opener ready: ${opener}` : "",
    simpleEventQuestion(event, [opener].filter(Boolean))
  ].filter(Boolean).slice(0, 3);

  const fallback = [
    "Check who is hosting and why the topic matters to you.",
    "Prepare one simple opener you can say without overthinking.",
    "Decide one small outcome that would make attending worthwhile."
  ];

  return (suggestions.length >= 3 ? suggestions : [...suggestions, ...fallback].slice(0, 3))
    .flatMap((suggestion) => [`- ${escapeHtml(suggestion)}`, ""]);
}

function prepOpenerForEvent(event, starters) {
  const specificStarter = starters
    .map(cleanQuestion)
    .find((starter) => starter && !isGenericOpener(starter) && starter.length <= 90);
  if (specificStarter) return specificStarter;

  return eventSpecificQuestion(event, "opener");
}

function simpleEventQuestion(event, usedQuestions = []) {
  const used = usedQuestions.map(cleanQuestion).filter(Boolean);
  const candidate = eventSpecificQuestion(event, "backup");
  if (candidate && !used.some((question) => sameQuestion(question, candidate))) {
    return `Have a simple backup question: ${candidate}`;
  }

  const mission = cleanQuestion(event.prep?.socialMission || "");
  if (mission && mission.length <= 90 && !isGenericOpener(mission) && !used.some((question) => sameQuestion(question, mission))) {
    return `Have a simple backup question: ${mission}`;
  }

  const title = formatTitle(event.title);
  const topic = title
    .replace(/\b(ft|with|w\/)\b.*$/i, "")
    .replace(/["']/g, "")
    .trim();

  if (topic && topic.length <= 60) {
    return `Have a simple backup question: What made you interested in ${topic}?`;
  }

  return "Have a simple backup question: What made you interested in this event?";
}

function eventSpecificQuestion(event, purpose) {
  const text = `${event.title || ""} ${event.summary || ""} ${(event.prep?.talkingPoints || []).join(" ")}`.toLowerCase();
  const seed = `${event.title || ""}:${event.startsAt || ""}:${purpose}`;

  if (matchesAny(text, ["magic patterns", "design tooling", "prototype", "ui"])) {
    return pickQuestion(seed, purpose === "opener"
      ? [
        "Have you tried Magic Patterns before?",
        "Are you using AI for design work yet?",
        "What kind of prototype are you working on?"
      ]
      : [
        "What would make design tools easier for you?",
        "Which part of app design slows you down most?",
        "What would you want to prototype faster?"
      ]);
  }

  if (matchesAny(text, ["kill your saas", "zo computer", "minimax", "replace common saas", "personal server"])) {
    return pickQuestion(seed, purpose === "opener"
      ? [
        "Which SaaS tool would you love to replace?",
        "Are you trying to automate anything right now?",
        "Have you used Zo or MiniMax before?"
      ]
      : [
        "What would you try building if setup was easy?",
        "Which paid tool feels too annoying to keep?",
        "What workflow would you make simpler first?"
      ]);
  }

  if (matchesAny(text, ["convex", "real-time sync", "backend state"])) {
    return pickQuestion(seed, purpose === "opener"
      ? [
        "Have you used Convex before?",
        "Are you building anything with real-time updates?",
        "What kind of app are you working on?"
      ]
      : [
        "Where would real-time sync help in your app?",
        "What backend part do you usually find painful?",
        "What made Convex interesting to you?"
      ]);
  }

  if (matchesAny(text, ["ai engineer", "llm", "agent", "ai app"])) {
    return pickQuestion(seed, purpose === "opener"
      ? [
        "Which AI topic are you most curious about?",
        "Are you building anything with AI right now?",
        "What AI demo caught your attention lately?"
      ]
      : [
        "Have you built anything with AI yet?",
        "What would you like AI to help you make?",
        "Which AI tool have you actually found useful?"
      ]);
  }

  if (matchesAny(text, ["workshop", "hands-on", "demo"])) {
    return pickQuestion(seed, purpose === "opener"
      ? [
        "Are you planning to try the hands-on part?",
        "Which part of the workshop are you here for?",
        "Have you done a session like this before?"
      ]
      : [
        "What are you hoping to learn today?",
        "What would make this workshop useful for you?",
        "Is there anything you want to try building?"
      ]);
  }

  return "";
}

function pickQuestion(seed, questions) {
  return questions[Math.abs(hashText(seed)) % questions.length];
}

function hashText(text) {
  return [...text].reduce((hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) | 0, 0);
}

function isGenericOpener(question) {
  return /what brought you (here|by|tonight|today)|what caught your eye|what are you hoping|get out of|first time/i.test(question);
}

function isWithinNext24Hours(isoString) {
  const startsAt = new Date(isoString).getTime();
  return startsAt - Date.now() <= 24 * 60 * 60 * 1000;
}

function duplicateEventMessage(event) {
  return compactMessage([
    "This event has been saved previously.",
    "",
    `Saved: ${escapeHtml(formatTitle(event.title))}`,
    `When: ${escapeHtml(formatDateTime(event.startsAt))}`,
    `Where: ${escapeHtml(shouldRouteToEventLocation(event) ? event.location : "Location has yet to be updated")}`,
    "",
    "I will only send one set of reminders for this event."
  ]);
}

function mergeDuplicateEvent(savedEvent, freshEvent) {
  const merged = {
    ...savedEvent,
    title: freshEvent.title || savedEvent.title,
    url: freshEvent.url || savedEvent.url,
    startsAt: freshEvent.startsAt || savedEvent.startsAt,
    eventType: freshEvent.eventType || savedEvent.eventType,
    summary: freshEvent.summary || savedEvent.summary,
    audience: freshEvent.audience || savedEvent.audience,
    networkingAt: freshEvent.networkingAt || savedEvent.networkingAt,
    rawText: savedEvent.rawText || freshEvent.rawText,
    sourceText: freshEvent.sourceText || savedEvent.sourceText,
    prep: hasUsefulPrep(freshEvent.prep) ? freshEvent.prep : savedEvent.prep,
    travel: null,
    deleteAfter: freshEvent.deleteAfter || savedEvent.deleteAfter,
    reminders: savedEvent.reminders || freshEvent.reminders,
    createdAt: savedEvent.createdAt || freshEvent.createdAt
  };

  if (hasBetterLocation(freshEvent, savedEvent)) {
    merged.location = freshEvent.location;
    merged.locationSource = freshEvent.locationSource;
    merged.prep = {
      ...(merged.prep || {}),
      missingInfo: []
    };
  }

  return merged;
}

function hasUsefulPrep(prep) {
  return Boolean(
    prep?.conversationStarters?.length
    || prep?.talkingPoints?.length
    || prep?.socialMission
    || prep?.encouragement
  );
}

function hasBetterLocation(freshEvent, savedEvent) {
  if (!shouldRouteToEventLocation(freshEvent)) return false;
  if (!shouldRouteToEventLocation(savedEvent)) return true;
  return hasSpecificLocation(freshEvent.location) && freshEvent.location !== savedEvent.location;
}

function eventNeedsUpdate(before, after) {
  const fields = ["title", "url", "location", "startsAt", "eventType", "summary", "audience", "networkingAt", "deleteAfter"];
  return fields.some((field) => before[field] !== after[field])
    || JSON.stringify(before.prep || null) !== JSON.stringify(after.prep || null)
    || JSON.stringify(before.travel || null) !== JSON.stringify(after.travel || null);
}

function compactMessage(lines) {
  const output = [];
  for (const line of lines) {
    if (line === "" && output.at(-1) === "") continue;
    if (line !== "" || output.length > 0) output.push(line);
  }
  while (output.at(-1) === "") output.pop();
  return output.join("\n");
}

function travelLines(event, transitUrl, drivingUrl) {
  if (!shouldRouteToEventLocation(event)) {
    return [
      "Travel time: not available until the location is updated."
    ];
  }

  if (!hasTravelDetails(event)) {
    return [
      `Public transport: <a href="${escapeHtmlAttribute(transitUrl)}">Here</a>`,
      `Car: <a href="${escapeHtmlAttribute(drivingUrl)}">Here</a>`
    ];
  }

  const lines = [];
  if (event.travel?.transit) {
    lines.push(`Public transport: ${escapeHtml(formatDuration(event.travel.transit.durationSeconds))}${escapeHtml(leaveByText(event.startsAt, event.travel.transit.durationSeconds))}`);
    if (event.travel.transit.summary) lines.push(`Route: ${escapeHtml(event.travel.transit.summary)}`);
  } else {
    lines.push(`Public transport: ${escapeHtml(transitUrl)}`);
  }

  if (event.travel?.driving) {
    lines.push(`Car: ${escapeHtml(formatDuration(event.travel.driving.durationSeconds))}${escapeHtml(leaveByText(event.startsAt, event.travel.driving.durationSeconds))}`);
  } else {
    lines.push(`Car: ${escapeHtml(drivingUrl)}`);
  }

  lines.push(`Open in Maps: <a href="${escapeHtmlAttribute(transitUrl)}">Here</a>`);
  return lines;
}

function hasTravelDetails(event) {
  return Boolean(event.travel?.transit || event.travel?.driving);
}

function formatOpeners(conversationStarters) {
  return conversationStarters
    .slice(0, 3)
    .flatMap((point) => [`- ${escapeHtml(point)}`, ""]);
}

function missionQuestion(event) {
  const mission = cleanQuestion(event.prep?.socialMission);
  const openers = (event.prep?.conversationStarters || []).map(cleanQuestion).filter(Boolean);
  if (mission && !openers.some((opener) => sameQuestion(opener, mission))) {
    return mission.includes("?") ? `Ask someone "${mission}"` : mission;
  }

  const fallback = nonDuplicateMission(openers);
  if (fallback) return fallback;

  return "Ask one person what made them curious enough to show up.";
}

function nonDuplicateMission(openers) {
  if (openers.length === 0) return "";
  if (openers.some((opener) => /what made you curious|what brought you/i.test(opener))) {
    return "Use that first opener with one person before checking your phone.";
  }
  return "Ask one person what made them curious enough to show up.";
}

function sameQuestion(left, right) {
  return normalizeTitle(left) === normalizeTitle(right);
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

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlAttribute(value) {
  return escapeHtml(value).replace(/"/g, "&quot;");
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
    destination,
    travelmode: mode
  });
  if (origin) params.set("origin", origin);
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

function currentLocationMapsUrl(destination, mode) {
  return mapsUrl("", destination, mode);
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
    "/event_details 1 - show full prep and travel for a saved event",
    "/delete_event 1 - delete a saved event by number",
    "/delete_all_events - delete all saved events after confirmation",
    "/connect_calendar - connect Google Calendar",
    "/debug_calendar - show calendar events the bot can see near your latest saved event",
    "/settings - show current settings",
    "/help - show this message",
    "",
    "You can paste:",
    "- A Luma link",
    "- Event title, date, venue, and description",
    "- Any event invite text",
    "",
    "Source code:",
    "https://github.com/andykwleong/event-wingmate-bot"
  ].join("\n");
}

async function debugCalendarMessage(chatId, userId) {
  if (!isGoogleCalendarConfigured()) return "Google Calendar is not configured.";
  if (!useSupabase) return "Calendar debugging requires Supabase storage.";

  const connection = await readGoogleConnection(userId);
  if (!connection?.google_refresh_token) return "Google Calendar is not connected. Run /connect_calendar first.";

  const events = await readEventsForChat(chatId);
  const latestEvent = events.at(-1);
  if (!latestEvent) return "No saved event to debug yet. Paste the Luma link first, then run /debug_calendar.";

  try {
    const accessToken = await refreshGoogleAccessToken(connection.google_refresh_token);
    const calendars = await listGoogleCalendars(accessToken).catch((error) => {
      console.error("Calendar debug list failed, falling back to primary:", error.message);
      return [{ id: "primary", summary: "Primary" }];
    });
    const start = new Date(latestEvent.startsAt);
    const timeMin = new Date(start.getTime() - 6 * 60 * 60 * 1000).toISOString();
    const timeMax = new Date(start.getTime() + 12 * 60 * 60 * 1000).toISOString();
    const lines = [
      `Debugging calendar near: ${formatDateTime(latestEvent.startsAt)}`,
      `Looking for: ${formatTitle(latestEvent.title)}`,
      ""
    ];

    let shown = 0;
    for (const calendar of calendars.filter((calendar) => !calendar.hidden)) {
      const items = await fetchCalendarEvents(accessToken, calendar.id, { timeMin, timeMax }).catch((error) => {
        console.error(`Calendar debug failed for ${calendar.summary || calendar.id}:`, error.message);
        return [];
      });

      for (const item of items.slice(0, 5)) {
        shown += 1;
        lines.push(`Calendar: ${calendar.summary || calendar.id}`);
        lines.push(`Event: ${item.summary || "(no title)"}`);
        lines.push(`Time: ${formatDateTime(item.start?.dateTime || item.start?.date)}`);
        lines.push(`Location: ${item.location || "(no location returned)"}`);
        lines.push("");
        if (shown >= 10) break;
      }
      if (shown >= 10) break;
    }

    if (shown === 0) lines.push("No calendar events returned in that time window.");
    return lines.join("\n").trim();
  } catch (error) {
    return `Calendar debug failed: ${error.message}`;
  }
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

  return [
    "Upcoming events:",
    "",
    ...events.map((event, index) => [
      `${index + 1}. ${formatTitle(event.title)}`,
      `When: ${formatDateTime(event.startsAt)}`,
      `Where: ${shouldRouteToEventLocation(event) ? event.location : "Location has yet to be updated"}`
    ].join("\n")),
    "",
    "To delete one, send /delete_event followed by the number.",
    "To see full prep, send /event_details followed by the number.",
    "Examples: /delete_event 1 or /event_details 1"
  ].join("\n\n");
}

async function eventDetailsMessage(chatId, text) {
  const events = await readEventsForChat(chatId);
  if (events.length === 0) return "No saved events yet. Paste a Luma link or event text to add one.";

  const number = Number(text.match(/^\/events?_details\s+(\d+)$/)?.[1]);
  if (!Number.isInteger(number) || number < 1 || number > events.length) {
    return compactMessage([
      "Which event should I show?",
      "",
      ...events.map((event, index) => `${index + 1}. ${escapeHtml(formatTitle(event.title))} - ${escapeHtml(formatDateTime(event.startsAt))}`),
      "",
      "Send /event_details followed by the number.",
      "Example: /event_details 1"
    ]);
  }

  const event = events[number - 1];
  if (!hasTravelDetails(event) && shouldRouteToEventLocation(event)) {
    await enrichEventWithTravel(event);
  }

  return eventPrepMessage(event);
}

async function deleteEventMessage(chatId, text) {
  const events = await readEventsForChat(chatId);
  if (events.length === 0) return "No saved events to delete.";

  const number = Number(text.match(/^\/delete_event\s+(\d+)$/)?.[1]);
  if (!Number.isInteger(number) || number < 1 || number > events.length) {
    return [
      "Which event should I delete?",
      "",
      ...events.map((event, index) => `${index + 1}. ${formatTitle(event.title)} - ${formatDateTime(event.startsAt)}`),
      "",
      "Send /delete_event followed by the number.",
      "Example: /delete_event 1"
    ].join("\n");
  }

  const event = events[number - 1];
  const deletedCount = await deleteDuplicateEvents(event);
  return [
    deletedCount > 1 ? `Deleted ${deletedCount} duplicate copies of:` : "Deleted event:",
    `${formatTitle(event.title)}`,
    `${formatDateTime(event.startsAt)}`,
    "",
    "I will not send reminders for this event."
  ].join("\n");
}

async function deleteAllEventsMessage(chatId, text) {
  const events = await readEventsForChat(chatId);
  if (events.length === 0) return "No saved events to delete.";

  if (text !== "/delete_all_events confirm") {
    return [
      `This will delete ${events.length} saved event${events.length === 1 ? "" : "s"} and stop their reminders.`,
      "",
      "To confirm, send:",
      "/delete_all_events confirm"
    ].join("\n");
  }

  await deleteEventsForChat(chatId);
  return `Deleted ${events.length} saved event${events.length === 1 ? "" : "s"}.`;
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
    const networkingDueAt = event.networkingAt
      ? new Date(event.networkingAt).getTime() - 30 * 60 * 1000
      : startsAt + 30 * 60 * 1000;
    const dueReminders = [
      {
        key: "dayBefore",
        dueAt: startsAt - 24 * 60 * 60 * 1000,
        expiresAt: startsAt,
        buildMessage: async () => {
          await enrichEventWithTravel(event);
          return dayBeforeMessage(event);
        },
        options: {
          disable_web_page_preview: true,
          parse_mode: "HTML"
        }
      },
      {
        key: "leaveTime",
        dueAt: startsAt - 60 * 60 * 1000,
        expiresAt: startsAt,
        buildMessage: async () => leaveTimeMessage(event),
        options: {
          disable_web_page_preview: true,
          parse_mode: "HTML"
        }
      },
      {
        key: "networking",
        dueAt: networkingDueAt,
        expiresAt: Math.max(networkingDueAt + 2 * 60 * 60 * 1000, startsAt + 3 * 60 * 60 * 1000),
        buildMessage: async () => networkingMessage(event),
        options: {
          disable_web_page_preview: true,
          parse_mode: "HTML"
        }
      }
    ];

    for (const reminder of dueReminders) {
      const reminderKey = `${event.id}:${reminder.key}`;
      const alreadySent = event.reminders?.[reminder.key] || sentReminderKeys.has(reminderKey);
      const isDue = now >= reminder.dueAt && now < reminder.expiresAt;
      if (!alreadySent && isDue) {
        const message = await reminder.buildMessage();
        await sendMessage(event.chatId, message, reminder.options || { disable_web_page_preview: true });
        event.reminders = { ...event.reminders, [reminder.key]: true };
        sentReminderKeys.add(reminderKey);
        changed = true;
      }
    }
  }

  if (changed) await updateEvents(events);
}

function dayBeforeMessage(event) {
  const canRoute = shouldRouteToEventLocation(event);
  const transitUrl = canRoute ? mapsUrl(config.homeAddress, event.location, "transit") : "";
  const drivingUrl = canRoute ? mapsUrl(config.homeAddress, event.location, "driving") : "";
  const conversationStarters = event.prep?.conversationStarters || [];

  return compactMessage([
    `Tomorrow: ${escapeHtml(formatTitle(event.title))}`,
    `When: ${escapeHtml(formatDateTime(event.startsAt))}`,
    `Where: ${escapeHtml(canRoute ? event.location : "Location has yet to be updated")}`,
    "",
    event.summary ? "Event Summary:" : "",
    event.summary ? escapeHtml(event.summary) : "",
    event.url ? `Link: ${escapeHtml(event.url)}` : "",
    "",
    "Getting there:",
    ...travelLines(event, transitUrl, drivingUrl),
    "",
    conversationStarters.length ? "Easy openers:" : "",
    ...formatOpeners(conversationStarters),
    conversationStarters.length ? "" : "",
    "Tiny mission:",
    escapeHtml(missionQuestion(event))
  ]);
}

function leaveTimeMessage(event) {
  if (!shouldRouteToEventLocation(event)) {
    return [
      `Venue still missing for ${escapeHtml(formatTitle(event.title))}.`,
      "",
      "I cannot calculate travel time yet. Check the event page or calendar invite for the final location before leaving."
    ].join("\n");
  }

  const transitUrl = currentLocationMapsUrl(event.location, "transit");
  const drivingUrl = currentLocationMapsUrl(event.location, "driving");

  return [
    `Leave soon for ${escapeHtml(formatTitle(event.title))}.`,
    "",
    "Open from your current location:",
    `Public transport: <a href="${escapeHtmlAttribute(transitUrl)}">Here</a>`,
    `Car: <a href="${escapeHtmlAttribute(drivingUrl)}">Here</a>`,
    "",
    "Give yourself breathing room and arrive as the person who planned this nicely."
  ].join("\n");
}

function networkingMessage(event) {
  const conversationStarters = event.prep?.conversationStarters || [];
  const encouragement = randomEncouragement();

  return compactMessage([
    "Networking time.",
    "",
    escapeHtml(encouragement),
    "",
    conversationStarters.length ? "Easy openers:" : "",
    ...formatOpeners(conversationStarters),
    conversationStarters.length ? "" : "",
    "Tiny mission:",
    escapeHtml(missionQuestion(event))
  ]);
}

function randomEncouragement() {
  const messages = [
    "You made it here. Future you gets more from one small hello than from hiding by your phone.",
    "Tiny brave move time. One question, one person, then you can breathe.",
    "You do not need to become a networking person. Just be curious once.",
    "The room already did the hard part by gathering people with the same interest. Use that.",
    "No performance needed. Ask one real question and let that count."
  ];
  return messages[Math.floor(Math.random() * messages.length)];
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

async function findDuplicateEvent(event) {
  const fingerprint = eventFingerprint(event);

  if (useSupabase) {
    const query = new URLSearchParams({
      select: "*",
      telegram_chat_id: `eq.${event.chatId}`,
      order: "created_at.desc",
      limit: "25"
    });
    const rows = await supabaseRequest(`/rest/v1/events?${query.toString()}`);
    return rows.map(fromSupabaseEvent).find((savedEvent) => eventFingerprint(savedEvent) === fingerprint) || null;
  }

  const events = await readEvents();
  return events.find((savedEvent) => savedEvent.chatId === event.chatId && eventFingerprint(savedEvent) === fingerprint) || null;
}

function eventFingerprint(event) {
  const lumaSlug = event.url?.match(/luma\.com\/([^?/\s]+)/i)?.[1];
  if (lumaSlug) return `luma:${lumaSlug.toLowerCase()}`;

  const title = normalizeTitle(event.title);
  const date = new Date(event.startsAt).toISOString().slice(0, 16);
  return `event:${title}:${date}`;
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
      starts_at: `gte.${new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()}`,
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

async function updateEvent(event) {
  if (useSupabase) {
    await supabaseRequest(`/rest/v1/events?id=eq.${encodeURIComponent(event.id)}`, {
      method: "PATCH",
      body: toSupabaseEvent(event)
    });
    return;
  }

  const events = await readEvents();
  await writeEvents(events.map((savedEvent) => savedEvent.id === event.id ? event : savedEvent));
}

async function deleteEvent(event) {
  if (useSupabase) {
    await supabaseRequest(`/rest/v1/events?id=eq.${encodeURIComponent(event.id)}`, {
      method: "DELETE"
    });
    return;
  }

  const events = await readEvents();
  await writeEvents(events.filter((savedEvent) => savedEvent.id !== event.id));
}

async function deleteDuplicateEvents(event) {
  const fingerprint = eventFingerprint(event);

  if (useSupabase) {
    const query = new URLSearchParams({
      select: "*",
      telegram_chat_id: `eq.${event.chatId}`
    });
    const rows = await supabaseRequest(`/rest/v1/events?${query.toString()}`);
    const matchingEvents = rows.map(fromSupabaseEvent)
      .filter((savedEvent) => eventFingerprint(savedEvent) === fingerprint);

    for (const savedEvent of matchingEvents) {
      await deleteEvent(savedEvent);
    }
    return matchingEvents.length;
  }

  const events = await readEvents();
  const activeEvents = events.filter((savedEvent) => {
    return savedEvent.chatId !== event.chatId || eventFingerprint(savedEvent) !== fingerprint;
  });
  await writeEvents(activeEvents);
  return events.length - activeEvents.length;
}

async function deleteEventsForChat(chatId) {
  if (useSupabase) {
    await supabaseRequest(`/rest/v1/events?telegram_chat_id=eq.${encodeURIComponent(chatId)}`, {
      method: "DELETE"
    });
    return;
  }

  const events = await readEvents();
  await writeEvents(events.filter((savedEvent) => savedEvent.chatId !== chatId));
}

async function deleteExpiredEvents() {
  if (useSupabase) {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await supabaseRequest(`/rest/v1/events?delete_after=lt.${encodeURIComponent(new Date().toISOString())}`, {
      method: "DELETE"
    });
    await supabaseRequest(`/rest/v1/events?starts_at=lt.${encodeURIComponent(cutoff)}`, {
      method: "DELETE"
    });
    return;
  }

  const events = await readEvents();
  const activeEvents = events.filter((event) => {
    const deleteAfter = deleteAfterFor(event.startsAt);
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
    travel: {},
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
    travel: null,
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
