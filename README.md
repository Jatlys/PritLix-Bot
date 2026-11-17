# PritLix Bot

Our dear friend felix decided to make a bet of $100 that the group will be eating together with Pritika less than himself under the premise that she is finally back in SG but he is away on SUSEP during our final term together in SUTD. So, to put this friendship to the test, I made a simple telegram bot counter using wrangler tool (cloudfare). This is basically a Telegram bot that counts how many times the group has eaten with Felix and with Pritika. It runs on Cloudflare Workers and stores its data in a D1 database.

## How it works

1. Send `/start` and pick who you ate with.
2. Reply to the bot's message with the group picture as evidence.
3. The meal is counted and the bot shows the new totals.

If you picked the wrong person, press the "Clicked wrongly?" button to switch. Only the person who made the choice can change it.

## Commands

| Command | What it does |
| --- | --- |
| `/start` | Log a meal with Felix or Pritika |
| `/count` | Show the totals |
| `/cancel` | Cancel a meal you have not sent a photo for |

Each chat has its own totals.

## Setup

You need a Cloudflare account, Node.js, and a bot token from [@BotFather](https://t.me/BotFather).

1. Install the dependencies:

   ```sh
   npm install
   ```

2. Create the D1 database and put its ID in `wrangler.jsonc` under `database_id`:

   ```sh
   npx wrangler d1 create pritlix-bot
   ```

3. Save the bot token as a secret:

   ```sh
   npx wrangler secret put BOT_TOKEN
   ```

4. Deploy:

   ```sh
   npm run deploy
   ```

5. Open `https://<your-worker-address>/setup` once in a browser. This creates the database tables, registers the commands, and points Telegram at the worker.

## Local development

Put the token in a `.dev.vars` file (it is ignored by git):

```
BOT_TOKEN=123456:your-token
```

Then run:

```sh
npx wrangler dev
```

## Project layout

- `src/index.js`: the whole bot (Telegram handlers, storage, and setup)
- `wrangler.jsonc`: Worker configuration and the D1 binding
