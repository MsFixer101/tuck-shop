// Platform readers: GitHub, Reddit, Hacker News.
// Each returns a result object or null (not a match → fall through to generic fetch).
import { getKey } from './key-store.js';

const UA = 'tuck-shop/1.0';

function stripHtmlSimple(html) {
  return (html || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// GitHub: match {owner}/{repo} exactly, or /tree/{branch} (treat as repo root).
// Deeper paths (blob, issues, pulls, etc.) return null → generic fetch handles them.
async function githubFetch(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.hostname !== 'github.com') return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2 || parts.length > 4) return null;
  const [owner, repo, ...rest] = parts;
  if (rest.length > 0 && !(rest.length === 2 && rest[0] === 'tree')) return null;

  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': UA };
  const key = await getKey('github');
  if (key) headers.Authorization = `Bearer ${key}`;

  const [repoRes, readmeRes] = await Promise.allSettled([
    fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers, signal: AbortSignal.timeout(8000) }),
    fetch(`https://api.github.com/repos/${owner}/${repo}/readme`, { headers: { ...headers, Accept: 'application/vnd.github.raw+json' }, signal: AbortSignal.timeout(8000) }),
  ]);

  const repoOk = repoRes.status === 'fulfilled' && repoRes.value.ok;
  const readmeOk = readmeRes.status === 'fulfilled' && readmeRes.value.ok;
  if (!repoOk && !readmeOk) {
    return { platform: 'github', url, readable: false, note: 'Could not fetch this repository.' };
  }

  let description, stars, language, topics, license, updated;
  if (repoOk) {
    try {
      const j = await repoRes.value.json();
      description = j.description;
      stars = j.stargazers_count;
      language = j.language;
      topics = j.topics;
      license = j.license?.spdx_id;
      updated = j.updated_at;
    } catch {}
  }

  let readme;
  if (readmeOk) {
    try { readme = await readmeRes.value.text(); } catch {}
  }

  const result = {
    platform: 'github', url, readable: true, title: `${owner}/${repo}`,
    description, stars, language, topics, license, updated,
  };
  if (readme) result.readme = readme;
  return result;
}

// Reddit: match /r/{sub}/comments/{id}... (www/old/np subdomains too).
// On failure → null (falls through to generic fetch, which may render old.reddit).
async function redditFetch(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/^(www|old|np)\.reddit\.com$/.test(u.hostname) && u.hostname !== 'reddit.com') return null;
  const m = u.pathname.match(/^\/r\/([^/]+)\/comments\/([a-z0-9]+)/i);
  if (!m) return null;

  try {
    const r = await fetch(`https://www.reddit.com${u.pathname}.json?limit=30`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const post = j[0]?.data?.children?.[0]?.data;
    if (!post) return null;
    const comments = (j[1]?.data?.children || [])
      .filter(c => c.kind === 't1')
      .slice(0, 10)
      .map(c => ({ author: c.data.author, score: c.data.score, text: c.data.body }));
    const sections = [
      post.title,
      `u/${post.author} · r/${post.subreddit} · ${post.score} points`,
    ];
    if (post.selftext) sections.push(post.selftext);
    const commentLines = comments.map(c => `u/${c.author} (${c.score}): ${c.text}`);
    if (commentLines.length) sections.push(commentLines.join('\n'));
    const content = sections.join('\n\n');
    return {
      platform: 'reddit', url, readable: true,
      title: post.title, author: post.author, subreddit: post.subreddit,
      score: post.score, num_comments: post.num_comments,
      text: post.selftext, comments,
      content, chars: content.length,
    };
  } catch {
    return null;
  }
}

// Hacker News: match news.ycombinator.com/item?id={n}.
async function hnFetch(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.hostname !== 'news.ycombinator.com') return null;
  const id = u.searchParams.get('id');
  if (!id || !/^\d+$/.test(id)) return null;

  try {
    const r = await fetch(`https://hn.algolia.com/api/v1/items/${id}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return { platform: 'hackernews', url, readable: false, note: 'Could not fetch this HN item.' };
    const item = await r.json();
    const comments = (item.children || [])
      .slice(0, 10)
      .map(c => ({ author: c.author, text: stripHtmlSimple(c.text) }));
    const sections = [
      item.title,
      `${item.author} · ${item.points} points`,
    ];
    if (item.url) sections.push(item.url);
    const commentLines = comments.map(c => `${c.author}: ${c.text}`);
    if (commentLines.length) sections.push(commentLines.join('\n'));
    const content = sections.join('\n\n');
    return {
      platform: 'hackernews', url, readable: true,
      title: item.title, author: item.author, points: item.points,
      ...(item.url ? { story_url: item.url } : {}),
      comments,
      content, chars: content.length,
    };
  } catch {
    return { platform: 'hackernews', url, readable: false, note: 'Could not fetch this HN item.' };
  }
}

export async function platformFetch(url) {
  const gh = await githubFetch(url);
  if (gh) return gh;
  const reddit = await redditFetch(url);
  if (reddit) return reddit;
  const hn = await hnFetch(url);
  if (hn) return hn;
  return null;
}
