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


def build_index(subject: str, material_id: str, token: str, model: str):
    material = find_material(subject, material_id)
    print(f"=== 处理 {material['fileName']} ===")
    text_path = Path(material["textPath"])
    print(f"读取 extracted.txt: {text_path.stat().st_size // 1024} KB")
    text = text_path.read_text(encoding="utf-8", errors="replace")
    chunks = chunk_text(text)
    print(f"切分 {len(chunks)} 块（heading-aware）")

    if not chunks:
        print("(空文本，跳过)")
        return

    # 简单粗略预估
    total_chars = sum(len(c) for c in chunks)
    est_tokens = total_chars // 2  # 粗略，bge-m3 中英混合
    print(f"总字符 {total_chars}，预估 token {est_tokens}（免费）")

    out_chunks = []
    t_start = time.time()
    for i in range(0, len(chunks), BATCH_SIZE):
        batch = chunks[i : i + BATCH_SIZE]
        try:
            vecs = embed_batch(batch, token, model)
        except Exception as e:
            print(f"\nbatch {i // BATCH_SIZE} 失败：{e}")
            print("中断，已完成的不会保存（避免半成品）")
            return
        for j, (txt, vec) in enumerate(zip(batch, vecs)):
            out_chunks.append(
                {
                    "chunkIndex": i + j,
                    "textHash": text_hash(txt),
                    "text": txt,
                    "vector": vec,
                }
            )
        print(
            f"  [{i + len(batch)}/{len(chunks)}] "
            f"耗时 {time.time() - t_start:.1f}s",
            end="\r",
        )

    print()
    if not out_chunks:
        print("无 chunk 产出")
        return

    dim = len(out_chunks[0]["vector"])
    out = {
        "version": 1,
        "materialId": material_id,
        "model": model,
        "dimension": dim,
        "chunks": out_chunks,
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
    }

    out_path = Path(material["storageDir"]) / "vector-index.json"
    out_path.write_text(
        json.dumps(out, ensure_ascii=False), encoding="utf-8"
    )
    size_mb = out_path.stat().st_size / 1024 / 1024
    print(
        f"✅ 已写入 {out_path}\n"
        f"   {len(out_chunks)} 块 × {dim} 维 = {size_mb:.1f} MB"
    )


def main():
    args = sys.argv[1:]
    if len(args) < 2:
        print("usage: build_vector_index.py <subject> <materialId> [token] [model]")
        sys.exit(1)
    subject = args[0]
    material_id = args[1]
    token = args[2] if len(args) > 2 else os.environ.get("SF_TOKEN", "")
    model = args[3] if len(args) > 3 else DEFAULT_MODEL
    if not token:
        # 从用户的 profiles.json 找 siliconflow token
        profiles = json.loads(
            (CC_ROOT / "app" / "ai" / "profiles.json").read_text(encoding="utf-8")
        )
        for p in profiles.get("profiles", []):
            if "siliconflow.cn" in (p.get("baseUrl") or ""):
                token = p.get("apiToken") or ""
                if token:
                    print(f"自动从 profile 「{p['name']}」拿到 token")
                    break
    if not token:
        raise SystemExit("无 token")
    build_index(subject, material_id, token, model)


if __name__ == "__main__":
    main()
