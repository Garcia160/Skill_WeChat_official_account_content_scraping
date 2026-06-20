import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { chromium } from "playwright";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  ExternalHyperlink,
  Header,
  Footer,
  PageNumber,
} from "docx";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

function parseArgs(argv) {
  const args = { query: [], limit: 5, pages: 3 };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === "--query") {
      args.query.push(next);
      i += 1;
    } else if (key.startsWith("--")) {
      args[key.slice(2)] = next;
      i += 1;
    }
  }
  args.limit = Number(args.limit || 5);
  args.pages = Number(args.pages || 3);
  if (!args.account) throw new Error("Missing --account");
  if (!args.out) args.out = path.join(process.cwd(), `${args.account}-wechat-archive`);
  return args;
}

function getCookies(headers) {
  const raw = headers.get("set-cookie") || "";
  return raw
    .split(/,(?=\s*[^;=]+=[^;]+)/)
    .map((s) => s.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

function dateFromTs(ts) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(Number(ts) * 1000));
  const o = Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  return `${o.year}-${o.month}-${o.day}`;
}

function dateFromPublishTime(s) {
  const nums = (s || "").match(/\d+/g) || [];
  if (nums.length >= 3) return `${nums[0]}-${nums[1].padStart(2, "0")}-${nums[2].padStart(2, "0")}`;
  return "unknown-date";
}

async function searchSogou(q, pageNo) {
  const url = `https://weixin.sogou.com/weixin?type=2&ie=utf8&page=${pageNo}&query=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
  });
  const cookies = getCookies(res.headers);
  const html = await res.text();
  const doc = new JSDOM(html).window.document;
  return [...doc.querySelectorAll(".news-list li")].map((li, idx) => {
    const a = li.querySelector("h3 a");
    const href0 = a?.getAttribute("href") || "";
    const s2 = li.querySelector(".s-p .s2")?.innerHTML || "";
    const ts = s2.match(/timeConvert\('(\d+)'\)/)?.[1] || "";
    return {
      title: a?.textContent?.replace(/\s+/g, " ").trim() || "",
      href: href0.startsWith("http") ? href0 : `https://weixin.sogou.com${href0}`,
      account: li.querySelector(".s-p .all-time-y2")?.textContent?.trim() || "",
      date: ts ? dateFromTs(ts) : "",
      summary: li.querySelector(".txt-info")?.textContent?.replace(/\s+/g, " ").trim() || "",
      cookies,
      referer: url,
      idx,
      pageNo,
      query: q,
    };
  });
}

function parseTarget(html) {
  const parts = [...html.matchAll(/url \+= '([^']*)';/g)].map((m) => m[1]);
  return parts.join("").replace("@", "").replace(/&amp;/g, "&");
}

async function resolveSogou(item) {
  const res = await fetch(item.href, {
    redirect: "manual",
    headers: {
      "User-Agent": UA,
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      Referer: item.referer,
      Cookie: item.cookies,
    },
  });
  const loc = res.headers.get("location");
  if (loc) return loc.startsWith("http") ? loc : new URL(loc, item.href).href;
  return parseTarget(await res.text());
}

function findChrome(explicit) {
  if (explicit && fs.existsSync(explicit)) return explicit;
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ];
  return candidates.find((p) => fs.existsSync(p));
}

async function launchBrowser(chromePath) {
  const opts = {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
      "--window-size=1366,900",
    ],
  };
  const exe = findChrome(chromePath);
  if (exe) opts.executablePath = exe;
  return chromium.launch(opts);
}

async function extractArticle(browser, mpUrl) {
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.setExtraHTTPHeaders({
    "User-Agent": UA,
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Referer: "https://mp.weixin.qq.com/",
  });
  await page.goto(mpUrl, { timeout: 70000, waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(5000);
  const data = await page.evaluate(() => {
    const txt = (sel) => document.querySelector(sel)?.textContent?.replace(/\s+/g, " ")?.trim() || "";
    const meta = (name) =>
      document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.getAttribute("content") || "";
    const contentEl = document.querySelector("#js_content") || document.querySelector(".rich_media_content");
    return {
      finalUrl: location.href,
      title: txt("#activity-name") || document.title || meta("og:title"),
      account: txt("#js_name") || txt(".profile_nickname") || meta("og:article:author"),
      publishTime: txt("#publish_time") || txt("#js_publish_time"),
      description: meta("og:description") || meta("description"),
      contentText: contentEl?.innerText?.trim() || document.body.innerText.trim(),
    };
  });
  await page.close();
  if (/antispider|VerifyCode|验证码/.test(data.finalUrl + data.contentText)) {
    throw new Error(`Verification page instead of article: ${data.finalUrl}`);
  }
  if (!data.contentText || data.contentText.length < 30) {
    throw new Error(`No usable article text: ${data.finalUrl}`);
  }
  return data;
}

function cleanFilename(s) {
  return s.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
}

function bodyParagraphs(text) {
  const lines = text.split(/\r?\n/).map((s) => s.replace(/[\u00a0\u200b]/g, " ").trim());
  const paras = [];
  let empty = 0;
  for (const line of lines) {
    if (!line) {
      empty += 1;
      if (empty <= 1) paras.push(new Paragraph({ spacing: { after: 80 }, children: [new TextRun("")] }));
      continue;
    }
    empty = 0;
    paras.push(
      new Paragraph({
        style: "BodyText",
        spacing: { after: 140 },
        children: [new TextRun({ text: line })],
      }),
    );
  }
  return paras;
}

async function writeDocx(article, outDir, index) {
  fs.mkdirSync(outDir, { recursive: true });
  const title = article.title || `wechat-article-${index}`;
  const filename = `${String(index).padStart(2, "0")} ${dateFromPublishTime(article.publishTime)} ${cleanFilename(title)}.docx`;
  const filePath = path.join(outDir, filename);
  const children = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(title)] }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [
        new TextRun({ text: `${article.account || ""} | ${article.publishTime || ""}`, color: "666666", size: 21 }),
      ],
    }),
    new Paragraph({
      spacing: { after: 200 },
      children: [
        new TextRun({ text: "Source: ", bold: true }),
        new ExternalHyperlink({
          children: [new TextRun({ text: article.finalUrl, style: "Hyperlink" })],
          link: article.finalUrl,
        }),
      ],
    }),
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Original Text")] }),
    ...bodyParagraphs(article.contentText),
  ];
  const doc = new Document({
    styles: {
      default: { document: { run: { font: "Microsoft YaHei", size: 24 } } },
      paragraphStyles: [
        {
          id: "Title",
          name: "Title",
          basedOn: "Normal",
          run: { size: 38, bold: true, font: "Microsoft YaHei", color: "111111" },
          paragraph: { alignment: AlignmentType.CENTER, spacing: { before: 160, after: 160 } },
        },
        {
          id: "Heading1",
          name: "Heading 1",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { size: 28, bold: true, font: "Microsoft YaHei", color: "111111" },
          paragraph: { spacing: { before: 240, after: 160 }, outlineLevel: 0 },
        },
        {
          id: "BodyText",
          name: "Body Text",
          basedOn: "Normal",
          run: { size: 23, font: "Microsoft YaHei", color: "111111" },
          paragraph: { spacing: { line: 360 } },
        },
      ],
    },
    sections: [
      {
        properties: { page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [new TextRun({ text: "WeChat MP Article Archive", color: "777777", size: 18 })],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ text: "Page ", size: 18 }),
                  new TextRun({ children: [PageNumber.CURRENT], size: 18 }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
  fs.writeFileSync(filePath, await Packer.toBuffer(doc));
  return filePath;
}

async function main() {
  const args = parseArgs(process.argv);
  const queries = [args.account, ...args.query];
  const all = [];
  for (const q of queries) {
    for (let p = 1; p <= args.pages; p += 1) {
      all.push(...(await searchSogou(q, p)));
    }
  }
  const byTitleDate = new Map();
  for (const x of all.filter((x) => x.account === args.account)) {
    const key = `${x.title}|${x.date}`;
    if (!byTitleDate.has(key)) byTitleDate.set(key, x);
  }
  const candidates = [...byTitleDate.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, args.limit);
  if (!candidates.length) throw new Error(`No Sogou Weixin results matched account: ${args.account}`);
  for (const c of candidates) c.mpUrl = await resolveSogou(c);
  const browser = await launchBrowser(args.chrome);
  const files = [];
  try {
    for (let i = 0; i < candidates.length; i += 1) {
      const article = await extractArticle(browser, candidates[i].mpUrl);
      files.push(await writeDocx(article, args.out, i + 1));
    }
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(files, null, 2));
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
