'use strict';
/**
 * Facts and headlines, pulled from a rotating set of sources.
 *
 * Everything here needs no account and no API key. Each request picks a random
 * source, and falls back through the others if one is down, slow, or has
 * changed shape — so you get variety rather than the same site every time, and
 * a bad source degrades instead of breaking the button.
 */

const TIMEOUT_MS = 6500;

const FALLBACK_FACTS = [
  'Honey never spoils. Edible honey has been found in 3,000-year-old Egyptian tombs.',
  'Octopuses have three hearts, and two of them stop beating when the animal swims.',
  'A day on Venus is longer than a year on Venus.',
  'The first computer bug was a literal moth, taped into a logbook in 1947.',
  'Bananas are berries. Strawberries are not.',
  'There are more possible chess games than atoms in the observable universe.',
  'Sharks existed before trees, by roughly 50 million years.',
  'The Eiffel Tower can be up to 15cm taller in summer, as the iron expands.',
  'Wombat droppings are cube-shaped, which stops them rolling away.',
  'The shortest war in history lasted 38 minutes.',
  'A group of flamingos is called a flamboyance.',
  'Your stomach lining replaces itself every few days, or it would digest itself.',
  'Nintendo was founded in 1889, making playing cards.',
  'Hot water can freeze faster than cold water. Nobody fully agrees why.',
  'The dot over a lowercase i or j is called a tittle.',
  'Venus spins backwards compared to almost every other planet.',
  'An octopus can taste what it touches.',
  'The unicorn is the national animal of Scotland.',
];

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const shuffled = (a) => a.map((v) => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map((p) => p[1]);

async function get(url, accept) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: { Accept: accept, 'User-Agent': 'Jarvis/0.1 (desktop pet)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function clean(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Parse RSS `<item>` and Atom `<entry>` alike. */
function parseFeed(xml) {
  const blocks = [
    ...[...xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/g)].map((m) => m[1]),
    ...[...xml.matchAll(/<entry[\s>]([\s\S]*?)<\/entry>/g)].map((m) => m[1]),
  ];
  return blocks.map((b) => {
    const title = clean((b.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '');
    let link = clean((b.match(/<link[^>]*>([\s\S]*?)<\/link>/) || [])[1] || '');
    if (!link) link = (b.match(/<link[^>]*href=["']([^"']+)["']/) || [])[1] || '';
    const source = clean((b.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '');
    return { title, link, source };
  }).filter((x) => x.title && x.title.length > 12);
}

// -------------------------------------------------------------------- news ---
const GOOGLE_TOPICS = ['WORLD', 'NATION', 'BUSINESS', 'TECHNOLOGY', 'ENTERTAINMENT', 'SPORTS', 'SCIENCE', 'HEALTH'];

const NEWS_SOURCES = [
  { name: 'Google News', url: () => 'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en' },
  {
    name: 'Google News',
    url: () => `https://news.google.com/rss/headlines/section/topic/${pick(GOOGLE_TOPICS)}?hl=en-US&gl=US&ceid=US:en`,
  },
  { name: 'BBC News', url: () => 'https://feeds.bbci.co.uk/news/rss.xml' },
  { name: 'BBC Technology', url: () => 'https://feeds.bbci.co.uk/news/technology/rss.xml' },
  { name: 'BBC Science', url: () => 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml' },
  { name: 'NPR', url: () => 'https://feeds.npr.org/1001/rss.xml' },
  { name: 'Hacker News', url: () => 'https://hnrss.org/frontpage' },
  { name: 'Ars Technica', url: () => 'https://feeds.arstechnica.com/arstechnica/index' },
  { name: 'The Verge', url: () => 'https://www.theverge.com/rss/index.xml' },
  { name: 'Al Jazeera', url: () => 'https://www.aljazeera.com/xml/rss/all.xml' },
  { name: 'Sky News', url: () => 'https://feeds.skynews.com/feeds/rss/home.xml' },
];

async function randomNews() {
  for (const src of shuffled(NEWS_SOURCES)) {
    try {
      const items = parseFeed(await get(src.url(), 'application/rss+xml, application/xml, text/xml, */*'));
      if (!items.length) continue;
      const it = pick(items.slice(0, 25));
      const publisher = it.source || src.name;
      // Google appends " - Publisher"; the publisher is already a field.
      const title = it.source
        ? it.title.replace(new RegExp(`\\s*[-–]\\s*${it.source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '')
        : it.title;
      return { ok: true, kind: 'news', text: title, meta: publisher, url: it.link || 'https://news.google.com/' };
    } catch {
      /* try the next source */
    }
  }
  return {
    ok: false, kind: 'news',
    text: 'Could not reach any news feed right now.',
    meta: 'offline', url: 'https://news.google.com/',
  };
}

// ------------------------------------------------------------------- facts ---
const FACT_SOURCES = [
  {
    name: 'uselessfacts',
    async run() {
      const j = JSON.parse(await get('https://uselessfacts.jsph.pl/api/v2/facts/random?language=en', 'application/json'));
      return { text: clean(j.text), url: j.source_url };
    },
  },
  {
    name: 'Numbers API',
    async run() {
      const t = await get(`https://numbersapi.com/random/${pick(['trivia', 'year', 'math'])}`, 'text/plain');
      return { text: clean(t), url: 'https://numbersapi.com/' };
    },
  },
  {
    name: 'catfact.ninja',
    async run() {
      const j = JSON.parse(await get('https://catfact.ninja/fact', 'application/json'));
      return { text: clean(j.fact), url: 'https://catfact.ninja/' };
    },
  },
  {
    name: 'Wikipedia',
    async run() {
      const j = JSON.parse(await get('https://en.wikipedia.org/api/rest_v1/page/random/summary', 'application/json'));
      const extract = clean(j.extract || '');
      if (extract.length < 40) throw new Error('stub article');
      return {
        text: extract.length > 260 ? `${extract.slice(0, 257)}…` : extract,
        url: j.content_urls?.desktop?.page,
      };
    },
  },
  {
    name: 'r/todayilearned',
    async run() {
      const items = parseFeed(await get('https://www.reddit.com/r/todayilearned/top/.rss?t=day', 'application/atom+xml'));
      if (!items.length) throw new Error('no posts');
      const it = pick(items.slice(0, 15));
      return { text: it.title.replace(/^TIL[:,]?\s*/i, 'TIL '), url: it.link };
    },
  },
];

async function randomFact() {
  for (const src of shuffled(FACT_SOURCES)) {
    try {
      const r = await src.run();
      if (!r.text || r.text.length < 15) continue;
      return {
        ok: true, kind: 'fact', text: r.text, meta: src.name,
        url: r.url || `https://www.google.com/search?q=${encodeURIComponent(r.text.slice(0, 90))}`,
      };
    } catch {
      /* try the next source */
    }
  }
  const text = pick(FALLBACK_FACTS);
  return {
    ok: true, kind: 'fact', text, meta: 'offline',
    url: `https://www.google.com/search?q=${encodeURIComponent(text.slice(0, 90))}`,
  };
}

module.exports = { randomFact, randomNews, NEWS_SOURCES, FACT_SOURCES };
