#!/usr/bin/env node
// scripts/build-readonly-site.mjs
// 把 ~/ClaudeCoach 下的全部课程讲义导出成一个静态只读站点，可部署到 Cloudflare Pages，
// 在 iPad Safari 等浏览器只读浏览。复用 lecture-webview 的 main.js 渲染管线（零改动）。
//
// 用法：
//   node scripts/build-readonly-site.mjs [--root=<path>] [--out=<path>]
//   --root  用户数据根目录，默认 ~/ClaudeCoach
//   --out   产物目录，默认 <repo>/dist-site
//
// 零依赖（仅 node:fs / node:path / node:os / node:url），不进 tsc（tsconfig include 仅 src）。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import nodePath from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = nodePath.resolve(__dirname, '..');

// ---- 参数解析 ----
function parseArgs() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const [k, ...rest] = a.replace(/^--/, '').split('=');
      return [k, rest.length ? rest.join('=') : true];
    })
  );
  const expandHome = (p) => p.replace(/^~(?=$|[\\/])/, os.homedir());
  const root = args.root
    ? nodePath.resolve(expandHome(String(args.root)))
    : nodePath.join(os.homedir(), 'ClaudeCoach');
  const out = args.out ? nodePath.resolve(String(args.out)) : nodePath.join(REPO_ROOT, 'dist-site');
  return { root, out };
}

const { root: ROOT, out: OUT } = parseArgs();
const COURSES_DIR = nodePath.join(ROOT, 'workspaces', 'default-workspace', 'courses');
const LEC_SRC = nodePath.join(REPO_ROOT, 'src', 'sidebar', 'lecture-webview');
const DS_SRC = nodePath.join(REPO_ROOT, 'src', 'sidebar', 'shared', 'design-system.css');
const NM = nodePath.join(REPO_ROOT, 'node_modules');

// ---- 工具函数 ----
async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}

async function copyFile(src, dst) {
  await ensureDir(nodePath.dirname(dst));
  await fsp.copyFile(src, dst);
}

// 递归复制目录，filter(entry, absPath) 返回 false 则跳过该条目（含子树）
async function copyDir(src, dst, filter) {
  await ensureDir(dst);
  let entries;
  try {
    entries = await fsp.readdir(src, { withFileTypes: true });
  } catch {
    return 0;
  }
  let count = 0;
  for (const ent of entries) {
    const abs = nodePath.join(src, ent.name);
    if (filter && !filter(ent, abs)) continue;
    const dstEnt = nodePath.join(dst, ent.name);
    if (ent.isDirectory()) {
      count += await copyDir(abs, dstEnt, filter);
    } else if (ent.isFile()) {
      await fsp.copyFile(abs, dstEnt);
      count++;
    }
  }
  return count;
}

// 把绝对路径转成相对 courses/ 的站点路径（正斜杠），加 content/ 前缀。
// 注意：这里**不**对段做 encodeURIComponent——文件系统用真实中文名落盘，
// fetch 时浏览器会自动把 URL 里的非 ASCII 字节 percent-encode，服务端再解码回中文找到文件。
// 若预先编码落盘，服务端解码后查找的是"中文目录"而磁盘上是"%XX字面量"目录，会 404。
function contentRelPath(absPath) {
  const rel = nodePath.relative(COURSES_DIR, absPath);
  return (
    'content/' +
    rel
      .split(nodePath.sep)
      .filter(Boolean)
      .join('/')
  );
}

// ============================================================
// 1. 扫描课程 → manifest.json
//    路径从 lesson.filePath 解析（filePath 含真实 topic 目录名，如 01-chapter-topic-01），
//    不能用 topic.id 重建（topic.id 可能是去重前的 01-chapter-topic）。
// ============================================================
async function buildManifest() {
  const manifest = { generatedAt: new Date().toISOString(), courses: [] };
  let subjDirs;
  try {
    subjDirs = await fsp.readdir(COURSES_DIR, { withFileTypes: true });
  } catch {
    throw new Error(`课程目录不存在：${COURSES_DIR}`);
  }

  for (const subjEnt of subjDirs) {
    if (!subjEnt.isDirectory()) continue;
    const subj = subjEnt.name;
    const outlinePath = nodePath.join(COURSES_DIR, subj, 'outline.json');
    let outline;
    try {
      outline = JSON.parse(await fsp.readFile(outlinePath, 'utf8'));
    } catch {
      console.warn(`  ⚠ 跳过（无 outline.json 或损坏）：${subj}`);
      continue;
    }

    const topics = (outline.topics || []).map((t) => ({
      id: t.id,
      title: t.title || t.id,
      chapterNumber: t.chapterNumber,
      lessons: (t.lessons || [])
        .filter((l) => l.filePath && fs.existsSync(l.filePath))
        .map((l) => {
          const mdPath = contentRelPath(l.filePath); // content/<subj>/topics/<topicDir>/lessons/x.md
          const dir = mdPath.split('/').slice(0, -1).join('/'); // assetBaseUri
          return {
            id: l.id,
            title: l.title || l.id,
            mdPath,
            mdDir: dir,
          };
        }),
    }));

    const topicsWithLessons = topics.filter((t) => t.lessons.length > 0);
    if (topicsWithLessons.length === 0) {
      console.warn(`  ⚠ 跳过（无已生成讲义）：${subj}`);
      continue;
    }

    manifest.courses.push({
      subject: subj,
      title: outline.title || subj,
      tags: outline.tags || [],
      topics: topicsWithLessons,
    });
  }

  await ensureDir(OUT);
  await fsp.writeFile(nodePath.join(OUT, 'manifest.json'), JSON.stringify(manifest));
  return manifest;
}

// ============================================================
// 2. 复制 vendor（从 node_modules）
//    graphviz.umd.js 内嵌 wasm（base91，locateFile:()=>"" 永不 fetch 外部 .wasm），单文件即可。
//    katex CSS 里 url(fonts/*.woff2) 相对 CSS 路径，需把 fonts/ 整个复制到同级 fonts/ 下。
// ============================================================
const VENDOR_FILES = [
  ['markdown-it/dist/markdown-it.min.js', 'assets/vendor/markdown-it.min.js'],
  ['katex/dist/katex.min.js', 'assets/vendor/katex.min.js'],
  ['katex/dist/katex.min.css', 'assets/vendor/katex.min.css'],
  ['katex/dist/contrib/auto-render.min.js', 'assets/vendor/katex-auto-render.min.js'],
  ['@highlightjs/cdn-assets/highlight.min.js', 'assets/vendor/highlight.min.js'],
  ['@highlightjs/cdn-assets/styles/github-dark.min.css', 'assets/vendor/hljs-github-dark.min.css'],
  ['mermaid/dist/mermaid.min.js', 'assets/vendor/mermaid.min.js'],
  ['@hpcc-js/wasm/dist/graphviz.umd.js', 'assets/vendor/graphviz.umd.js'],
];

async function copyVendor() {
  let count = 0;
  for (const [src, dst] of VENDOR_FILES) {
    await copyFile(nodePath.join(NM, src), nodePath.join(OUT, dst));
    count++;
  }
  // katex fonts（CSS 里 url(fonts/*.woff2) 相对自身）
  await copyDir(
    nodePath.join(NM, 'katex', 'dist', 'fonts'),
    nodePath.join(OUT, 'assets', 'vendor', 'fonts')
  );
  return count;
}

// ============================================================
// 3. 复制 lecture 资产（原样，不改）
// ============================================================
const LECTURE_FILES = [
  ['main.js', 'assets/lecture/main.js'],
  ['render-helpers.js', 'assets/lecture/render-helpers.js'],
  ['style.css', 'assets/lecture/style.css'],
];

async function copyLectureAssets() {
  for (const [src, dst] of LECTURE_FILES) {
    await copyFile(nodePath.join(LEC_SRC, src), nodePath.join(OUT, dst));
  }
  await copyFile(DS_SRC, nodePath.join(OUT, 'assets', 'lecture', 'design-system.css'));
}

// ============================================================
// 4. 复制讲义内容树（每门课 topics/ → content/<encSubj>/topics/...）
//    只保留 .md 文件和 assets/ 下的所有文件。subject 段用真实中文名落盘（不预编码），
//    与 manifest 里 mdPath 一致；fetch 时浏览器自动 percent-encode URL。
// ============================================================
async function copyContent() {
  let count = 0;
  let subjDirs;
  try {
    subjDirs = await fsp.readdir(COURSES_DIR, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const subjEnt of subjDirs) {
    if (!subjEnt.isDirectory()) continue;
    const subj = subjEnt.name;
    const subjSrc = nodePath.join(COURSES_DIR, subj, 'topics');
    const subjDst = nodePath.join(OUT, 'content', subj, 'topics');
    count += await copyDir(subjSrc, subjDst, (ent, abs) => {
      if (ent.isDirectory()) return true;
      // 文件：assets/ 下全要；否则只要 .md
      const rel = nodePath.relative(subjSrc, abs);
      if (rel.split(nodePath.sep).includes('assets')) return true;
      return ent.name.endsWith('.md');
    });
  }
  return count;
}

// ============================================================
// 5. 写 SPA 静态文件（index.html / app.js / readonly.css）
// ============================================================
const INDEX_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>ClaudeCoach 讲义</title>
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'self';
    img-src 'self' data: blob:;
    style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net;
    font-src 'self' https://cdn.jsdelivr.net;
    script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://static.cloudflareinsights.com;
    connect-src 'self' https://cloudflareinsights.com;
    frame-src 'self' data: blob:;
    media-src 'self' data:;
    base-uri 'self';
    form-action 'none';
  " />
  <link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/lxgw-wenkai-screen-webfont/style.css" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fontsource/jetbrains-mono@5.2.8/400.css" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fontsource/jetbrains-mono@5.2.8/500.css" />
  <link rel="stylesheet" href="assets/vendor/katex.min.css" />
  <link rel="stylesheet" href="assets/vendor/hljs-github-dark.min.css" />
  <link rel="stylesheet" href="assets/lecture/design-system.css" />
  <link rel="stylesheet" href="assets/lecture/style.css" />
  <link rel="stylesheet" href="readonly.css" />
</head>
<body class="vscode-dark cc-readonly">
  <nav id="cc-nav" class="cc-nav">
    <div class="cc-nav-header">
      <button id="cc-nav-toggle" class="cc-nav-toggle" aria-label="切换目录" title="显示/隐藏目录">
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2" width="3.5" height="12" rx="1"/><rect x="6.5" y="2" width="7.5" height="12" rx="1"/></svg>
      </button>
      <span class="cc-nav-title">讲义</span>
      <button id="cc-theme-toggle" class="cc-nav-btn" aria-label="切换明暗">🌙</button>
    </div>
    <div id="cc-nav-tree" class="cc-nav-tree">
      <div class="cc-nav-loading">加载中…</div>
    </div>
  </nav>

  <div class="cc-main">
    <header class="lecture-header">
      <div class="lecture-meta">
        <div class="lecture-topic" id="lectureTopic"></div>
        <h1 class="lecture-title" id="lectureTitle">选择左侧讲义</h1>
      </div>
      <div class="lecture-actions"><span class="lecture-status" id="lectureStatus"></span></div>
    </header>
    <main id="lectureBody" class="lecture-body markdown-body"></main>
  </div>

  <aside id="cc-toc" class="cc-toc">
    <nav id="lectureToc" class="cc-toc-nav"></nav>
  </aside>

  <!-- 空壳：main.js 的 els.* 引用不能为 null（否则 els.chip.addEventListener 报错），readonly.css 隐藏 -->
  <button id="chip" class="lecture-chip" type="button" hidden></button>
  <div id="popover" class="lecture-comment-popover" hidden></div>
  <div id="toastContainer" class="lecture-toast-container"></div>
  <button id="btnRevert" class="btn-mini" type="button" hidden></button>
  <button id="btnReload" class="btn-mini" type="button" hidden></button>

  <script src="assets/vendor/markdown-it.min.js"></script>
  <script src="assets/vendor/katex.min.js"></script>
  <script src="assets/vendor/katex-auto-render.min.js"></script>
  <script src="assets/vendor/highlight.min.js"></script>
  <script src="assets/vendor/mermaid.min.js"></script>
  <script src="assets/vendor/graphviz.umd.js"></script>
  <script src="assets/lecture/render-helpers.js"></script>
  <script src="assets/lecture/main.js"></script>
  <script src="app.js"></script>
</body>
</html>
`;

const APP_JS = `// app.js — ClaudeCoach 讲义只读 SPA 控制器
// 驱动 lecture-webview/main.js：伪造 VS Code 的 init 消息喂给 main.js 的 message 监听器。
// main.js 离开 VS Code 时 vscode===null，所有写回交互自动 no-op（有 if(vscode) 守卫）。
(async function () {
  'use strict';

  const manifest = await fetch('manifest.json', { cache: 'no-cache' }).then((r) => {
    if (!r.ok) throw new Error('manifest 加载失败: HTTP ' + r.status);
    return r.json();
  });

  const treeEl = document.getElementById('cc-nav-tree');
  const body = document.body;

  // ---- 渲染左侧导航树 ----
  treeEl.innerHTML = '';
  if (!manifest.courses.length) {
    treeEl.innerHTML = '<div class="cc-nav-empty">没有可显示的课程</div>';
  }
  for (const course of manifest.courses) {
    const det = document.createElement('details');
    det.className = 'cc-nav-course';
    const sum = document.createElement('summary');
    sum.textContent = course.title;
    det.appendChild(sum);
    for (const topic of course.topics) {
      const topicHead = document.createElement('div');
      topicHead.className = 'cc-nav-topic-head';
      topicHead.textContent = topic.title;
      det.appendChild(topicHead);
      const ul = document.createElement('ul');
      ul.className = 'cc-nav-topic';
      for (const lesson of topic.lessons) {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href =
          '#/c/' + encodeURIComponent(course.subject) +
          '/t/' + encodeURIComponent(topic.id) +
          '/l/' + encodeURIComponent(lesson.id);
        a.textContent = lesson.title;
        a.dataset.subject = course.subject;
        a.dataset.topicId = topic.id;
        a.dataset.lessonId = lesson.id;
        a.dataset.mdPath = lesson.mdPath;
        a.dataset.mdDir = lesson.mdDir;
        li.appendChild(a);
        ul.appendChild(li);
      }
      det.appendChild(ul);
    }
    treeEl.appendChild(det);
  }

  // ---- 索引：快速查课/节 ----
  const courseBySubj = new Map(manifest.courses.map((c) => [c.subject, c]));
  function findLesson(subj, topicId, lessonId) {
    const c = courseBySubj.get(subj);
    if (!c) return null;
    const t = c.topics.find((x) => x.id === topicId);
    if (!t) return null;
    const l = t.lessons.find((x) => x.id === lessonId);
    if (!l) return null;
    return { course: c, topic: t, lesson: l };
  }

  // ---- 高亮当前导航项 ----
  function setActive(subj, topicId, lessonId) {
    document.querySelectorAll('.cc-nav a.active').forEach((a) => a.classList.remove('active'));
    const sel =
      '.cc-nav a[data-subject=' + cssQuote(subj) +
      '][data-topic-id=' + cssQuote(topicId) +
      '][data-lesson-id=' + cssQuote(lessonId) + ']';
    const cur = document.querySelector(sel);
    if (cur) {
      cur.classList.add('active');
      // 展开所属课程
      const det = cur.closest('details');
      if (det) det.open = true;
      cur.scrollIntoView({ block: 'nearest' });
    }
  }

  // ---- 渲染讲义：fetch md → 伪造 init 消息驱动 main.js ----
  async function renderLesson(subj, topicId, lessonId) {
    const found = findLesson(subj, topicId, lessonId);
    if (!found) return false;
    const { course, topic, lesson } = found;

    document.getElementById('lectureTopic').textContent = topic.title;
    document.getElementById('lectureTitle').textContent = lesson.title;
    document.getElementById('lectureStatus').textContent = '加载中…';

    let content = '';
    try {
      const r = await fetch(lesson.mdPath, { cache: 'no-cache' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      content = await r.text();
      document.getElementById('lectureStatus').textContent = '';
    } catch (e) {
      content =
        '> ⚠ 讲义加载失败：' + e.message + '\\n\\n> 路径：' + lesson.mdPath;
      document.getElementById('lectureStatus').textContent = '加载失败';
    }

    // assetBaseUri 用站点相对路径（mdDir），main.js:1441 拼成 mdDir + '/' + 'assets/x.svg'。
    // 浏览器相对当前文档解析 → 根域与子路径部署都对。
    const idMatch = lesson.id.match(/^(\\d+)-(\\d+)/);
    const chapN = idMatch ? parseInt(idMatch[1]) : (topic.chapterNumber || 1);
    const lessonX = idMatch ? parseInt(idMatch[2]) : (topic.lessons.indexOf(lesson) + 1);
    const chapPrefix = 'Chap ' + chapN + '.' + lessonX;
    window.postMessage(
      {
        type: 'init',
        content,
        assetBaseUri: lesson.mdDir,
        lessonTitle: lesson.title,
        topicTitle: topic.title,
        subject: course.subject,
        chapPrefix,
        filePath: '',
        applyMode: 'preview-confirm',
        highlightChangesMs: 0,
      },
      '*'
    );

    // 滚动到顶
    const bodyEl = document.getElementById('lectureBody');
    if (bodyEl) bodyEl.scrollTop = 0;
    window.scrollTo(0, 0);
    return true;
  }

  // ---- hash 路由 ----
  async function route() {
    const m = location.hash.match(/^#\\/c\\/([^/]+)\\/t\\/([^/]+)\\/l\\/([^/]+)$/);
    if (!m) {
      // 默认跳到第一门课的第一节
      const c = manifest.courses[0];
      if (c && c.topics[0] && c.topics[0].lessons[0]) {
        location.hash =
          '#/c/' + encodeURIComponent(c.subject) +
          '/t/' + encodeURIComponent(c.topics[0].id) +
          '/l/' + encodeURIComponent(c.topics[0].lessons[0].id);
      }
      return;
    }
    const subj = decodeURIComponent(m[1]);
    const topicId = decodeURIComponent(m[2]);
    const lessonId = decodeURIComponent(m[3]);
    setActive(subj, topicId, lessonId);
    await renderLesson(subj, topicId, lessonId);
  }

  window.addEventListener('hashchange', route);
  route();

  // ---- 导航折叠（iPad）----
  // 按钮在 #cc-nav 外面（fab），收起后按钮仍在可重新展开。
  // 用 cc-nav-open 控制窄屏抽屉；宽屏用 grid-template-columns 控制。
  const navToggle = document.getElementById('cc-nav-toggle');
  let navOpen = window.matchMedia('(max-width: 820px)').matches ? false : true;
  const narrowMq = window.matchMedia('(max-width: 820px)');
  function applyNavState() {
    if (narrowMq.matches) {
      // 窄屏：抽屉模式，用 cc-nav-open 控制
      body.classList.toggle('cc-nav-open', navOpen);
      body.classList.remove('cc-nav-collapsed');
    } else {
      // 宽屏：grid 模式，用 cc-nav-collapsed 控制
      body.classList.toggle('cc-nav-collapsed', !navOpen);
      body.classList.remove('cc-nav-open');
    }
    navToggle.setAttribute('aria-expanded', navOpen ? 'true' : 'false');
  }
  applyNavState();
  // 响应横竖屏切换：重置状态匹配新视口
  narrowMq.addEventListener('change', () => {
    if (narrowMq.matches) navOpen = false; else navOpen = true;
    applyNavState();
  });
  navToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    navOpen = !navOpen;
    applyNavState();
  });
  // 窄屏点遮罩收起
  document.addEventListener('click', (e) => {
    if (!narrowMq.matches || !navOpen) return;
    if (!e.target.closest('#cc-nav') && !e.target.closest('#cc-nav-toggle')) {
      navOpen = false;
      applyNavState();
    }
  });

  // ---- 触摸滑动展开/收起（iPad）----
  // 左边缘右滑 → 展开；侧栏上左滑 → 收起
  const EDGE_ZONE = 60;       // 覆盖收起后 48px 窄条 + 余量
  const SWIPE_THRESHOLD = 50;  // 水平位移超过多少算"滑动"（非误触）
  const VERTICAL_LIMIT = 60;   // 垂直位移超过这个则判定为滚动，放弃
  let touchStartX = 0, touchStartY = 0, touchTracking = false, touchFromEdge = false;

  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    touchStartX = t.clientX;
    touchStartY = t.clientY;
    touchTracking = true;
    touchFromEdge = touchStartX < EDGE_ZONE;
  }, { passive: true });

  // 从边缘起的水平滑动 → 阻止 sidebar 的滚动吃掉 touch 事件
  document.addEventListener('touchmove', (e) => {
    if (!touchTracking || !touchFromEdge) return;
    const t = e.touches[0];
    if (!t) return;
    const dx = t.clientX - touchStartX;
    const dy = t.clientY - touchStartY;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 10) {
      e.preventDefault();
    }
  }, { passive: false });

  document.addEventListener('touchend', (e) => {
    if (!touchTracking) return;
    touchTracking = false;
    touchFromEdge = false;
    const t = e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - touchStartX;
    const dy = t.clientY - touchStartY;
    // 垂直位移大 → 是滚动，不处理
    if (Math.abs(dy) > VERTICAL_LIMIT) return;
    // 水平位移不够 → 误触
    if (Math.abs(dx) < SWIPE_THRESHOLD) return;

    if (dx > 0 && touchStartX < EDGE_ZONE && !navOpen) {
      // 从左边缘右滑 → 展开
      navOpen = true;
      applyNavState();
    } else if (dx < 0 && navOpen) {
      // 左滑 → 收起（不管起点在哪，只要当前是展开且左滑）
      navOpen = false;
      applyNavState();
    }
  }, { passive: true });

  document.addEventListener('touchcancel', () => {
    touchTracking = false;
    touchFromEdge = false;
  }, { passive: true });

  // ---- 明暗切换 ----
  const themeBtn = document.getElementById('cc-theme-toggle');
  themeBtn.addEventListener('click', () => {
    const dark = !body.classList.contains('vscode-dark');
    body.classList.toggle('vscode-dark', dark);
    body.classList.toggle('vscode-light', !dark);
    themeBtn.textContent = dark ? '🌙' : '☀️';
    // mermaid 主题靠 body class(vscode-dark) 决定；切主题后重渲当前节
    route();
  });

  // ---- helpers ----
  function cssQuote(s) {
    return '"' + String(s).replace(/["\\\\]/g, '\\\\$&') + '"';
  }
})();
`;

const READONLY_CSS = `/* readonly.css — ClaudeCoach 讲义只读站点样式
   1. --vscode-* 变量 fallback（浏览器无 VS Code 注入，style.css 全靠它）
   2. 隐藏所有交互元素（main.js 在 vscode=null 时仍渲染 DOM）
   3. SPA 导航栏 + iPad 布局
*/

/* ===== 1. VS Code CSS 变量 fallback =====
   从 style.css + design-system.css grep 收集的全部 --vscode-* 变量。
   字体：霞鹜文楷屏幕版（正文中文）+ JetBrains Mono（代码），
   通过 jsdelivr CDN 加载，@font-face 在 <link> 引入的 CSS 里。 */
:root,
body.vscode-dark {
  --vscode-editor-background: #1e1e1e;
  --vscode-editor-foreground: #d4d4d4;
  --vscode-foreground: #d4d4d4;
  --vscode-descriptionForeground: #9d9d9d;
  --vscode-button-background: #0e639c;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #1177bb;
  --vscode-input-background: #313131;
  --vscode-input-foreground: #cccccc;
  --vscode-input-border: #3c3c3c;
  --vscode-sideBar-background: #252526;
  --vscode-panel-border: #2d2d30;
  --vscode-menu-background: #252526;
  --vscode-menu-foreground: #cccccc;
  --vscode-menu-border: #454545;
  --vscode-menu-selectionBackground: #04395e;
  --vscode-menu-selectionForeground: #ffffff;
  --vscode-list-activeSelectionBackground: #04395e;
  --vscode-list-activeSelectionForeground: #ffffff;
  --vscode-textLink-foreground: #4daafc;
  --vscode-textCodeBlock-background: #1e1e1e;
  --vscode-editor-selectionBackground: #264f78;
  --vscode-editor-font-family: "JetBrains Mono", "LXGW WenKai Screen", ui-monospace, "SF Mono", Consolas, monospace;
  --vscode-font-family: "LXGW WenKai Screen", "JetBrains Mono", system-ui, sans-serif;
  --vscode-font-size: 16px;
  --vscode-editor-font-size: 15px;
  --vscode-charts-yellow: #c4a000;
}
body.vscode-light {
  --vscode-editor-background: #ffffff;
  --vscode-editor-foreground: #1f1f1f;
  --vscode-foreground: #1f1f1f;
  --vscode-descriptionForeground: #616161;
  --vscode-button-background: #0078d4;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #006cbe;
  --vscode-input-background: #ffffff;
  --vscode-input-foreground: #1f1f1f;
  --vscode-input-border: #cecece;
  --vscode-sideBar-background: #f3f3f3;
  --vscode-panel-border: #e0e0e0;
  --vscode-menu-background: #ffffff;
  --vscode-menu-foreground: #1f1f1f;
  --vscode-menu-border: #e0e0e0;
  --vscode-menu-selectionBackground: #0064bd;
  --vscode-menu-selectionForeground: #ffffff;
  --vscode-list-activeSelectionBackground: #0064bd;
  --vscode-list-activeSelectionForeground: #ffffff;
  --vscode-textLink-foreground: #0066b8;
  --vscode-textCodeBlock-background: #f6f8fa;
  --vscode-editor-selectionBackground: #add6ff;
  --vscode-charts-yellow: #b58900;
}

/* 正文字号放大、行高加宽，适合长文阅读（霞鹜文楷在小字号下偏糊，16px 起最佳） */
body.cc-readonly .lecture-body {
  font-size: 16px;
  line-height: 1.8;
}
body.cc-readonly .lecture-body p,
body.cc-readonly .lecture-body li {
  line-height: 1.85;
}
/* 标题用霞鹜文楷，权重靠 bold */
body.cc-readonly .lecture-body h1,
body.cc-readonly .lecture-body h2,
body.cc-readonly .lecture-body h3,
body.cc-readonly .lecture-body h4 {
  font-family: "LXGW WenKai Screen", system-ui, sans-serif;
  font-weight: 700;
}
/* 代码块、行内代码用 JetBrains Mono */
body.cc-readonly .lecture-body pre,
body.cc-readonly .lecture-body code,
body.cc-readonly .lecture-body .cc-widget-iframe {
  font-family: "JetBrains Mono", ui-monospace, "SF Mono", Consolas, monospace;
}

/* ===== 2. 隐藏所有交互元素 ===== */
body.cc-readonly #chip,
body.cc-readonly #popover,
body.cc-readonly #toastContainer,
body.cc-readonly #btnRevert,
body.cc-readonly #btnReload,
body.cc-readonly .lecture-actions-left,
body.cc-readonly .lecture-status:empty,
body.cc-readonly .cc-suggest,
body.cc-readonly .lecture-img-delete-btn,
body.cc-readonly .cc-widget-btn-more,
body.cc-readonly .cc-widget-btn[data-action="reload"],
body.cc-readonly .cc-widget-btn[data-action="copy-source"],
body.cc-readonly .cc-widget-btn[data-action="toggle-source"],
body.cc-readonly .cc-widget-toolbar,
body.cc-readonly .cc-chart-btn,
body.cc-readonly .cc-chart-toolbar,
body.cc-readonly .lecture-undo-pill,
body.cc-readonly .lecture-context-menu,
body.cc-readonly .lecture-suggestion-bubble,
body.cc-readonly .cc-widget-console,
body.cc-readonly .cc-widget-error {
  display: none !important;
}

/* YouTube 缩略图隐私屏蔽：CSP img-src 'self' 拦 ytimg + CSS 清背景图双保险 */
body.cc-readonly .cc-video-thumb {
  background-image: none !important;
  background: var(--vscode-sideBar-background, #2d2d30) !important;
}

/* ===== 3. SPA 导航栏 + iPad 布局 =====
   折叠按钮镶嵌在 sidebar 头部，收起时侧栏缩成窄条（像 VS Code），按钮仍在。 */
body.cc-readonly {
  display: grid;
  grid-template-columns: 280px 1fr 220px;
  grid-template-areas: "nav main toc";
  min-height: 100vh;
  margin: 0;
  background: var(--vscode-editor-background);
  color: var(--vscode-foreground);
  font-family: var(--vscode-font-family);
  -webkit-text-size-adjust: 100%;
  transition: grid-template-columns 200ms ease;
}
/* 收起：侧栏缩到 48px 窄条，只露出图标按钮；内容树隐藏 */
body.cc-readonly.cc-nav-collapsed {
  grid-template-columns: 48px 1fr 220px;
}
body.cc-readonly.cc-nav-collapsed #cc-nav-tree,
body.cc-readonly.cc-nav-collapsed .cc-nav-title {
  display: none;
}
body.cc-readonly.cc-nav-collapsed .cc-nav-header {
  flex-direction: column;
  padding: 8px 0;
  gap: 8px;
  align-items: center;
}
body.cc-readonly.cc-nav-collapsed .cc-nav-header .cc-nav-btn {
  display: none;
}

/* 折叠/展开按钮：内嵌在 header，无边框，和标题融为一体 */
.cc-nav-toggle {
  background: transparent;
  border: none;
  color: var(--vscode-foreground);
  cursor: pointer;
  width: 28px;
  height: 28px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  opacity: 0.85;
  flex-shrink: 0;
  transition: background 100ms ease, opacity 100ms ease;
}
.cc-nav-toggle:hover {
  background: var(--vscode-editor-selectionBackground);
  opacity: 1;
}

#cc-nav {
  grid-area: nav;
  border-right: 1px solid var(--vscode-panel-border);
  background: var(--vscode-sideBar-background);
  overflow-y: auto;
  position: sticky;
  top: 0;
  height: 100vh;
  transition: grid-column 200ms ease;
}
.cc-nav-header {
  position: sticky;
  top: 0;
  background: var(--vscode-sideBar-background);
  padding: 10px 10px;
  border-bottom: 1px solid var(--vscode-panel-border);
  display: flex;
  align-items: center;
  gap: 8px;
  z-index: 2;
}
.cc-nav-title {
  font-weight: 600;
  flex: 1;
  font-size: 15px;
  font-family: "LXGW WenKai Screen", system-ui, sans-serif;
}
.cc-nav-btn {
  background: transparent;
  border: none;
  color: var(--vscode-foreground);
  cursor: pointer;
  font-size: 16px;
  padding: 4px 8px;
  border-radius: 4px;
  line-height: 1;
}
.cc-nav-btn:hover {
  background: var(--vscode-editor-selectionBackground);
}
.cc-nav-tree {
  padding: 4px 0 40px;
}
.cc-nav-loading,
.cc-nav-empty {
  padding: 16px;
  color: var(--vscode-descriptionForeground);
  font-size: 13px;
}
.cc-nav-course {
  margin: 0;
}
.cc-nav-course > summary {
  cursor: pointer;
  padding: 8px 14px;
  font-weight: 600;
  font-size: 13px;
  color: var(--vscode-foreground);
  list-style: none;
}
.cc-nav-course > summary::-webkit-details-marker {
  display: none;
}
.cc-nav-course > summary::before {
  content: "▸";
  display: inline-block;
  margin-right: 6px;
  transition: transform 150ms ease;
  color: var(--vscode-descriptionForeground);
  font-size: 10px;
}
.cc-nav-course[open] > summary::before {
  transform: rotate(90deg);
}
.cc-nav-course > summary:hover {
  background: var(--vscode-editor-selectionBackground);
}
.cc-nav-topic-head {
  padding: 8px 24px 4px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--vscode-descriptionForeground);
  font-weight: 600;
}
.cc-nav-topic {
  list-style: none;
  padding: 0 0 6px;
  margin: 0;
}
.cc-nav-topic li {
  padding: 0;
}
.cc-nav-topic a {
  display: block;
  padding: 6px 24px;
  color: var(--vscode-foreground);
  text-decoration: none;
  font-size: 13px;
  line-height: 1.4;
  border-left: 2px solid transparent;
  transition: background 80ms ease;
}
.cc-nav-topic a:hover {
  background: var(--vscode-editor-selectionBackground);
}
.cc-nav-topic a.active {
  border-left-color: var(--vscode-button-background);
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
}

.cc-main {
  grid-area: main;
  min-width: 0;
  overflow-x: hidden;
}
body.cc-readonly .lecture-header {
  position: relative;
  max-width: 860px;
  margin: 0 auto;
  padding: 24px 32px 0;
}
body.cc-readonly main.lecture-body {
  max-width: 860px;
  margin: 0 auto;
  padding: 8px 32px 120px;
}

/* ===== 右侧 TOC 目录（MkDocs Material 风格）===== */
.cc-toc {
  grid-area: toc;
  position: sticky;
  top: 0;
  height: 100vh;
  overflow-y: auto;
  border-left: 1px solid var(--vscode-panel-border);
  background: var(--vscode-sideBar-background);
  padding: 20px 10px 40px;
  scrollbar-width: thin;
  z-index: 1;
}
.cc-toc::-webkit-scrollbar { width: 4px; }
.cc-toc::-webkit-scrollbar-thumb { background: var(--vscode-panel-border); border-radius: 2px; }
.cc-toc-nav { font-size: 13px; }
.lecture-toc-list { list-style: none; padding: 0; margin: 0; }
.lecture-toc-item { padding: 0; }
.lecture-toc-link {
  display: block;
  padding: 4px 8px;
  color: var(--vscode-descriptionForeground);
  text-decoration: none;
  border-left: 2px solid transparent;
  transition: color 100ms ease, border-color 100ms ease;
  line-height: 1.4;
  cursor: pointer;
}
.lecture-toc-link:hover { color: var(--vscode-foreground); }
.lecture-toc-link.lecture-toc-active {
  color: var(--vscode-textLink-foreground);
  border-left-color: var(--vscode-button-background);
  font-weight: 600;
}
.lecture-toc-item.level-3 .lecture-toc-link {
  padding-left: 18px;
  font-size: 12px;
  border-left: 2px solid var(--vscode-button-background);
  opacity: 0.8;
}
.lecture-toc-item.level-4 .lecture-toc-link {
  padding-left: 28px;
  font-size: 12px;
  border-left: 2px solid var(--vscode-button-background);
  opacity: 0.7;
}

/* ===== 4. iPad Safari 适配 ===== */
/* 旧版 Safari 不支持 ResizeObserver → widget iframe 高度卡住，让内部可滚动降级 */
@supports not (resize: both) {
  body.cc-readonly .cc-widget-iframe {
    overflow: auto !important;
    min-height: 320px;
  }
}
/* 安全区（iPad 横屏刘海/圆角） */
@supports (padding: env(safe-area-inset-top)) {
  body.cc-readonly .cc-nav-header {
    padding-top: calc(12px + env(safe-area-inset-top));
  }
  body.cc-readonly .lecture-header {
    padding-top: calc(24px + env(safe-area-inset-top));
    padding-left: calc(32px + env(safe-area-inset-left));
    padding-right: calc(32px + env(safe-area-inset-right));
  }
  body.cc-readonly main.lecture-body {
    padding-left: calc(32px + env(safe-area-inset-left));
    padding-right: calc(32px + env(safe-area-inset-right));
    padding-bottom: calc(120px + env(safe-area-inset-bottom));
  }
}
/* 窄屏（竖屏 iPad / 手机）导航变抽屉 */
@media (max-width: 820px) {
  body.cc-readonly {
    grid-template-columns: 48px 1fr 160px;
    grid-template-areas: "nav main toc";
  }
  /* 窄屏收起时只留窄条（和宽屏一致），展开时正常宽度 */
  body.cc-readonly:not(.cc-nav-open) {
    grid-template-columns: 48px 1fr 160px;
  }
  body.cc-readonly.cc-nav-open {
    grid-template-columns: 280px 1fr 0;
  }
  body.cc-readonly.cc-nav-open .cc-toc {
    display: none;
  }
  body.cc-readonly .cc-toc {
    padding: 16px 6px 40px;
  }
  body.cc-readonly .cc-toc-link {
    padding: 3px 4px;
    font-size: 12px;
  }
  body.cc-readonly #cc-nav {
    position: fixed;
    top: 0;
    left: 0;
    width: 280px;
    height: 100vh;
    z-index: 150;
    box-shadow: 2px 0 16px rgba(0, 0, 0, 0.5);
  }
  /* 收起：窄条只露图标，内容树隐藏 */
  body.cc-readonly:not(.cc-nav-open) #cc-nav {
    width: 48px;
  }
  body.cc-readonly:not(.cc-nav-open) #cc-nav-tree,
  body.cc-readonly:not(.cc-nav-open) .cc-nav-title,
  body.cc-readonly:not(.cc-nav-open) #cc-nav .cc-nav-btn {
    display: none;
  }
  body.cc-readonly:not(.cc-nav-open) .cc-nav-header {
    flex-direction: column;
    padding: 8px 0;
    align-items: center;
  }
  /* 展开时加个遮罩，点遮罩收起 */
  body.cc-readonly.cc-nav-open::after {
    content: "";
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 140;
  }
}
`;

async function writeStaticFiles() {
  await fsp.writeFile(nodePath.join(OUT, 'index.html'), INDEX_HTML);
  await fsp.writeFile(nodePath.join(OUT, 'app.js'), APP_JS);
  await fsp.writeFile(nodePath.join(OUT, 'readonly.css'), READONLY_CSS);
}

// ============================================================
// main
// ============================================================
async function main() {
  console.log(`构建只读讲义站点`);
  console.log(`  数据根：${ROOT}`);
  console.log(`  产物：${OUT}`);

  // 清空产物目录（避免旧文件残留）
  try {
    await fsp.rm(OUT, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
  await ensureDir(OUT);

  console.log('  [1/5] 扫描课程 → manifest.json');
  const manifest = await buildManifest();
  const lessonCount = manifest.courses.reduce(
    (n, c) => n + c.topics.reduce((m, t) => m + t.lessons.length, 0),
    0
  );
  console.log(`        课程 ${manifest.courses.length} 门，讲义 ${lessonCount} 节`);

  console.log('  [2/5] 复制 vendor');
  const vendorCount = await copyVendor();
  console.log(`        ${vendorCount} 个文件 + fonts`);

  console.log('  [3/5] 复制 lecture 资产');
  await copyLectureAssets();
  console.log('        main.js / render-helpers.js / style.css / design-system.css');

  console.log('  [4/5] 复制讲义内容树');
  const contentCount = await copyContent();
  console.log(`        ${contentCount} 个文件`);

  console.log('  [5/5] 写 SPA 静态文件');
  await writeStaticFiles();
  console.log('        index.html / app.js / readonly.css');

  console.log('');
  console.log('✓ 构建完成 → ' + OUT);
  console.log('  本地预览: npx http-server ' + nodePath.basename(OUT) + ' -p 8080');
  console.log('  部署: wrangler pages deploy ' + nodePath.basename(OUT) + ' --project-name claudecoach-lectures');
}

main().catch((e) => {
  console.error('✗ 构建失败：', e);
  process.exit(1);
});
