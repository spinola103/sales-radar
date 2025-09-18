/**
 * server.js - Twitter scraper with improved displayName & handle extraction
 *
 * (Same env vars & behavior as before)
 */

const express = require('express');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

puppeteer.use(StealthPlugin());

const log = pino({ level: process.env.LOG_LEVEL || 'info' });

const PORT = process.env.PORT || 3000;
const SCROLL_DELAY = parseInt(process.env.SCROLL_DELAY_MS || '1000', 10);
const MAX_SCROLL_ATTEMPTS = parseInt(process.env.MAX_SCROLL_ATTEMPTS || '12', 10);
const COOKIE_FILE_PATH = process.env.COOKIE_FILE_PATH || path.join(__dirname, 'cookie.json');
const HEADLESS = (process.env.HEADLESS || 'true').toLowerCase() === 'true';
const CHROME_EXECUTABLE_PATH = process.env.CHROME_EXECUTABLE_PATH || undefined;

const app = express();
app.use(bodyParser.json({ limit: '1mb' }));

/* --------------------------- cookie helpers --------------------------- */
function loadCookiesFromEnvOrFile() {
  const env = process.env.COOKIE_JSON;
  if (env) {
    try {
      const parsed = JSON.parse(env);
      if (Array.isArray(parsed) && parsed.length) {
        log.info('Using cookies from COOKIE_JSON env var.');
        return parsed;
      } else {
        log.warn('COOKIE_JSON parsed but is not an array or empty.');
      }
    } catch (e) {
      log.warn('Failed to parse COOKIE_JSON env var:', e.message);
    }
  }

  try {
    if (fs.existsSync(COOKIE_FILE_PATH)) {
      const raw = fs.readFileSync(COOKIE_FILE_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) {
        log.info({ cookieFile: COOKIE_FILE_PATH }, 'Using cookies from cookie file on disk.');
        return parsed;
      } else {
        log.warn({ cookieFile: COOKIE_FILE_PATH }, 'Cookie file exists but content not an array or empty.');
      }
    } else {
      log.info({ cookieFile: COOKIE_FILE_PATH }, 'No cookie file found on disk.');
    }
  } catch (e) {
    log.warn('Failed to load cookie file:', e.message);
  }

  return null;
}

/* --------------------------- URL builder --------------------------- */
function buildTwitterSearchUrl(query) {
  const q = encodeURIComponent(query);
  return `https://twitter.com/search?q=${q}&f=live`;
}

/* --------------------------- scraping logic --------------------------- */
async function launchBrowser() {
  const launchOptions = {
    headless: HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1200,900',
      '--lang=en-US,en'
    ],
    defaultViewport: { width: 1200, height: 900 }
  };

  if (CHROME_EXECUTABLE_PATH) {
    launchOptions.executablePath = CHROME_EXECUTABLE_PATH;
    log.info({ chromePath: CHROME_EXECUTABLE_PATH }, 'Using custom Chrome executable path.');
  }

  return puppeteer.launch(launchOptions);
}

/**
 * Detect whether page shows a login gate or blocked content
 */
async function isBlockedOrLoginPage(page) {
  const blocked = await page.evaluate(() => {
    const bodyText = document.body ? document.body.innerText || '' : '';
    const lower = bodyText.toLowerCase();

    if (lower.includes('log in') && (lower.includes('twitter') || lower.includes('x.com'))) return true;
    if (lower.includes('sign up') && (lower.includes('twitter') || lower.includes('x.com'))) return true;
    if (lower.includes('rate limit') || lower.includes('too many requests')) return true;
    if (lower.includes('you are only seeing') || lower.includes('to view this page')) return true;
    if (document.querySelector('div[role="button"][data-testid*="login"], a[href*="/login"], button[data-testid="loginButton"]')) return true;

    return false;
  });

  return blocked;
}

/**
 * Improved Extractor:
 * - Finds the profile anchor for each article (the anchor that links to the profile but NOT to the status)
 * - Extracts handle from the href (strip / and possible query)
 * - Extracts display name using prioritized sources:
 *    1) visible name span under the profile anchor
 *    2) aria-label/title attributes on the profile anchor
 *    3) first header span fallback
 */
async function extractTweetsFromPage(page) {
  return page.evaluate(() => {
    const out = [];
    const articles = Array.from(document.querySelectorAll('article'));
    articles.forEach(article => {
      try {
        // Tweet text
        const textEl = article.querySelector('[data-testid="tweetText"]');
        const text = textEl ? textEl.innerText.trim() : '';

        // Status link (tweet permalink)
        const statusAnchor = article.querySelector('a[href*="/status/"]');
        const link = statusAnchor ? ('https://twitter.com' + statusAnchor.getAttribute('href')) : '';

        // Find profile anchor:
        // Strategy: find an <a> whose href looks like '/username' (no '/status/') and appears in the article header
        const anchors = Array.from(article.querySelectorAll('a[href]'));
        let profileAnchor = null;
        for (const a of anchors) {
          const href = a.getAttribute('href');
          if (!href) continue;
          // skip anchors that point to status or include /status/
          if (href.includes('/status/')) continue;
          // prefer links that are exactly /username or /username?some...
          // Ensure href starts with '/' and has no more slashes after second part
          const cleaned = href.split('?')[0];
          const parts = cleaned.split('/').filter(Boolean); // remove empty
          if (parts.length === 1) {
            profileAnchor = a;
            break;
          }
        }
        // As a fallback, pick first anchor that links to twitter.com/username
        if (!profileAnchor) {
          profileAnchor = anchors.find(a => {
            const href = a.getAttribute('href') || '';
            return /twitter\.com\/[^\/]+$/.test(href);
          }) || null;
        }

        // Extract handle and displayName
        let handle = '';
        let displayName = '';

        if (profileAnchor) {
          // handle from href
          let href = profileAnchor.getAttribute('href') || '';
          // If it's absolute, remove origin
          href = href.replace(/^https?:\/\/(www\.)?twitter\.com/, '');
          href = href.split('?')[0].split('#')[0];
          // remove leading slash
          if (href.startsWith('/')) href = href.slice(1);
          // take first path segment as handle
          if (href) handle = href.split('/')[0].replace('@', '').trim();

          // display name: try typical name span inside the anchor or nearby
          const nameSpan = profileAnchor.querySelector('div span') || profileAnchor.querySelector('span');
          if (nameSpan && nameSpan.innerText && nameSpan.innerText.trim().length > 0) {
            displayName = nameSpan.innerText.trim();
          } else {
            // maybe the display name is a sibling in header
            const headerSpan = article.querySelector('div[dir="auto"] span');
            if (headerSpan && headerSpan.innerText && headerSpan.innerText.trim().length > 0) {
              displayName = headerSpan.innerText.trim();
            } else if (profileAnchor.getAttribute('aria-label')) {
              displayName = profileAnchor.getAttribute('aria-label').trim();
            } else if (profileAnchor.getAttribute('title')) {
              displayName = profileAnchor.getAttribute('title').trim();
            }
          }
        } else {
          // No profile anchor found: fallback heuristics
          const headerSpan = article.querySelector('div[dir="auto"] span');
          if (headerSpan) displayName = headerSpan.innerText || '';
          // try to guess handle from any text that looks like @handle
          const atHandle = article.innerText.match(/@([A-Za-z0-9_]{1,15})/);
          if (atHandle && atHandle[1]) handle = atHandle[1];
        }

        // Likes
        let likes = 0;
        const likeBtn = article.querySelector('[data-testid="like"]') || article.querySelector('[data-testid="like"] div');
        if (likeBtn) {
          const aria = likeBtn.getAttribute('aria-label') || likeBtn.innerText || '';
          const m = aria.match(/[\d,]+/);
          if (m) likes = parseInt(m[0].replace(/,/g, ''), 10);
        }

        const verified = !!article.querySelector('[data-testid="icon-verified"]');
        let timestamp = null;
        const timeEl = article.querySelector('time');
        if (timeEl) timestamp = timeEl.getAttribute('datetime') || timeEl.innerText || null;

        if (text && link) {
          out.push({
            displayName: displayName || '',
            handle: handle || '',
            text,
            link,
            likes,
            verified,
            timestamp
          });
        }
      } catch (e) {
        // ignore per-article errors
      }
    });
    return out;
  });
}

/**
 * scrapeTweetsForQuery
 */
async function scrapeTweetsForQuery(query, maxTweets, cookieArray) {
  const browser = await launchBrowser();
  const page = await browser.newPage();

  // set viewport explicitly (mimic a real browser)
  await page.setViewport({ width: 1200, height: 900 });

  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  await page.setUserAgent(
    process.env.USER_AGENT ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
  );

  // If cookies provided, set them
  if (cookieArray && Array.isArray(cookieArray) && cookieArray.length) {
    try {
      const normalized = cookieArray.map(c => {
        const out = {
          name: c.name,
          value: c.value,
          domain: c.domain || '.x.com',
          path: c.path || '/',
          httpOnly: !!c.httpOnly,
          secure: !!c.secure
        };
        if (c.expires) out.expires = c.expires;
        return out;
      });
      await page.setCookie(...normalized);
      log.info('Set cookies on page.');
    } catch (e) {
      log.warn('Failed to set cookies on page:', e.message);
    }
  }

  // --- NEW BLOCK: ensure cookies are active by visiting twitter.com and checking login ---
  try {
    await page.goto('https://twitter.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    log.warn('Initial goto to twitter.com failed (non-fatal):', e.message);
  }

  // give the page a little time to render
  await page.waitForTimeout(1500);

  // heuristics to detect logged in state
  const loggedIn = await page.evaluate(() => {
    // presence of profile/home links or timeline suggests logged-in
    if (document.querySelector('a[href="/home"]')) return true;
    if (document.querySelector('a[aria-label="Profile"]')) return true;
    if (document.querySelector('div[aria-label*="Timeline"]')) return true;

    const body = document.body ? document.body.innerText.toLowerCase() : '';
    if (body.includes('log in') || body.includes('sign up') || body.includes('password')) return false;
    return false;
  });

  if (!loggedIn) {
    const debugPrefix = `debug_${Date.now()}`;
    try {
      await page.screenshot({ path: `${debugPrefix}.png`, fullPage: true });
      const html = await page.content();
      fs.writeFileSync(`${debugPrefix}.html`, html, 'utf8');
      log.warn({ debugFiles: [`${debugPrefix}.png`, `${debugPrefix}.html`] }, 'Saved debug files because login not detected.');
    } catch (e) {
      log.warn('Failed to save debug files:', e.message);
    }

    const msg = 'Login not detected after applying cookies. Check COOKIE_JSON or cookie.json; include auth_token and ct0 and ensure domain is .x.com. Saved debug files.';
    log.warn(msg);
    await browser.close();
    const err = new Error(msg);
    err.code = 'LOGIN_REQUIRED';
    throw err;
  }

  log.info('Logged-in session detected; proceeding to search.');

  // Build search URL and navigate
  const url = buildTwitterSearchUrl(query);
  log.info({ url }, 'Navigating to twitter search URL');

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(err => {
    log.warn('page.goto failed for search URL:', err.message);
  });

  // Quick blocked/login detection for search page
  const blockedImmediately = await isBlockedOrLoginPage(page);
  if (blockedImmediately && (!cookieArray || cookieArray.length === 0)) {
    await browser.close();
    const msg = 'Twitter returned a login/blocked page on search. Provide COOKIE_JSON or cookie.json (logged-in cookies) to continue.';
    log.warn(msg);
    const err = new Error(msg);
    err.code = 'LOGIN_REQUIRED';
    throw err;
  }

  // Wait for articles (tweets) to appear
  try {
    await page.waitForSelector('article', { timeout: 15000 });
  } catch (e) {
    log.warn('waitForSelector(article) timed out.');
  }

  // do scrolling + extraction
  let tweets = [];
  let scrollAttempts = 0;
  let lastHeight = 0;

  while ((tweets.length < maxTweets) && scrollAttempts < MAX_SCROLL_ATTEMPTS) {
    const newTweets = await extractTweetsFromPage(page);

    const map = new Map(tweets.map(t => [t.link, t]));
    newTweets.forEach(t => {
      if (t.link && !map.has(t.link)) map.set(t.link, t);
    });
    tweets = Array.from(map.values());

    if (tweets.length >= maxTweets) break;

    const newHeight = await page.evaluate('document.body.scrollHeight').catch(() => 0);
    if (newHeight === lastHeight) {
      scrollAttempts++;
    } else {
      scrollAttempts = 0;
      lastHeight = newHeight;
    }

    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.9)).catch(() => {});
    await new Promise(r => setTimeout(r, SCROLL_DELAY));
  }

  // final check: if still zero tweets and login block detected, raise
  if (tweets.length === 0) {
    const maybeBlocked = await isBlockedOrLoginPage(page);
    if (maybeBlocked && (!cookieArray || cookieArray.length === 0)) {
      await browser.close();
      const msg = 'After navigation, page appears blocked or requires login. Provide valid cookies.';
      log.warn(msg);
      const err = new Error(msg);
      err.code = 'LOGIN_REQUIRED';
      throw err;
    }
  }

  // sort by timestamp newest first
  tweets.forEach(t => {
    try {
      t.timestamp_iso = t.timestamp ? new Date(t.timestamp).toISOString() : null;
    } catch (e) {
      t.timestamp_iso = null;
    }
  });
  tweets.sort((a, b) => {
    const ta = a.timestamp_iso ? new Date(a.timestamp_iso).getTime() : 0;
    const tb = b.timestamp_iso ? new Date(b.timestamp_iso).getTime() : 0;
    return tb - ta;
  });

  const result = tweets.slice(0, maxTweets);
  await browser.close();
  return result;
}

/* --------------------------- Express endpoints --------------------------- */

app.get('/', (req, res) => {
  res.json({ ok: true, message: 'Twitter scraper up. POST JSON to /scrape' });
});

app.post('/scrape', async (req, res) => {
  const body = req.body || {};
  const filter = (body.filter || body.query || '').trim();
  const maxTweets = Math.max(1, parseInt(body.max_tweets_per_run || body.max_tweets || 1, 10));

  if (!filter) return res.status(400).json({ error: 'filter (query) is required in body' });

  log.info({ filter, maxTweets }, 'Received scrape request (POST /scrape)');

  // load cookies once per request
  const cookieArray = loadCookiesFromEnvOrFile();

  try {
    const tweets = await scrapeTweetsForQuery(filter, maxTweets, cookieArray);
    // write output.json (best-effort)
    try {
      const outPath = path.join(__dirname, 'output.json');
      fs.writeFileSync(outPath, JSON.stringify({ meta: { filter, maxTweets, id: body.id || null }, tweets }, null, 2));
      log.info({ outPath }, 'Saved output.json');
    } catch (e) {
      log.warn('Could not write output.json:', e.message);
    }

    return res.json({ ok: true, meta: { filter, maxTweets, id: body.id || null }, tweets });
  } catch (err) {
    log.error(err);
    if (err && err.code === 'LOGIN_REQUIRED') {
      return res.status(403).json({
        ok: false,
        error: 'login_required',
        message: err.message,
        hint: 'Provide COOKIE_JSON env var or place cookie.json in project folder with logged-in Twitter cookies (include auth_token and ct0).'
      });
    }
    return res.status(500).json({ ok: false, error: err.message || 'scrape_failed' });
  }
});

app.listen(PORT, () => {
  log.info({ port: PORT, headless: HEADLESS }, `Server listening on port ${PORT}`);
});
