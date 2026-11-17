// PritLix Bot on Cloudflare Workers.
// Counts how many times the group has eaten with Felix and with Pritika.
// Flow: /start -> pick a person -> send the group picture as evidence -> counter goes up.
//
// Needs: secret BOT_TOKEN (from @BotFather) and a D1 database bound as DB.
// Open https://<your-worker-address>/setup once after deploying.

const PEOPLE = { felix: "Felix", pritika: "Pritika" };
const otherPerson = (key) => Object.keys(PEOPLE).find((k) => k !== key);

// ---------- Telegram helpers ----------

async function tg(env, method, payload) {
  const base = env.TELEGRAM_API || "https://api.telegram.org";
  const res = await fetch(`${base}/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({ ok: false }));
  if (!data.ok) console.log(`Telegram ${method} failed: ${JSON.stringify(data)}`);
  return data;
}

// Telegram sends this back with every update, so we know the request is really from Telegram.
async function webhookSecret(env) {
  const bytes = new TextEncoder().encode(`webhook:${env.BOT_TOKEN}`);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// One "clicked wrongly" button that moves the choice to the other person.
function changeKeyboard(action, currentKey, userId, mealId) {
  const other = otherPerson(currentKey);
  return {
    inline_keyboard: [[{
      text: `Clicked wrongly? Change to ${PEOPLE[other]}`,
      callback_data: `${action}:${mealId ?? other}:${userId}`,
    }]],
  };
}

// ---------- storage ----------

async function getCounts(env, chatId) {
  const { results } = await env.DB
    .prepare("SELECT person, COUNT(*) AS n FROM meals WHERE chat_id = ? GROUP BY person")
    .bind(chatId)
    .all();
  return Object.fromEntries(results.map((r) => [r.person, r.n]));
}

function countsText(counts) {
  return Object.entries(PEOPLE)
    .map(([key, name]) => `🍽 With ${name}: ${counts[key] ?? 0}`)
    .join("\n");
}

// ---------- messages ----------

async function onMessage(env, message) {
  const chatId = message.chat.id;
  const user = message.from;

  if (message.photo) return onPhoto(env, message);

  const command = (message.text || "").split(/\s/)[0].split("@")[0].toLowerCase();

  if (command === "/start" || command === "/ate") {
    return tg(env, "sendMessage", {
      chat_id: chatId,
      text: "Who did you eat with?",
      reply_markup: {
        inline_keyboard: [
          Object.entries(PEOPLE).map(([key, name]) => ({ text: name, callback_data: `ate:${key}` })),
        ],
      },
    });
  }

  if (command === "/count") {
    return tg(env, "sendMessage", { chat_id: chatId, text: countsText(await getCounts(env, chatId)) });
  }

  if (command === "/cancel") {
    const removed = await env.DB
      .prepare("DELETE FROM pending WHERE chat_id = ? AND user_id = ? RETURNING person")
      .bind(chatId, user.id)
      .first();
    return tg(env, "sendMessage", {
      chat_id: chatId,
      reply_parameters: { message_id: message.message_id },
      text: removed ? "Cancelled. Nothing was counted." : "Nothing to cancel.",
    });
  }
}

async function onPhoto(env, message) {
  const chatId = message.chat.id;
  const user = message.from;
  const reply = { chat_id: chatId, reply_parameters: { message_id: message.message_id } };

  // Take the waiting choice (if any) in one step so a repeated delivery cannot count twice.
  const state = await env.DB
    .prepare("DELETE FROM pending WHERE chat_id = ? AND user_id = ? RETURNING person, choice_msg_id")
    .bind(chatId, user.id)
    .first();
  if (!state) {
    if (message.chat.type === "private") {
      await tg(env, "sendMessage", { ...reply, text: "Use /start first and pick who you ate with." });
    }
    return;
  }

  const key = state.person;
  const photo = message.photo[message.photo.length - 1]; // largest size
  let mealId;
  try {
    const row = await env.DB
      .prepare("INSERT INTO meals (chat_id, person, added_by, photo_file_id) VALUES (?, ?, ?, ?) RETURNING id")
      .bind(chatId, key, user.first_name, photo.file_id)
      .first();
    mealId = row.id;
  } catch (err) {
    console.log(`Could not record meal: ${err}`);
    await env.DB
      .prepare("INSERT OR REPLACE INTO pending (chat_id, user_id, person, choice_msg_id) VALUES (?, ?, ?, ?)")
      .bind(chatId, user.id, key, state.choice_msg_id)
      .run();
    return tg(env, "sendMessage", { ...reply, text: "⚠️ Could not save that just now. Please send the photo again." });
  }

  // The change button now lives on the confirmation, so drop the earlier one.
  await tg(env, "editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: state.choice_msg_id,
    reply_markup: { inline_keyboard: [] },
  });

  return tg(env, "sendMessage", {
    ...reply,
    text: `✅ Evidence accepted! Meal with ${PEOPLE[key]} counted.\n\n${countsText(await getCounts(env, chatId))}`,
    reply_markup: changeKeyboard("fix", key, user.id, mealId),
  });
}

// ---------- button presses ----------

async function onCallback(env, call) {
  const [action, value, owner] = (call.data || "").split(":");
  const chatId = call.message.chat.id;
  const messageId = call.message.message_id;
  const user = call.from;
  const answer = (text, alert = false) =>
    tg(env, "answerCallbackQuery", { callback_query_id: call.id, text, show_alert: alert });

  if (action === "ate") {
    if (!PEOPLE[value]) return answer("Unknown option.");
    await env.DB
      .prepare(
        "INSERT INTO pending (chat_id, user_id, person, choice_msg_id) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT (chat_id, user_id) DO UPDATE SET person = excluded.person, choice_msg_id = excluded.choice_msg_id"
      )
      .bind(chatId, user.id, value, messageId)
      .run();
    await answer();
    await tg(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: `${user.first_name} ate with ${PEOPLE[value]}.`,
      reply_markup: changeKeyboard("swap", value, user.id),
    });
    // ForceReply makes the photo a reply to the bot, so it is delivered even
    // when the bot has group privacy mode enabled.
    return tg(env, "sendMessage", {
      chat_id: chatId,
      text: `📸 ${user.first_name}, send the group picture as evidence (reply to this message with the photo).`,
      reply_markup: { force_reply: true },
    });
  }

  if (action !== "swap" && action !== "fix") return answer();

  // Only the person who made the choice may change it.
  if (String(user.id) !== owner) {
    return answer("Only the person who picked can change this.", true);
  }

  if (action === "swap") {
    if (!PEOPLE[value]) return answer("Unknown option.");
    const row = await env.DB
      .prepare(
        "UPDATE pending SET person = ? WHERE chat_id = ? AND user_id = ? AND choice_msg_id = ? RETURNING person"
      )
      .bind(value, chatId, user.id, messageId)
      .first();
    if (!row) return answer("This one is no longer waiting for a photo.", true);
    await tg(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: `${user.first_name} ate with ${PEOPLE[value]}.`,
      reply_markup: changeKeyboard("swap", value, user.id),
    });
    return answer(`Changed to ${PEOPLE[value]}.`);
  }

  // action === "fix": move an already counted meal to the other person
  const [first, second] = Object.keys(PEOPLE);
  const row = await env.DB
    .prepare(
      "UPDATE meals SET person = CASE WHEN person = ? THEN ? ELSE ? END " +
      "WHERE id = ? AND chat_id = ? RETURNING person"
    )
    .bind(first, second, first, Number(value), chatId)
    .first();
  if (!row) return answer("Could not find that meal.", true);
  await tg(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: `✏️ Changed: this meal now counts with ${PEOPLE[row.person]}.\n\n${countsText(await getCounts(env, chatId))}`,
    reply_markup: changeKeyboard("fix", row.person, user.id, value),
  });
  return answer(`Changed to ${PEOPLE[row.person]}.`);
}

// ---------- one-time setup: create tables and point Telegram at this worker ----------

async function setup(env, origin) {
  await env.DB.batch([
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS meals (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, person TEXT NOT NULL, " +
      "eaten_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, added_by TEXT, photo_file_id TEXT NOT NULL)"
    ),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS pending (" +
      "chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL, person TEXT NOT NULL, " +
      "choice_msg_id INTEGER NOT NULL, PRIMARY KEY (chat_id, user_id))"
    ),
  ]);
  const hook = await tg(env, "setWebhook", {
    url: `${origin}/webhook`,
    secret_token: await webhookSecret(env),
    allowed_updates: ["message", "callback_query"],
  });
  await tg(env, "setMyCommands", {
    commands: [
      { command: "start", description: "Log a meal with Felix or Pritika" },
      { command: "count", description: "Show the totals" },
      { command: "cancel", description: "Cancel a meal you have not sent a photo for" },
    ],
  });
  return hook.ok
    ? "Setup done. The bot is live - send /start to it in Telegram."
    : `Setup failed: ${JSON.stringify(hook)}. Check that BOT_TOKEN is set correctly.`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!env.BOT_TOKEN) {
      return new Response("BOT_TOKEN is not set. Run: npx wrangler secret put BOT_TOKEN", { status: 500 });
    }

    if (url.pathname === "/setup") {
      return new Response(await setup(env, url.origin));
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== (await webhookSecret(env))) {
        return new Response("Forbidden", { status: 403 });
      }
      try {
        const update = await request.json();
        if (update.message) await onMessage(env, update.message);
        else if (update.callback_query) await onCallback(env, update.callback_query);
      } catch (err) {
        console.log(`Update failed: ${err && err.stack ? err.stack : err}`);
      }
      // Always 200 so Telegram does not keep re-sending the same update.
      return new Response("ok");
    }

    return new Response("PritLix Bot is running");
  },
};
