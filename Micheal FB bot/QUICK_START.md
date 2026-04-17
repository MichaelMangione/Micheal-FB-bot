# Quick Start Guide - Your 12 Apartment Posts

## What's Included

✅ **posts.json** — All 12 apartment posts ready to post  
✅ **schedule.json** — Configuration for 4-hour delays & 5 posts/day  
✅ **scheduler.js** — Automatic scheduling system  
✅ **daemon.js** — Continuous posting daemon  

## How to Use

### Option 1: Post All 12 Posts Automatically (Recommended)

**Step 1:** Make sure your `.env` is configured:
```bash
TARGET_GROUP_URLS=https://www.facebook.com/groups/XXXXX,https://www.facebook.com/groups/YYYYY
CAPTCHA_API_KEY=your_2captcha_key_here
SKIP_POST=false
```

**Step 2:** Start the daemon:
```bash
npm run daemon
```

This will:
- Post Post #1 to all groups
- Wait 4 hours
- Post Post #2 to all groups
- Wait 4 hours
- ... repeat until all 12 posts are done

**Total time:** ~44 hours (with 4-hour delays)

---

### Option 2: Post One Message at a Time

If you want to manually control when to post each message:

```bash
npm start
```

This posts the next unposted message and exits. Run it again later to post the next one.

---

### Option 3: Post with Different Delays

**Edit `schedule.json`:**

```json
{
  "scheduling": {
    "delayBetweenPostsMs": 10800000,
    "postsPerDay": 5,
    "enabled": true,
    "mode": "interval"
  }
}
```

Then run the daemon:
```bash
npm run daemon
```

**Common delays:**
- `10800000` = 3 hours
- `14400000` = 4 hours (current)
- `21600000` = 6 hours
- `28800000` = 8 hours

---

### Option 4: Post All 12 in One Day (No Wait)

**Edit `schedule.json`:**

```json
{
  "scheduling": {
    "delayBetweenPostsMs": 300000,
    "postsPerDay": 0,
    "enabled": true,
    "mode": "interval"
  }
}
```

**Then:**
```bash
npm run daemon
```

This will post all 12 messages with just 5 minutes between them (in ~1 hour).

---

## Monitoring Progress

### View posted messages:
```bash
cat .posting-state.json
```

You'll see:
```json
{
  "completedPostIds": [1, 2, 3],
  "postsInLast24h": 3,
  "lastPostTime": 1712498765000,
  "lastResetTime": 1712412765000
}
```

### Repost everything (reset):
```bash
rm .posting-state.json
npm run daemon
```

---

## Running in Background

### On Windows:
```bash
# Start in new window
start npm run daemon
```

### On Mac/Linux:
```bash
# Keep running if terminal closes
nohup npm run daemon &

# Or use tmux
tmux new-session -d -s fb-bot "npm run daemon"
tmux attach-session -t fb-bot
```

### Using PM2 (recommended):
```bash
npm install -g pm2

# Start
pm2 start src/daemon.js --name "fb-bot"

# View logs
pm2 logs fb-bot

# Stop
pm2 stop fb-bot

# Restart (useful after code changes)
pm2 restart fb-bot
```

---

## Customizing Your Posts

### Add or remove posts:

Edit `posts.json`:
```json
[
  {
    "id": 1,
    "text": "Post 1 text..."
  },
  {
    "id": 2,
    "text": "Post 2 text..."
  }
]
```

The `id` must be unique. When the daemon runs, it skips any posts already in the `completedPostIds` list.

### Change post text:

Simply edit the `text` field in `posts.json` and restart.

---

## Default Configuration

Your current setup:
- ✅ 12 posts loaded from `posts.json`
- ✅ 4-hour delay between posts
- ✅ 5 posts maximum per day
- ✅ Continuous daemon mode ready

**To start:** `npm run daemon`

---

## Troubleshooting

### "No posts to post"
- Check that `posts.json` exists and is valid JSON
- Check `.posting-state.json` isn't marking all as complete

### "Missing required env vars"
- Set `TARGET_GROUP_URLS` in `.env`
- Set `CAPTCHA_API_KEY` in `.env`
- See `.env.example` for all options

### Daemon keeps restarting
- Check console for errors
- Try stopping and restarting: `Ctrl+C`, then `npm run daemon`
- Increase `PAUSE_AFTER_COMPOSE_MS` in `.env` if Facebook throttles

### Want to draft before posting?
- Set `SKIP_POST=true` in `.env`
- Browser will show draft, you can manually click Post
- Set `WAIT_FOR_ENTER_BEFORE_CLOSE=true` to wait for you

---

## Support Files

- `SCHEDULER_GUIDE.md` — Detailed documentation
- `posts.json` — Your 12 posts
- `schedule.json` — Timing configuration
- `.posting-state.json` — Auto-generated progress tracker
- `src/scheduler.js` — Scheduling engine
- `src/daemon.js` — The daemon script

Need help? Check `SCHEDULER_GUIDE.md` for details.
