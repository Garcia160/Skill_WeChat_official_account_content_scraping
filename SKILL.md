---
name: wechat-mp-article-archive
description: Read, discover, summarize, and archive WeChat Official Account articles from mp.weixin.qq.com. Use this skill when the user gives a WeChat article URL and asks to read/summarize/export it; asks for recent or historical posts from a WeChat public account; asks to batch collect a public account's posts; needs article originals saved as Word .docx files; or needs a repeatable workaround for anonymous WeChat profile-history APIs returning no session/client-required errors. Do not use for non-WeChat sites, private WeChat content that requires the user's logged-in account, or tasks that only need ordinary web search results without article extraction.
---

# WeChat MP Article Archive

## Overview

Use this skill to repeat the proven workflow for WeChat Official Account articles:
find recent posts, resolve real `mp.weixin.qq.com` article URLs, read rendered article text, and optionally export each article to a separate Word document.

Do not use or store user passwords. GitHub, WeChat, and Sogou should be accessed through existing authenticated tooling or public pages only.

## When To Use

Use this skill when the task contains any of these signals:

- a `mp.weixin.qq.com` or WeChat Official Account article URL to read, summarize, or export
- a request for the latest, recent, past, or historical posts from a WeChat public account
- a request to save WeChat article originals into `.docx` or an archive folder
- a need to recover article content after WeChat profile APIs return `no session` or profile pages require the WeChat client
- a need to reuse the Sogou Weixin index plus JavaScript-link-resolution method for public WeChat posts

Do not use this skill for ordinary websites, private/member-only WeChat content, or tasks where search-result snippets are enough and full article extraction is unnecessary.

## Preferred Workflow

1. If the user gives a single `mp.weixin.qq.com/s/...` URL, open it first with browser mode and extract:
   `#activity-name`, `#js_name`, `#publish_time`, `#js_content`, and page variables such as `biz`, `mid`, and `idx`.
2. For recent posts from a public account, do not rely on anonymous WeChat history APIs:
   `mp/profile_ext?action=getmsg` usually returns `ret=-3 no session`, and profile home often requires the WeChat client.
3. Query Sogou Weixin public search instead:
   `https://weixin.sogou.com/weixin?type=2&ie=utf8&query=<account-or-keywords>`.
4. Parse result cards from `.news-list li`:
   title from `h3 a`, account from `.all-time-y2`, date from the embedded `timeConvert('<timestamp>')`, summary from `.txt-info`, and link from `h3 a[href]`.
5. Filter by exact account name, merge candidates from several queries, de-duplicate by `title + date`, and sort descending by date.
6. Resolve Sogou `/link?...` article links with plain HTTP first. The response is often a JavaScript page, not a 302; reconstruct the real URL by concatenating every `url += '...'` string.
7. Open the resolved `https://mp.weixin.qq.com/s?src=11&...` URL with Playwright/browser mode, then extract the article fields.
8. Export to Word only after article text is confirmed from `#js_content`; reject pages whose body contains Sogou anti-spider verification text.

## Reusable Script

Use `scripts/export_wechat_mp_articles_to_docx.mjs` for the full workflow.

First-time setup from the skill folder:

```bash
cd skills/wechat-mp-article-archive/scripts
npm install
```

Example:

```bash
node export_wechat_mp_articles_to_docx.mjs --account "HEU石榴籽" --out "E:/mar (1)/HEU石榴籽往期推送" --limit 5 --query "石榴花开 HEU石榴籽"
```

Useful options:

- `--account`: exact public-account display name to keep.
- `--out`: output folder for `.docx` files.
- `--limit`: number of newest posts to export.
- `--query`: extra Sogou search query; can be repeated.
- `--pages`: number of Sogou result pages to scan per query.
- `--chrome`: path to a local Chrome or Edge executable when Playwright browsers are not installed.

The script writes one `.docx` per article and prints a JSON array of created files.

## Notes From The Proven Run

- For WeChat pages, browser mode with system Chrome is more reliable than plain fetch.
- If PowerShell corrupts Chinese literals into `???`, use UTF-8 files or Unicode escapes in scripts.
- Sogou may trigger anti-spider verification when clicked through a browser. Resolving the `/link?...` page with HTTP and parsing the JavaScript redirect avoids the browser verification path.
- Sogou search ranking is not strictly chronological. Combine account-name queries with topical queries, then sort by extracted timestamps.
- The `src=11` Sogou-resolved WeChat URL is usually readable even when a canonical `sn` value is not exposed.
