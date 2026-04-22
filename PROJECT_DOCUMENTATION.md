# Facebook Bot Project Documentation

## Project Overview

**Name:** facebook-automation-bot  
**Version:** 1.0.0  
**Description:** Automated Facebook group post scheduling using a headless browser with session persistence, CAPTCHA solving via 2captcha API, and intelligent scheduling

**Main Purpose:** Posts apartment rental listings to multiple Facebook groups automatically with configurable delays between posts

---

## How The Project Runs

### Execution Flow Diagram

```
User runs command
    ↓
├─→ npm start (Single Post)
│   └─→ src/index.js
│       ├─→ Load config from .env
│       ├─→ Launch Puppeteer browser
│       ├─→ Restore/create Facebook session (cookies)
│       ├─→ Navigate to first target group
│       ├─→ Compose and post message
│       └─→ Close browser
│
└─→ npm run daemon (Continuous Scheduling)
    └─→ src/daemon.js
        ├─→ Loop until all posts complete:
        │   ├─→ Run index.js (spawn subprocess)
        │   ├─→ Wait for delay (e.g., 4 hours)
        │   ├─→ Check daily limits
        │   ├─→ Repeat
        └─→ Updates .posting-state.json with progress
```

---

## Main Commands & Scripts

### From package.json

```bash
npm start              # Run src/index.js - Posts ONE message to all groups, then exits
npm run daemon         # Run src/daemon.js - Continuous posting with scheduling/delays
npm run post-one       # Alias for npm start
npm run post-all       # Alias for npm run daemon
npm install            # Install dependencies
npm install --save-dev puppeteer  # Install puppeteer if missing
```

### Manual Testing Commands

```bash
node manual-login.js   # Interactive login to establish fresh session cookies
node src/index.js      # Same as npm start
node src/daemon.js     # Same as npm run daemon
```

---

## Project Structure & Key Files

### Root Configuration Files

| File | Purpose |
|------|---------|
| `.env` | **SECRETS** - Facebook credentials, API keys, target groups (GITIGNORED) |
| `.env.example` | Template showing all required/optional env variables |
| `package.json` | Node.js project metadata, scripts, dependencies |
| `posts.json` | Array of 12 apartment posts (text content) to post |
| `schedule.json` | Scheduling config (delays, daily limits) |
| `session.json` | Stored Facebook cookies for persistent login (GITIGNORED) |
| `.posting-state.json` | Tracks which posts have been sent (auto-created) |
| `manual-login.js` | Interactive script to establish fresh login session |
| `test-captcha-key.js` | Console tool to test CAPTCHA API connectivity |
| `Dockerfile` | Docker container configuration (for headless deployment) |

### Source Code Files (`src/`)

#### 1. **index.js** (Main Posting Script)
- **Purpose:** Post one message to all target Facebook groups
- **Flow:**
  1. Validates environment config
  2. Loads posts from `posts.json`
  3. Gets next unposted message from scheduler
  4. Launches Puppeteer browser (visible or headless)
  5. Restores Facebook session cookies if available
  6. Auto-logs in if session expired
  7. For each target group URL:
     - Navigates to the group
     - Opens composer dialog
     - Types message text
     - Attaches random image (optional)
     - Solves CAPTCHA with 2captcha API if needed
     - Clicks "Post" button
  8. Saves updated session cookies
  9. Updates posting state (marks post as sent)
  10. Closes browser
- **Key Functions:**
  - `autoLoginIfNeeded()` - Auto-fill login form if not already logged in
  - `postToGroup(url)` - Handles full posting workflow for one group
  - `saveSessionCookies()` - Persists Facebook auth cookies to disk

#### 2. **daemon.js** (Scheduling & Looping)
- **Purpose:** Run index.js repeatedly with delays, respecting schedule config
- **Flow:**
  1. Loads schedule config (delays, daily limits)
  2. Spawns `index.js` as subprocess
  3. Waits for configured delay (e.g., 4 hours)
  4. Checks if can post again (daily limits)
  5. Repeats until all posts complete
- **Respects:**
  - `delayBetweenPostsMs` - Time to wait between posting
  - `postsPerDay` - Max posts per 24-hour window
  - `enabled` - Toggle scheduling on/off
- **Output:** Logs to console + updates `.posting-state.json`

#### 3. **config.js** (Environment Management)
- **Purpose:** Load and validate all configuration from .env file
- **Exported Variables:**
  ```javascript
  CAPTCHA_API_KEY        // 2captcha.com API key
  FB_EMAIL               // Facebook login email
  FB_PASSWORD            // Facebook login password
  HEADLESS               // true = headless browser, false = show UI
  TARGET_GROUP_URLS      // Comma-separated Facebook group URLs
  POST_TEXT              // Message text (fallback if no posts.json)
  POST_IMAGE_DIR         // Folder with images to attach (optional)
  SKIP_POST              // true = fill composer but DON'T click Post (testing)
  WAIT_FOR_ENTER_BEFORE_CLOSE  // Pause before closing (keep dialog open)
  PAUSE_AFTER_COMPOSE_MS // Delay after typing (let user see before posting)
  RESET_POSTS            // true = ignore .posting-state.json, start fresh
  SESSION_FILE           // Path to session.json
  USER_DATA_DIR          // Path to .fb-profile/ (browser data)
  ```
- **Validation:** Throws error if required vars missing

#### 4. **scheduler.js** (Post Management & State)
- **Purpose:** Load posts, track posting progress, manage delays
- **Key Functions:**
  - `loadPosts()` - Parse posts.json into array
  - `loadScheduleConfig()` - Load schedule.json with defaults
  - `loadPostingState()` - Load/create .posting-state.json
  - `getNextPost()` - Get the first unposted message
  - `updateStateAfterPost()` - Mark post as sent
  - `canPostAccordingToLimit()` - Check daily post limit
  - `formatDelay()` - Convert ms to readable format (e.g., "4h 2m")
- **Data Structure (posts.json):**
  ```json
  [
    {
      "id": 1,
      "text": "Message text here..."
    },
    ...
  ]
  ```
- **Data Structure (.posting-state.json - auto-created):**
  ```json
  [
    { "id": 1, "postedAt": "2026-04-21T10:30:00Z", "groups": 18 },
    { "id": 2, "postedAt": "2026-04-21T14:30:00Z", "groups": 18 }
  ]
  ```

#### 5. **session.js** (Facebook Authentication & Cookies)
- **Purpose:** Manage Facebook login and session persistence
- **Key Functions:**
  - `loadSessionFromDisk()` - Read session.json cookies
  - `saveSessionCookies()` - Write cookies to session.json
  - `hasUserCookie()` - Check if `c_user` cookie present (logged in)
  - `isLoginOrCheckpointUrl()` - Detect if on login/checkpoint page
  - `collectFacebookCookies()` - Gather all FB cookies from browser
  - `waitUntilLoggedIn()` - Block until logged in or manual intervention
  - `ensureFreshLogin()` - Force fresh login (use manual-login.js instead)
  - `waitForEnter()` - Pause for user input before closing
- **How It Works:**
  1. Checks if session.json has cookies from previous run
  2. If yes: restores cookies to browser (skips login)
  3. If no or expired: triggers auto-login flow
  4. After post: saves all cookies for next run

#### 6. **captcha.js** (CAPTCHA Solving via 2captcha API)
- **Purpose:** Automatically solve reCAPTCHA v2 if Facebook requires it
- **Key Functions:**
  - `submitRecaptchaV2(apiKey, siteKey, pageUrl)` - Submit captcha to 2captcha
  - `pollCaptchaResult(apiKey, taskId)` - Poll for solution (up to 3 min)
  - `resolveCaptchasUntilClear()` - Loop until all CAPTCHAs solved
- **Flow:**
  1. Detects reCAPTCHA iframe on page
  2. Extracts siteKey and page URL
  3. Posts to 2captcha.com API
  4. Polls for solution every 4 seconds
  5. Injects solution into reCAPTCHA callback
  6. Repeats until page is clear
- **Cost:** ~$0.30 per CAPTCHA from 2captcha

#### 7. **humanize.js** (Anti-Detection Evasion)
- **Purpose:** Make bot appear human-like to avoid detection
- **Key Functions:**
  - `randomStepDelay()` - Random 2-5 second pause
  - `randomCharDelay()` - Random 50-150ms per character typed
  - `randomMouseMove()` - Random mouse movement patterns
  - `humanType()` - Type text with per-character delays
  - `typeIntoFacebookComposer()` - Type into message box with delays
- **Techniques:**
  - Variable typing speed (not instant)
  - Random pauses between actions
  - Mouse movement before clicking
  - Realistic viewport size

#### 8. **media.js** (Image Attachment)
- **Purpose:** Attach random image to posts from `POST_IMAGE_DIR`
- **Key Functions:**
  - `pickImageByPostId()` - Select image for post
  - `uploadImageToComposer()` - Attach to message
- **Supported Formats:** JPEG, PNG, GIF, WebP
- **Behavior:** Picks random image from folder each time

#### 9. **logger.js** (Logging Utilities)
- **Purpose:** Structured logging with timestamps
- **Exports:** Log functions with [tag] prefixes for easy filtering
- **Format:** `[tag] message` for color-coded output in console

#### 10. **manual-login.js** (Interactive Login Tool)
- **Purpose:** Establish fresh Facebook session manually
- **Usage:**
  ```bash
  node manual-login.js
  ```
- **What it does:**
  1. Launches browser with UI visible
  2. Shows Facebook login page
  3. Waits for you to log in manually
  4. Monitors for login success (c_user cookie)
  5. Saves cookies to session.json
  6. Closes browser
- **When to use:** First setup or if session expires/corrupted

---

## Configuration Files Deep Dive

### .env File

```env
# Facebook Account Credentials
FB_EMAIL=ManagedMindset21@gmail.com
FB_PASSWORD=DSWMike202620264266771!

# 2captcha API Key (for CAPTCHA solving)
CAPTCHA_API_KEY=7bec89ac38da7e8b1ee8eee3e09d5471

# Target Facebook Groups (comma-separated URLs)
TARGET_GROUP_URLS=https://www.facebook.com/groups/225542072815842,https://www.facebook.com/groups/1616735018616241,...

# Post Content
POST_TEXT="2BR/2BA in Dayton for $975/month. Yes, really.\n..."
POST_IMAGE_DIR=./images

# Browser Settings
HEADLESS=false          # false = show browser UI while posting (good for debugging)
                        # true = run headless (use in production/Docker)

# Posting Behavior
SKIP_POST=false         # true = fill composer but don't click Post (testing mode)
WAIT_FOR_ENTER_BEFORE_CLOSE=false  # true = pause before closing (see dialog)
PAUSE_AFTER_COMPOSE_MS=5000        # ms to wait after typing before posting

# Advanced
RESET_POSTS=false       # true = ignore .posting-state.json, start from post 1
USER_DATA_DIR=./.fb-profile  # Browser profile cache (auto-created)
SESSION_FILE=./session.json  # Where to save cookies
```

### schedule.json File

```json
{
  "scheduling": {
    "delayBetweenPostsMs": 14400000,  // 4 hours = 4 * 60 * 60 * 1000
    "postsPerDay": 12,                 // Max posts in 24 hours (0 = unlimited)
    "enabled": true,                    // Enable scheduling (false = post once only)
    "mode": "interval"                  // "interval" (implemented), "cron" (not yet)
  },
  "notes": {
    "delayBetweenPostsMs": "10800000=3h, 14400000=4h, 21600000=6h, 28800000=8h",
    "postsPerDay": "Limits posts in rolling 24-hour window (0 = unlimited)"
  }
}
```

**Common Delay Values:**
- `300000` = 5 minutes (testing)
- `3600000` = 1 hour
- `10800000` = 3 hours
- `14400000` = 4 hours (current)
- `21600000` = 6 hours
- `28800000` = 8 hours

### posts.json File

```json
[
  {
    "id": 1,
    "text": "Message 1: 2BR/2BA in Dayton for $975/month...\n\nDetails and link..."
  },
  {
    "id": 2,
    "text": "Message 2: If you've been turned away, read this...\n\nMore details..."
  },
  // ... up to 12 messages
]
```

---

## Workflow Examples

### Example 1: Post One Message (Manual)

```bash
npm start
```

**What happens:**
1. Loads post #1 from posts.json
2. Launches browser, logs in (uses session.json if available)
3. Posts to all 18 target groups
4. Saves session.json
5. Updates .posting-state.json (marks post #1 as sent)
6. Closes browser
7. **Total time:** ~2-3 minutes

### Example 2: Continuous Posting with 4-Hour Delays

```bash
npm run daemon
```

**What happens:**
1. Posts message #1 to all groups
2. Waits 4 hours
3. Posts message #2 to all groups
4. Waits 4 hours
5. ... continues until all 12 posts sent
6. **Total time:** ~44 hours (12 posts × 4 hours - 4 hours for last one)

**Monitor progress:**
- Console logs show each run
- Check `.posting-state.json` for which posts completed
- Daemon can be stopped anytime with Ctrl+C (will continue where left off)

### Example 3: Disable Scheduling (Post All Fast)

Edit `schedule.json`:
```json
{
  "scheduling": {
    "delayBetweenPostsMs": 300000,  // 5 minutes
    "postsPerDay": 0,                // No daily limit
    "enabled": true,
    "mode": "interval"
  }
}
```

Then:
```bash
npm run daemon
```

**Result:** Posts all 12 messages with 5-minute gaps = ~1 hour total


### Example 4: Manual Session Setup

If `session.json` is missing or expired:

```bash
node manual-login.js
```

1. Browser opens, shows Facebook login
2. You type credentials manually
3. After successful login, browser closes
4. `session.json` saved automatically
5. Future runs use this session (no manual login needed)

---

## Key Code Snippets

### The Main Posting Loop (index.js)

```javascript
// 1. Get next unposted message
const post = getNextPost(posts, postingState);
if (!post) {
  console.log('✓ All posts completed!');
  process.exit(0);
}

// 2. For each target group
for (const groupUrl of TARGET_GROUP_URLS) {
  // 3. Navigate to group
  await page.goto(groupUrl, { waitUntil: 'networkidle2' });
  
  // 4. Click Composer (Create Post button)
  // 5. Type message with humanized delays
  await typeIntoFacebookComposer(page, post.text);
  
  // 6. Attach image if available
  if (POST_IMAGE_DIR) {
    const imagePath = pickImageByPostId(post.id);
    if (imagePath) {
      await uploadImageToComposer(page, imagePath);
    }
  }
  
  // 7. Solve CAPTCHA if appears
  if (await hasCaptcha(page)) {
    await resolveCaptchasUntilClear(page, CAPTCHA_API_KEY);
  }
  
  // 8. Click Post button
  if (!SKIP_POST) {
    await page.click('button:has-text("Post")');
    await sleep(PAUSE_AFTER_COMPOSE_MS);
  }
}

// 9. Save session and mark post as sent
saveSessionCookies(page);
updateStateAfterPost(post.id);
```

### Auto-Login Flow (index.js)

```javascript
async function autoLoginIfNeeded(page) {
  // Check if already logged in (has c_user cookie + not on login page)
  if (await isLoggedInState(page)) {
    console.log('✓ Already logged in');
    return true;
  }

  // Try to fill login form
  const emailField = await page.$('input[name="email"]');
  if (emailField) {
    await emailField.type(FB_EMAIL, { delay: 60 });  // Type slowly
    await page.click('button[name="login"]');
    await sleep(2500);  // Wait for password field
  }

  // Fill password
  const passwordField = await page.$('input[name="pass"]');
  if (passwordField) {
    await passwordField.type(FB_PASSWORD, { delay: 60 });
    await page.click('button[type="submit"]');
    await sleep(3000);
  }

  // Verify login succeeded
  await sleep(5000);
  return await isLoggedInState(page);
}
```

### Daemon Loop (daemon.js)

```javascript
async function runDaemon() {
  const posts = loadPosts();
  const scheduleConfig = loadScheduleConfig();
  let postingState = loadPostingState();

  while (true) {
    // Check if all posts done
    if (postingState.length >= posts.length) {
      console.log('✓ All posts completed!');
      break;
    }

    // Run one posting cycle
    console.log(`[daemon] Starting posting cycle (${postingState.length}/${posts.length} complete)`);
    await runBotProcess();  // Spawn index.js as subprocess

    // Wait for delay
    const delay = scheduleConfig.scheduling.delayBetweenPostsMs;
    console.log(`[daemon] Waiting ${formatDelay(delay)} before next post...`);
    await sleep(delay);

    // Reload state (in case manual changes)
    postingState = loadPostingState();
  }

  process.exit(0);
}

runDaemon().catch(console.error);
```

---

## Environment Requirements

- **Node.js:** >= 18
- **Memory:** 500MB minimum (browser overhead)
- **Internet:** Stable connection to Facebook and 2captcha
- **Screen:** Not required (works headless)
- **OS:** Windows, macOS, Linux

## Dependencies

| Package | Purpose |
|---------|---------|
| `puppeteer` | Headless browser automation |
| `puppeteer-extra` | Extended Puppeteer features |
| `puppeteer-extra-plugin-stealth` | Anti-detection plugin |
| `dotenv` | Load .env configuration |
| `sharp` | Image resizing/optimization |

## Deployment Options

### Option 1: Local Machine (Current Setup)
```bash
npm install
npm run daemon
```
- Keep terminal open, can close anytime (resumes on next run)
- Good for testing/development

### Option 2: Docker Container
```bash
docker build -t fb-bot .
docker run -d --name fb-bot-daemon fb-bot
```
- Runs continuously in background
- Independent from your terminal
- Auto-restarts on reboot

### Option 3: VPS / Cloud Server
- SSH into server
- Clone repo
- Setup `.env` with credentials
- Run `npm run daemon` in `screen` or `nohup`

---

## Troubleshooting Guide

### Issue: "Cannot find module 'puppeteer'"
**Fix:** Run `npm install`

### Issue: Login keeps failing
**Fix:** Run `node manual-login.js` to establish fresh session

### Issue: CAPTCHA solving fails
**Fix:** Verify CAPTCHA_API_KEY in .env with 2captcha account has balance

### Issue: Posts not sending to some groups
**Fix:** Check if session expired (cookie age > 30 days) or account locked

### Issue: Daemon stops randomly
**Fix:** Check if daily post limit reached in `schedule.json`

---

## Security Notes

⚠️ **Never commit .env file** (contains credentials)
- `.gitignore` already includes `.env` and `session.json`

⚠️ **Rotate API keys** if credentials leaked
- Facebook password in `.env` = full account access
- 2captcha key = potential account credit theft

⚠️ **Use HEADLESS=false for testing** only
- Never use `false` in production
- Browser UI exposes private data on screen

---

## Directory Structure Summary

```
Micheal FB bot/
├── src/                          # Main source code
│   ├── index.js                 # Single-post script (main entry)
│   ├── daemon.js                # Scheduler/looper
│   ├── config.js                # Environment management
│   ├── scheduler.js             # Post state management
│   ├── session.js               # Facebook auth/cookies
│   ├── captcha.js               # CAPTCHA solving
│   ├── humanize.js              # Anti-detection
│   ├── media.js                 # Image attachment
│   └── logger.js                # Logging utilities
│
├── .env                          # ⚠️ SECRETS (gitignored)
├── .env.example                  # Template
├── posts.json                    # 12 messages to post
├── schedule.json                 # Scheduling config
├── session.json                  # Cookies (auto-created, gitignored)
├── .posting-state.json           # Progress tracker (auto-created)
├── package.json                  # Dependencies
├── manual-login.js               # Interactive login tool
├── test-captcha-key.js           # CAPTCHA tester
├── Dockerfile                    # Container config
└── QUICK_START.md                # Quick reference
```

---

## Summary Table: What Each File Does

| File | Type | Function | Key Methods |
|------|------|----------|-------------|
| index.js | Logic | Post one message to all groups | autoLoginIfNeeded, postToGroup |
| daemon.js | Logic | Loop and schedule posts | runDaemon, runBotProcess |
| config.js | Config | Load/validate environment | validateConfig, exports vars |
| scheduler.js | Data | Manage posts and state | loadPosts, getNextPost, formatDelay |
| session.js | Auth | Facebook cookies/login | loadSessionFromDisk, hasUserCookie |
| captcha.js | API | Solve reCAPTCHA v2 | submitRecaptchaV2, pollCaptchaResult |
| humanize.js | Evasion | Human-like actions | randomStepDelay, humanType |
| media.js | Media | Attach images | pickImageByPostId, uploadImage |
| logger.js | Util | Structured logging | Log functions |
| manual-login.js | Script | Helper | Interactive login UI |
| posts.json | Data | Posts to send | Array of {id, text} |
| schedule.json | Config | Timing rules | Delays, daily limits |
| .env | Secret | Credentials | FB login, API keys, target groups |

