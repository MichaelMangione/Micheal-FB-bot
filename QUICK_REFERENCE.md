# Quick Reference Guide - Commands & Code Files

## ⚡ Most Common Commands

```bash
# First time setup
npm install                    # Install dependencies
node manual-login.js          # Login manually (saves session.json)

# Post one message
npm start                     # Post next message to all groups, then exit

# Continuous posting (with delays)
npm run daemon               # Posts all messages with 4-hour gaps between each

# Utilities
npm install --save-dev puppeteer  # If puppeteer missing
node test-captcha-key.js     # Test 2captcha API connection
```

---

## 📁 File Map: Where Is The Code?

| **What I Want To Do** | **File** | **Key Code** |
|---|---|---|
| Post a message | `src/index.js` | Lines 1-50: imports, then main posting logic |
| Schedule delays | `src/daemon.js` | Lines 50+: `runDaemon()` loop |
| Set credentials | `.env` | Line 1-9: FB_EMAIL, FB_PASSWORD, CAPTCHA_API_KEY |
| Change delays between posts | `schedule.json` | Line 2: `delayBetweenPostsMs` (in milliseconds) |
| Add/edit messages | `posts.json` | Array of posts with "id" and "text" |
| Track which posts sent | `.posting-state.json` | Auto-created, shows posted timestamps |
| Store login cookies | `session.json` | Auto-created, stores Facebook auth tokens |
| Manual login | `manual-login.js` | Run directly: `node manual-login.js` |
| Solve CAPTCHAs | `src/captcha.js` | `resolveCaptchasUntilClear()` function |
| Make bot human-like | `src/humanize.js` | `randomStepDelay()`, `humanType()` |
| Attach images | `src/media.js` | `uploadImageToComposer()` |

---

## 🔄 How The Flow Works (Step By Step)

### When You Run: `npm start`

1. **index.js** loads `.env` config
2. **config.js** validates all required settings exist
3. **scheduler.js** reads `posts.json` and `posting-state.json`
4. **Gets next unposted message** (if all done, exits)
5. **Launches Puppeteer browser** (visible or headless)
6. **session.js** restores cookies from `session.json` (if available)
7. **Auto-login if needed** (fills email/password if not logged in)
8. **For each group URL:**
   - Navigate to group
   - Click Composer
   - **humanize.js** types message with delays
   - **media.js** attaches random image
   - **captcha.js** solves CAPTCHA if appears
   - Click "Post"
9. **Saves session** back to `session.json`
10. **Updates .posting-state.json** (marks message as sent)
11. **Closes browser** - Done!

### When You Run: `npm run daemon`

1. **daemon.js** loads `schedule.json`
2. **Spawns index.js** as subprocess (posts once)
3. **Waits for delay** (e.g., 4 hours = 14400000 ms)
4. **Repeats until all posts sent**
5. Can safely stop with Ctrl+C - will resume from where it left off

---

## ⚙️ Key Configuration Values

### In `.env` File

```env
FB_EMAIL=your@email.com
FB_PASSWORD=yourpassword
CAPTCHA_API_KEY=yourapikey              # From 2captcha.com
TARGET_GROUP_URLS=url1,url2,url3        # Comma-separated
HEADLESS=false                          # false=show UI, true=hidden
SKIP_POST=false                         # false=actually post, true=fill only
RESET_POSTS=false                       # false=resume from state, true=start over
```

### In `schedule.json`

```json
"delayBetweenPostsMs": 14400000  // 4 hours
// Other common values:
// 300000 = 5 min (testing)
// 3600000 = 1 hour
// 10800000 = 3 hours
// 21600000 = 6 hours
```

---

## 📊 File Purposes (One Line Each)

| File | Purpose |
|------|---------|
| `src/index.js` | Post ONE message to all groups, then exit |
| `src/daemon.js` | Loop posting with delays until all messages posted |
| `src/config.js` | Load and validate .env settings |
| `src/scheduler.js` | Track which posts sent, manage post state |
| `src/session.js` | Handle Facebook login and cookie persistence |
| `src/captcha.js` | Auto-solve reCAPTCHA using 2captcha API |
| `src/humanize.js` | Make bot seem human (delays, mouse moves) |
| `src/media.js` | Attach random images to posts |
| `src/logger.js` | Logging utilities |
| `manual-login.js` | Interactive login tool (saves cookies) |
| `posts.json` | Array of 12 messages to post |
| `schedule.json` | Delays and daily limits for daemon |
| `.env` | Facebook credentials, API keys, target groups |
| `session.json` | Facebook cookies (auto-created) |
| `.posting-state.json` | Progress tracker (auto-created) |

---

## 🐛 Quick Fixes

| Problem | Solution |
|---------|----------|
| "Cannot find module" | Run `npm install` |
| Login fails repeatedly | Run `node manual-login.js` to refresh session |
| Daemon stops randomly | Check `schedule.json` - daily limit might be hit |
| CAPTCHA not solving | Verify `CAPTCHA_API_KEY` has balance on 2captcha.com |
| Posts not appearing | Check target group URLs are correct in `.env` |
| HEADLESS=true shows browser | You have HEADLESS=false in .env, change to true |

---

## 🔑 Important Variables in Code

### From config.js
```javascript
CAPTCHA_API_KEY        // Your 2captcha API key
FB_EMAIL               // Facebook login email
FB_PASSWORD            // Facebook login password  
TARGET_GROUP_URLS      // Array of group URLs to post to
POST_TEXT              // Message text
POST_IMAGE_DIR         // Folder with images
HEADLESS               // Browser visibility
SKIP_POST              // Test without posting
RESET_POSTS            // Ignore posting state
```

### From scheduler.js
```javascript
delayBetweenPostsMs    // Time between posts (milliseconds)
postsPerDay            // Max posts per 24 hours
enabled                // Is scheduling active?
```

### From session.js
```javascript
c_user                 // Main Facebook auth cookie
```

---

## 📈 Timeline For Posting All 12 Messages

With **4-hour delays** (default):
```
Post #1:  0h 00m
Post #2:  4h 00m  (wait 4h)
Post #3:  8h 00m  (wait 4h)
Post #4:  12h 00m (wait 4h)
Post #5:  16h 00m (wait 4h)
Post #6:  20h 00m (wait 4h)
Post #7:  24h 00m (wait 4h)
Post #8:  28h 00m (wait 4h)
Post #9:  32h 00m (wait 4h)
Post #10: 36h 00m (wait 4h)
Post #11: 40h 00m (wait 4h)
Post #12: 44h 00m (wait 4h)

TOTAL TIME: ~44 hours (1.8 days)
```

---

## 🚀 How To Change Delays

**Current: 4 hours between posts**

Edit `schedule.json` line 2:
```json
"delayBetweenPostsMs": 14400000
```

Replace number with:
- `300000` = 5 minutes
- `3600000` = 1 hour  
- `10800000` = 3 hours
- `14400000` = 4 hours ← Current
- `21600000` = 6 hours
- `28800000` = 8 hours

**Then run:**
```bash
npm run daemon
```

---

## 🔐 Security Checklist

- ✅ `.env` is in `.gitignore` (not committed)
- ✅ `session.json` is in `.gitignore` (not committed)
- ✅ `.posting-state.json` is in `.gitignore` (not committed)
- ✅ Never commit with credentials visible in code
- ✅ Rotate passwords/keys if ever exposed

---

## 📱 Typical Usage Pattern

```bash
# Day 1: Setup
npm install
node manual-login.js           # Establish session

# Day 2: Start posting
npm run daemon                 # Starts continuous posting
# Let it run in background, comes back to terminal after each post

# Monitor progress
cat .posting-state.json        # See which posts completed

# If you need to stop
Ctrl+C                         # Daemon stops, can restart anytime

# Resume next day
npm run daemon                 # Picks up where it left off
```

---

## 📞 Contact / Support

- **Facebook credentials fail?** → Run `node manual-login.js`
- **CAPTCHA failing?** → Check balance at 2captcha.com
- **Posts going to wrong groups?** → Verify `TARGET_GROUP_URLS` in `.env`
- **Session expired?** → Delete `session.json` and restart

