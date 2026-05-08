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
  port: Number(env.PORT || 3000)
};

if (!config.token) {
  console.error("Missing TELEGRAM_BOT_TOKEN. Copy .env.example to .env and add your BotFather token.");
  process.exit(1);
}

const apiBase = `https://api.telegram.org/bot${config.token}`;
let lastUpdateId = 0;
const sentReminderKeys = new Set();

await ensureDataFile();
startHealthServer();
scheduleReminderLoop();
console.log("Event Wingmate bot is running.");
await pollForever();

function loadEnv() {
  const parsed = { ...process.env };
  readSettingsFileInto(parsed, "bot-settings.txt");
  readSettingsFileInto(parsed, ".env");
  return parsed;
}

function startHealthServer() {
  const server = http.createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, service: "event-wingmate" }));
      return;
    }

    response.writeHead(200, { "content-type": "text/plain" });
    response.end("Event Wingmate bot is running.\n");
  });

  server.listen(config.port, () => {
    console.log(`Health server listening on port ${config.port}.`);
  });
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

  if (text === "/settings") {
    await sendMessage(chatId, settingsMessage(userId));
    return;
  }

  if (text === "/events") {
    await sendMessage(chatId, await eventsMessage(chatId));
    return;
  }

  const event = parseEvent(text, chatId);
  const events = await readEvents();
  events.push(event);
  await writeEvents(events);

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

function parseEvent(text, chatId) {
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
    title,
    url,
    rawText: text,
    location,
    eventType,
    startsAt,
    createdAt: new Date().toISOString(),
    reminders: {
      dayBefore: false,
      leaveTime: false,
      networking: false
    }
  };
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
  if (atMatch) return atMatch[1].trim();

  return "Venue to confirm";
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
  const transitUrl = mapsUrl(config.homeAddress, event.location, "transit");
  const drivingUrl = mapsUrl(config.homeAddress, event.location, "driving");
  const talkingPoints = talkingPointsFor(event.eventType);
  const starts = formatDateTime(event.startsAt);

  return [
    `Saved: ${event.title}`,
    "",
    `When: ${starts}`,
    `Where: ${event.location}`,
    `Type: ${event.eventType}`,
    event.url ? `Link: ${event.url}` : "",
    "",
    "Getting there:",
    `Public transport: ${transitUrl}`,
    `Car: ${drivingUrl}`,
    "",
    "Your introvert prep:",
    ...talkingPoints.map((point) => `- ${point}`),
    "",
    "Tiny mission:",
    "Talk to one person before checking your phone. Ask one follow-up question. That counts."
  ].filter(Boolean).join("\n");
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
    "/settings - show current settings",
    "/help - show this message",
    "",
    "You can paste:",
    "- A Luma link",
    "- Event title, date, venue, and description",
    "- Any event invite text"
  ].join("\n");
}

function settingsMessage(userId) {
  return [
    "Current settings:",
    `Home address: ${config.homeAddress}`,
    `Timezone: ${config.timezone}`,
    `Your Telegram user ID: ${userId}`,
    `Locked to user ID: ${config.allowedUserId || "first /start user"}`,
    `Storage: ${config.dataFile}`
  ].join("\n");
}

async function eventsMessage(chatId) {
  const events = (await readEvents()).filter((event) => event.chatId === chatId);
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
  const events = await readEvents();
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
        dueAt: startsAt + 30 * 60 * 1000,
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

  if (changed) await writeEvents(events);
}

function dayBeforeMessage(event) {
  return [
    `Tomorrow: ${event.title}`,
    "",
    `Venue: ${event.location}`,
    `Public transport: ${mapsUrl(config.homeAddress, event.location, "transit")}`,
    "",
    "Pick one opener now so your future self has less to carry:",
    talkingPointsFor(event.eventType)[0]
  ].join("\n");
}

function leaveTimeMessage(event) {
  return [
    `Leave soon for ${event.title}.`,
    "",
    "Check the route now, give yourself breathing room, and arrive as the person who planned this nicely.",
    mapsUrl(config.homeAddress, event.location, "transit")
  ].join("\n");
}

function networkingMessage(event) {
  return [
    "Networking time.",
    "",
    "You are already there. The hard part is done. Say hi to one person, ask what brought them here, and stay for one honest answer."
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

async function ensureDataFile() {
  await fs.mkdir(path.dirname(config.dataFile), { recursive: true });
  try {
    await fs.access(config.dataFile);
  } catch {
    await fs.writeFile(config.dataFile, "[]\n", "utf8");
  }
}

async function readOwnerId() {
  try {
    const ownerFile = ownerFilePath();
    return (await fs.readFile(ownerFile, "utf8")).trim();
  } catch {
    return "";
  }
}

async function writeOwnerId(userId) {
  const ownerFile = ownerFilePath();
  await fs.mkdir(path.dirname(ownerFile), { recursive: true });
  await fs.writeFile(ownerFile, `${userId}\n`, "utf8");
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

function formatDateTime(isoString) {
  return new Intl.DateTimeFormat("en-SG", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: config.timezone
  }).format(new Date(isoString));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
