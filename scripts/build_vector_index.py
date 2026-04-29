#!/usr/bin/env python3
"""
独立 vector index 构建脚本（不依赖 VS Code 运行时）。

复刻 src/materials/materialManager.ts 的 _chunkText (heading-aware) +
src/materials/vectorIndex.ts 的存储格式，调用 SiliconFlow /v1/embeddings
为指定 materialId 建索引。

运行后扩展启动会自动加载这份索引（同 schema 同路径）。

usage:
  python build_vector_index.py <subject> <materialId> [--token TOKEN] [--model BAAI/bge-m3]
"""
import os
import re
import json
import hashlib
import urllib.request
import urllib.error
import sys
import io
import time
from pathlib import Path

# Windows shells default to gbk for stdout/stderr; force UTF-8 (only if run as script)
if __name__ == "__main__":
    if hasattr(sys.stdout, "buffer"):
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "buffer"):
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

API_BASE = "https://api.siliconflow.cn/v1"
DEFAULT_MODEL = "BAAI/bge-m3"
BATCH_SIZE = 16
MAX_RETRIES = 2

CC_ROOT = Path(os.environ.get("USERPROFILE") or os.path.expanduser("~")) / "ClaudeCoach"


# ----------------- 复刻 _chunkText (heading-aware) -----------------

CHAPTER_RE = re.compile(
    r"^(?:#{1,2}\s+)?"
    r"(第\s*[一二三四五六七八九十百零〇0-9]+\s*章[^\n]*"
    r"|Chapter\s+\d+[^\n]*"
    r"|第\s*\d+\s*部分[^\n]*)",
    re.IGNORECASE,
)
SECTION_RE = re.compile(
    r"^(?:#{2,4}\s+)?("
    r"\d+\.\d+(?:\.\d+)?\s+[^\n]+"             # 数字小节 3.2 / 3.2.1
    r"|\d+\.[A-Z](?:\s+|\.|：)[^\n]+"          # Axler 风格 2.A / 3.B
    r"|§\s*\d+(?:\.\d+)*[^\n]*"                # § 风格
    r")"
)
MD_HEADING_RE = re.compile(r"^(#{1,4})\s+(.+)$")


def normalize_heading(raw: str) -> str:
    s = re.sub(r"\s+", " ", raw)
    s = re.sub(r"[、。：:.,;；]+$", "", s)
    return s.strip()[:60]


def split_long_text(text: str, max_len: int) -> list:
    """简单按句号 / 换行切长段。复刻 _splitLongText 行为。"""
    if len(text) <= max_len:
        return [text]
    # 句号优先
    parts = re.split(r"(?<=[。．！？!?\n])", text)
    out = []
    cur = ""
    for p in parts:
        if not p:
            continue
        if len(cur) + len(p) > max_len and cur:
            out.append(cur)
            cur = p
        else:
            cur += p
    if cur:
        out.append(cur)
    # 兜底：单段超长就硬切
    final = []
    for seg in out:
        if len(seg) <= max_len * 1.5:
            final.append(seg)
        else:
            for i in range(0, len(seg), max_len):
                final.append(seg[i : i + max_len])
    return final


def chunk_text(text: str) -> list:
    """复刻 src/materials/materialManager.ts:_chunkText (heading-aware)."""
    normalized = text.replace("\r\n", "\n").replace("\t", " ").strip()
    if not normalized:
        return []

    paragraphs = [p.strip() for p in re.split(r"\n{2,}", normalized) if p.strip()]
    chunks = []
    current = ""
    chapter_label = ""
    section_label = ""

    def update_heading(p: str):
        nonlocal chapter_label, section_label
        m = CHAPTER_RE.match(p)
        if m:
            chapter_label = normalize_heading(m.group(1))
            section_label = ""
            return True
        m = SECTION_RE.match(p)
        if m:
            section_label = normalize_heading(m.group(1))
            return True
        m = MD_HEADING_RE.match(p)
        if m:
            level = len(m.group(1))
            title = normalize_heading(m.group(2))
            if level <= 2:
                chapter_label = title
                section_label = ""
            else:
                section_label = title
            return True
        return False

    def decorate(raw: str) -> str:
        parts = []
        if chapter_label:
            parts.append(chapter_label)
        if section_label:
            parts.append(section_label)
        if not parts:
            return raw
        first_line = raw.split("\n", 1)[0].strip()
        last_part = parts[-1]
        if last_part and last_part in first_line:
            return raw
        return f"[{' / '.join(parts)}]\n\n{raw}"

    for paragraph in paragraphs:
        update_heading(paragraph)
        segments = (
            split_long_text(paragraph, 700) if len(paragraph) > 900 else [paragraph]
        )
        for segment in segments:
            if not segment:
                continue
            nxt = (current + "\n\n" + segment) if current else segment
            if len(nxt) > 900 and current:
                chunks.append(decorate(current))
                current = segment
            else:
                current = nxt

    if current:
        chunks.append(decorate(current))

    return chunks


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:32]


# ----------------- Embedding API -----------------


def embed_batch(texts, token: str, model: str, attempt: int = 0) -> list:
    """调 /v1/embeddings，返回 list[list[float]]。失败抛异常。"""
    body = json.dumps({"model": model, "input": texts}).encode("utf-8")
    req = urllib.request.Request(
        f"{API_BASE}/embeddings",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8") if hasattr(e, "read") else ""
        raise RuntimeError(f"HTTP {e.code}: {body[:200]}")
    except (urllib.error.URLError, TimeoutError) as e:
        if attempt < MAX_RETRIES:
            time.sleep(0.5 * 2**attempt)
            return embed_batch(texts, token, model, attempt + 1)
        raise

    if "data" not in payload:
        raise RuntimeError(f"missing data: {str(payload)[:200]}")
    items = sorted(payload["data"], key=lambda x: x.get("index", 0))
    return [item["embedding"] for item in items]


# ----------------- 主流程 -----------------


def find_material(subject: str, material_id: str):
    """读 materials index 找资料."""
    idx = json.loads(
        (CC_ROOT / "library" / "materials" / "index.json").read_text(encoding="utf-8")
    )
    for m in idx.get("materials", []):
        if m["id"] == material_id and m["subject"] == subject:
            return m
    raise SystemExit(f"未找到 {subject}/{material_id}")


def build_chapter_index(material: dict, chunks: list, token: str, model: str):
    """构建章节级 embedding 索引（v2 two-stage retrieval 第一阶段）。

    返回 List[ChapterVector]：每章 { chapterIndex, label, chunkRange, textHash, vector }。
    需要 summary.json 提供 chapter 结构；若不存在或失败返回 []。
    """
    summary_path = Path(material["summaryPath"])
    if not summary_path.exists():
        return []
    try:
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
    except Exception:
        return []
    chapters = summary.get("chapters", []) or []
    if not chapters:
        return []

    # 1. 章节代表文本
    chapter_texts = []
    for c in chapters:
        head = " ".join(filter(None, [str(c.get("chapterNumber", "")).strip(), c.get("title", "")]))
        body = c.get("summary", "") or ""
        keys = "；".join((c.get("keyPoints", []) or [])[:5])
        text = "\n".join(filter(None, [head, body, keys]))
        chapter_texts.append(text)

    # 2. 在 chunks 数组里反向定位每章 [start, end)
    starts = []
    for ci, c in enumerate(chapters):
        num = str(c.get("chapterNumber", "")).strip()
        title_head = (c.get("title", "") or "")[:12]
        probe1 = f"第 {num} 章" if num else ""
        probe2 = f"Chapter {num}" if num else ""
        probe3 = f"{num}." if num else ""
        prev_start = starts[-1] if starts else 0
        found_at = -1
        for i in range(prev_start, len(chunks)):
            head = chunks[i][:220]
            if (
                (probe1 and probe1 in head) or
                (probe2 and probe2 in head) or
                (title_head and title_head in head and (probe3 in head or ci == 0))
            ):
                found_at = i
                break
        if found_at < 0:
            # 兜底：按章节索引在 chunks 中等比例分配
            found_at = int(ci / max(1, len(chapters)) * len(chunks))
        starts.append(found_at)

    ranges = []
    for i, s in enumerate(starts):
        end = starts[i + 1] if i + 1 < len(starts) else len(chunks)
        ranges.append([s, max(s + 1, end)])

    # 3. 批量 embed（章节通常 < 100，一次到位）
    print(f"  → 建章节索引 ({len(chapter_texts)} 章)...", end=" ", flush=True)
    try:
        vecs = embed_batch(chapter_texts, token, model)
    except Exception as e:
        print(f"失败：{e}")
        return []

    out = []
    for ci, (text, vec, rng) in enumerate(zip(chapter_texts, vecs, ranges)):
        out.append({
            "chapterIndex": ci,
            "label": chapters[ci].get("title", f"第 {chapters[ci].get('chapterNumber', ci + 1)} 章"),
            "chunkRange": rng,
            "textHash": text_hash(text),
            "vector": vec,
        })
    print(f"✓")
    return out


def build_index(subject: str, material_id: str, token: str, model: str, force_rebuild: bool = False):
    material = find_material(subject, material_id)
    out_path = Path(material["storageDir"]) / "vector-index.json"

    # 增量复用：v1 / v2 都尝试加载
    existing = None
    existing_chunks_by_hash = {}
    if out_path.exists() and not force_rebuild:
        try:
            existing = json.loads(out_path.read_text(encoding="utf-8"))
            for c in existing.get("chunks", []):
                existing_chunks_by_hash[c.get("textHash")] = c
            ver = existing.get("version", "?")
            existing_model = existing.get("model", "")
            if existing_model != model:
                print(f"  ⚠ 模型变更（{existing_model} → {model}），完全重建")
                existing = None
                existing_chunks_by_hash = {}
            else:
                print(f"  ↻ 复用 v{ver} 索引，{len(existing_chunks_by_hash)} 个 chunk hash")
        except Exception as e:
            print(f"  ⚠ 读旧索引失败：{e}（重建）")
            existing = None

    print(f"=== 处理 {material['fileName']} ===")
    text_path = Path(material["textPath"])
    if not text_path.exists():
        print(f"  ⚠ extracted.txt 不存在，跳过")
        return False
    print(f"读取 extracted.txt: {text_path.stat().st_size // 1024} KB")
    text = text_path.read_text(encoding="utf-8", errors="replace")
    chunks = chunk_text(text)
    print(f"切分 {len(chunks)} 块（heading-aware）")
    if not chunks:
        print("(空文本，跳过)")
        return False

    # 准备 keep / todo
    keep_chunks = []
    todo_indices = []
    todo_texts = []
    for i, txt in enumerate(chunks):
        h = text_hash(txt)
        existing_chunk = existing_chunks_by_hash.get(h)
        if existing_chunk and existing_chunk.get("vector"):
            keep_chunks.append({
                "chunkIndex": i,
                "textHash": h,
                "text": txt,
                "vector": existing_chunk["vector"],
            })
        else:
            todo_indices.append(i)
            todo_texts.append(txt)

    print(f"  增量复用 {len(keep_chunks)} 块 / 新建 {len(todo_texts)} 块")
    fresh_chunks = []
    if todo_texts:
        t_start = time.time()
        for k in range(0, len(todo_texts), BATCH_SIZE):
            batch_texts = todo_texts[k : k + BATCH_SIZE]
            batch_indices = todo_indices[k : k + BATCH_SIZE]
            try:
                vecs = embed_batch(batch_texts, token, model)
            except Exception as e:
                print(f"\n  ⚠ batch {k // BATCH_SIZE} 失败：{e}")
                return False
            for j, (txt, vec, idx) in enumerate(zip(batch_texts, vecs, batch_indices)):
                fresh_chunks.append({
                    "chunkIndex": idx,
                    "textHash": text_hash(txt),
                    "text": txt,
                    "vector": vec,
                })
            done = len(keep_chunks) + len(fresh_chunks)
            print(f"  [{done}/{len(chunks)}] 耗时 {time.time() - t_start:.1f}s", end="\r")
        print()

    all_chunks = sorted(keep_chunks + fresh_chunks, key=lambda c: c["chunkIndex"])
    if not all_chunks:
        print("无 chunk 产出")
        return False
    dim = len(all_chunks[0]["vector"])

    # 构章节索引（v2）
    chapter_vectors = build_chapter_index(material, chunks, token, model)

    out = {
        "version": 2 if chapter_vectors else 1,
        "materialId": material_id,
        "model": model,
        "dimension": dim,
        "chunks": all_chunks,
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
    }
    if chapter_vectors:
        out["chapters"] = chapter_vectors

    out_path.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    size_mb = out_path.stat().st_size / 1024 / 1024
    chapter_info = f" + {len(chapter_vectors)} 章" if chapter_vectors else ""
    print(
        f"✅ 已写入 v{out['version']} 索引："
        f"{len(all_chunks)} 块{chapter_info} × {dim} 维 = {size_mb:.1f} MB"
    )
    return True


def get_token() -> str:
    """优先环境变量；否则从 profiles.json 找 siliconflow token。"""
    token = os.environ.get("SF_TOKEN", "")
    if token:
        return token
    profiles = json.loads(
        (CC_ROOT / "app" / "ai" / "profiles.json").read_text(encoding="utf-8")
    )
    for p in profiles.get("profiles", []):
        if "siliconflow.cn" in (p.get("baseUrl") or ""):
            t = p.get("apiToken") or ""
            if t:
                print(f"自动从 profile 「{p['name']}」拿到 token")
                return t
    raise SystemExit("无 token，无法继续")


def build_all(token: str, model: str, force_rebuild: bool = False):
    """扫所有学科所有资料，逐个 build。"""
    idx_path = CC_ROOT / "library" / "materials" / "index.json"
    if not idx_path.exists():
        print(f"❌ {idx_path} 不存在")
        return
    idx = json.loads(idx_path.read_text(encoding="utf-8"))
    materials = idx.get("materials", [])
    if not materials:
        print("无资料")
        return
    print(f"\n{'='*70}")
    print(f"全量重建：{len(materials)} 份资料 跨 {len(set(m['subject'] for m in materials))} 学科")
    print(f"{'='*70}\n")

    succ, fail = 0, 0
    t0 = time.time()
    for i, m in enumerate(materials, 1):
        print(f"\n[{i}/{len(materials)}] {m['subject']}")
        try:
            ok = build_index(m["subject"], m["id"], token, model, force_rebuild=force_rebuild)
            if ok:
                succ += 1
            else:
                fail += 1
        except Exception as e:
            print(f"  ❌ 异常：{e}")
            fail += 1
    elapsed = time.time() - t0
    print(f"\n{'='*70}")
    print(f"全部完成：成功 {succ} / 失败 {fail} / 耗时 {elapsed:.1f}s")
    print(f"{'='*70}\n")


def main():
    args = sys.argv[1:]

    # --all 一键全部模式
    if "--all" in args:
        force = "--force" in args
        token = get_token()
        build_all(token, DEFAULT_MODEL, force_rebuild=force)
        return

    if len(args) < 2:
        print("usage:")
        print("  python build_vector_index.py <subject> <materialId> [token] [model]")
        print("  python build_vector_index.py --all [--force]   # 一键全部学科 + 升级到 v2")
        sys.exit(1)

    subject = args[0]
    material_id = args[1]
    token = args[2] if len(args) > 2 else get_token()
    model = args[3] if len(args) > 3 else DEFAULT_MODEL
    build_index(subject, material_id, token, model)


if __name__ == "__main__":
    main()
