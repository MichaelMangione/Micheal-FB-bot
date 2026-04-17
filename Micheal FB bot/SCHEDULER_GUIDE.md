# Facebook Bot Posting Scheduler

This document explains how to use the automated posting scheduler for your Facebook bot.

## Overview

The bot now supports two modes of operation:

1. **Single Post Mode** — Post one message via the `POST_TEXT` environment variable
2. **Scheduled Posting Mode** — Automatically post multiple messages over time with configurable delays

## Quick Start

### 1. Add Your Posts

Edit `posts.json` and add your 12 posts (already included by default):

```json
[
  {
    "id": 1,
    "text": "Your post content here..."
  },
  {
    "id": 2,
    "text": "Second post..."
  }
]
```

### 2. Configure Scheduling

Edit `schedule.json`:

```json
{
  "scheduling": {
    "delayBetweenPostsMs": 14400000,
    "postsPerDay": 5,
    "enabled": true,
    "mode": "interval"
  }
}
```

**Settings:**
- `delayBetweenPostsMs`: Milliseconds between posts
  - `10800000` = 3 hours
  - `14400000` = 4 hours (default)
  - `28800000` = 8 hours
- `postsPerDay`: Maximum posts per 24-hour period (0 = unlimited)
- `enabled`: Set to `false` to disable scheduling and use `POST_TEXT` instead

### 3. Run the Daemon

```bash
# Single post (uses POST_TEXT from .env)
npm start

# Or post one scheduled message and exit
node src/index.js

# Or run full daemon with all scheduled posts and delays
node src/daemon.js
```

## Operation Modes

### Mode 1: Single Post (Default existing behavior)

**Use this if:** You want to post once using `POST_TEXT` environment variable

**Configuration:**
```bash
# In .env
POST_TEXT="Your message here"
SKIP_POST=false  # Set to true to draft, false to publish
```

**Run:**
```bash
npm start
```

### Mode 2: Next Scheduled Post

**Use this if:** You want to post the next unposted message from `posts.json`

**Configuration:**
```json
// schedule.json
{
  "scheduling": {
    "enabled": true,
    "delayBetweenPostsMs": 14400000,
    "postsPerDay": 5
  }
}
```

**Run:**
```bash
node src/index.js
```

The bot will:
1. Load posts from `posts.json`
2. Find the next unposted message
3. Post it to all groups in `TARGET_GROUP_URLS`
4. Save state to `.posting-state.json`
5. Exit

### Mode 3: Full Daemon (Recommended)

**Use this if:** You want to post all messages automatically with delays

**Configuration:**
Same as Mode 2, plus ensure `delayBetweenPostsMs` is set appropriately

**Run:**
```bash
node src/daemon.js
```

The daemon will:
1. Post the next message to all groups
2. Wait for `delayBetweenPostsMs` (e.g., 4 hours)
3. Post the next message
4. Repeat until all posts are done
5. Log countdown messages periodically

**Keep it running:**
- Run in a terminal multiplexer (`tmux`, `screen`)
- Run as a background service
- Run in a container
- Use a process manager like `pm2`:

```bash
npm install -g pm2
pm2 start src/daemon.js --name fb-bot
pm2 logs fb-bot
pm2 stop fb-bot
```

## File Structure

```
├── posts.json              # Your posts (array of {id, text})
├── schedule.json           # Scheduling configuration
├── .posting-state.json     # Auto-generated: tracks progress
├── .env                    # Your credentials and settings
└── src/
    ├── daemon.js          # Continuous posting daemon
    ├── scheduler.js       # Scheduling utilities
    └── index.js           # Main bot (updated with scheduling)
```

## Posting State

The `.posting-state.json` file tracks progress:

```json
{
  "lastPostTime": 1234567890000,
  "postsInLast24h": 3,
  "lastResetTime": 1234567890000,
  "completedPostIds": [1, 2, 3]
}
```

**To reset:** Delete `.posting-state.json` and posts will be reposted (respecting daily limits).

## Daily Limits

Set `postsPerDay` to limit your posting:

```json
{
  "scheduling": {
    "postsPerDay": 5
  }
}
```

The bot will:
1. Track posts in the last 24 hours
2. Stop posting if the limit is reached
3. Resume 24 hours after the first post
4. Never exceed the daily limit

## Delay Examples

| Delay | Configuration |
|-------|---------------|
| 1 hour | `3600000` |
| 2 hours | `7200000` |
| 3 hours | `10800000` |
| 4 hours | `14400000` |
| 6 hours | `21600000` |
| 8 hours | `28800000` |
| 12 hours | `43200000` |
| 24 hours | `86400000` |

## Troubleshooting

### Posts not posting?
- Check `.env` — ensure `TARGET_GROUP_URLS` and `CAPTCHA_API_KEY` are set
- Set `SKIP_POST=false` in `.env`
- Check console output for errors

### Only 5 posts per day?
This is the `postsPerDay` limit. Change in `schedule.json`:
```json
{
  "scheduling": {
    "postsPerDay": 0
  }
}
```

### Want to repost all messages?
```bash
rm .posting-state.json
node src/daemon.js
```

### Daemon keeps stopping?
- Run in `tmux` or `pm2` to keep it running
- Check for network errors in logs
- Increase `PAUSE_AFTER_COMPOSE_MS` if Facebook throttles you

## Advanced: Custom Post Scheduling

To post at specific times instead of fixed intervals, edit `schedule.json`:

```json
{
  "scheduling": {
    "mode": "cron",
    "schedule": ["09:00", "13:00", "18:00"]
  }
}
```

*(This feature can be implemented on request)*

## Environment Variables

Required:
- `TARGET_GROUP_URLS` — Comma-separated Facebook group URLs
- `CAPTCHA_API_KEY` — Your 2captcha API key

Optional:
- `POST_TEXT` — Single post text (overrides `posts.json`)
- `SKIP_POST` — Set to `true` to draft (don't publish)
- `HEADLESS` — Set to `false` to see the browser
- `PAUSE_AFTER_COMPOSE_MS` — Wait time before clicking Post (default: 5000)

See `.env.example` for all options.

## Support

Need help?
- Check the console output for detailed logs
- Verify `.env` configuration
- Ensure posts.json is valid JSON
- Check network/Facebook status
