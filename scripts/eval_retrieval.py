#!/usr/bin/env python3
"""
检索质量对比：keyword-only vs vector-only vs hybrid (RRF)。

复刻 src/materials/materialManager.ts 的 IDF 评分 +
src/materials/hybridRetriever.ts 的 RRF 融合，然后对一组真实 query 评测。

usage:
  python eval_retrieval.py
"""
import os, json, math, re, hashlib, time, urllib.request, sys, io
from pathlib import Path

if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace", line_buffering=True)
if hasattr(sys.stderr, "buffer"):
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace", line_buffering=True)

CC_ROOT = Path(os.environ.get("USERPROFILE") or os.path.expanduser("~")) / "ClaudeCoach"
API = "https://api.siliconflow.cn/v1"

# 复用 build_vector_index.py 的 chunk 函数
sys.path.insert(0, str(Path(__file__).parent))
from build_vector_index import chunk_text, embed_batch  # noqa


# ----------------- IDF 关键词评分（复刻 _scoreChunkWithIDF）-----------------

def extract_terms(query: str) -> list:
    """复刻 src/materials/materialManager.ts:_extractSearchTerms。
    英文：>=2 字符的 latin 词；中文：2-4 字 n-gram。"""
    s = query.lower()
    terms = set()
    for w in re.findall(r"[a-z0-9][a-z0-9-]{1,}", s):
        terms.add(w)
    for phrase in re.findall(r"[一-鿿]{2,}", s):
        terms.add(phrase)
        max_gram = min(4, len(phrase))
        for size in range(2, max_gram + 1):
            for i in range(0, len(phrase) - size + 1):
                terms.add(phrase[i:i + size])
    out = [t for t in terms if len(t) > 1]
    out.sort(key=len, reverse=True)
    return out[:24]


def compute_idf(chunks: list, terms: list) -> dict:
    """简化 IDF：term 出现 chunks 数 / 总 chunks 数 → log."""
    n = max(1, len(chunks))
    df = {t: 0 for t in terms}
    for c in chunks:
        low = c.lower()
        for t in terms:
            if t in low:
                df[t] += 1
                break  # 简化：一 chunk 多 term 命中只算一次
    # IDF
    idf = {}
    for t, count in df.items():
        if count == 0:
            idf[t] = 1.0
        else:
            idf[t] = math.log(n / max(1, count)) + 1
    return idf


def score_chunk_idf(text: str, query: str, terms: list, idf: dict, chunk_index: int = 0) -> float:
    """复刻 _scoreChunkWithIDF 简化版：每命中一 term 加 idf[term]，
    全 query 短语命中 +5，多 term 共现 +2。
    P0-2: chunk_index < 5 (前言/封面区) 打 0.4 折，去除中英对照表的高分噪声。"""
    low = text.lower()
    score = 0.0
    hits = 0
    for t in terms:
        if t in low:
            score += idf[t]
            hits += 1
    if query.lower() in low:
        score += 5
    if hits >= 2:
        score += 2 * (hits - 1)
    if chunk_index < 5:
        score *= 0.4
    return score


# ----------------- 向量检索（cosine）-----------------

def cosine(a, b):
    s, na, nb = 0.0, 0.0, 0.0
    for x, y in zip(a, b):
        s += x * y; na += x * x; nb += y * y
    if na == 0 or nb == 0: return 0.0
    return s / (math.sqrt(na) * math.sqrt(nb))


def vector_topk(query_vec, vec_chunks: list, k: int) -> list:
    scored = [(i, c["chunkIndex"], c["text"], cosine(query_vec, c["vector"]))
              for i, c in enumerate(vec_chunks)]
    scored.sort(key=lambda x: x[3], reverse=True)
    return scored[:k]


# ----------------- RRF 融合（复刻 hybridRetriever.fuse）-----------------

RRF_K = 60

def rrf_fuse(kw_top, vec_top, hybrid_weight: float, max_k: int) -> list:
    """kw_top, vec_top: list of (chunkIndex, text, score) 按各自分降序。
    P0-1: 公式从 `kw + α*vec` 改为 `(1-α)*kw + α*vec`，让 slider 真正反映用户意图。"""
    kw_rank = {ci: (i + 1, txt, sc) for i, (ci, txt, sc) in enumerate(kw_top)}
    vec_rank = {ci: (i + 1, txt, sc) for i, (ci, txt, sc) in enumerate(vec_top)}
    all_keys = set(kw_rank.keys()) | set(vec_rank.keys())
    fused = []
    for key in all_keys:
        kw = kw_rank.get(key)
        vec = vec_rank.get(key)
        kw_term = 1 / (RRF_K + kw[0]) if kw else 0
        vec_term = 1 / (RRF_K + vec[0]) if vec else 0
        final = (1 - hybrid_weight) * kw_term + hybrid_weight * vec_term
        retrieved_by = "both" if (kw and vec) else ("keyword" if kw else "vector")
        text = (kw or vec)[1]
        fused.append({
            "chunkIndex": key,
            "text": text,
            "finalScore": final,
            "retrievedBy": retrieved_by,
            "keywordScore": kw[2] if kw else None,
            "vectorScore": vec[2] if vec else None,
        })
    fused.sort(key=lambda x: x["finalScore"], reverse=True)
    return fused[:max_k]


# ----------------- 一次完整 query 评测 -----------------

def get_token():
    p = json.loads((CC_ROOT / "app" / "ai" / "profiles.json").read_text(encoding="utf-8"))
    for prof in p.get("profiles", []):
        if "siliconflow.cn" in (prof.get("baseUrl") or ""):
            return prof.get("apiToken", "")
    return ""


def evaluate_one(material_path: Path, vec_path: Path, query: str, top_k: int, token: str):
    """三通道并行检索 + 输出比对."""
    text = material_path.read_text(encoding="utf-8", errors="replace")
    chunks = chunk_text(text)
    vec_data = json.loads(vec_path.read_text(encoding="utf-8"))
    vec_chunks = vec_data["chunks"]

    # 关键词通道
    terms = extract_terms(query)
    idf = compute_idf(chunks, terms)
    scored = [(i, chunks[i], score_chunk_idf(chunks[i], query, terms, idf, chunk_index=i))
              for i in range(len(chunks))]
    scored.sort(key=lambda x: x[2], reverse=True)
    kw_top = [(ci, txt, sc) for ci, txt, sc in scored if sc > 0][:top_k * 2]

    # 向量通道
    query_vecs = embed_batch([query], token, "BAAI/bge-m3")
    qvec = query_vecs[0]
    vec_results = vector_topk(qvec, vec_chunks, top_k * 2)
    vec_top = [(ci, txt, sc) for _, ci, txt, sc in vec_results]

    # Hybrid (RRF)
    fused = rrf_fuse(kw_top, vec_top, hybrid_weight=0.5, max_k=top_k)

    return {
        "query": query,
        "terms": terms,
        "kw_only_top": kw_top[:top_k],
        "vec_only_top": vec_top[:top_k],
        "hybrid_top": fused,
    }


def shorten(text: str, n=110) -> str:
    s = re.sub(r"\s+", " ", text).strip()
    return (s[:n] + "...") if len(s) > n else s


def render_query_result(result, top_k=5):
    print(f"\n{'=' * 78}")
    print(f"Query: {result['query']}")
    print(f"Terms: {result['terms']}")
    print(f"{'=' * 78}")

    print(f"\n[关键词通道]")
    for i, (ci, txt, sc) in enumerate(result["kw_only_top"][:top_k]):
        print(f"  #{i+1} chunk={ci:4d} score={sc:.2f}  {shorten(txt)}")

    print(f"\n[向量通道]")
    for i, (ci, txt, sc) in enumerate(result["vec_only_top"][:top_k]):
        print(f"  #{i+1} chunk={ci:4d} cos={sc:.4f}  {shorten(txt)}")

    print(f"\n[Hybrid (RRF, α=0.5)]")
    for i, item in enumerate(result["hybrid_top"][:top_k]):
        ci = item["chunkIndex"]
        flag = item["retrievedBy"]
        kw_s = item.get("keywordScore")
        vec_s = item.get("vectorScore")
        meta = []
        if kw_s is not None:
            meta.append(f"kw={kw_s:.2f}")
        if vec_s is not None:
            meta.append(f"cos={vec_s:.4f}")
        print(f"  #{i+1} chunk={ci:4d} [{flag}] {' '.join(meta)}  {shorten(item['text'])}")


# ----------------- 主流程 -----------------

QUERIES = [
    # subject, material_basename, query, label
    ("linear-algebra", "线性代数应该这样学",
     "向量空间的基与维数",
     "中文教材 + 中文 query — 应找到第 2 章 dimension 章节"),

    ("linear-algebra", "线性代数应该这样学",
     "linear independence",
     "英文 query 找中文教材（跨语言能力）"),

    ("linear-algebra", "线性代数应该这样学",
     "为什么矩阵的行秩等于列秩",
     "概念性 + 跨章节，要求多 chunk 召回"),

    ("discrete-math", "Discrete Mathematics",
     "induction proof example",
     "英文教材 + 英文 query — 经典命题"),

    ("discrete-math", "Discrete Mathematics",
     "数学归纳法的反例",
     "中文 query 找英文教材（跨语言）"),

    ("数据结构基础", "Data structures and algorithm",
     "binary search tree balance",
     "英文 query 英文教材"),

    ("数据结构基础", "Data structures and algorithm",
     "动态规划与最优子结构",
     "中文 query — 教材里也讲 DP，但语言完全不同"),
]


def find_material_paths(subject: str, basename_keyword: str):
    idx = json.loads((CC_ROOT / "library" / "materials" / "index.json").read_text(encoding="utf-8"))
    for m in idx.get("materials", []):
        if m["subject"] == subject and basename_keyword in m["fileName"]:
            return Path(m["textPath"]), Path(m["storageDir"]) / "vector-index.json"
    return None, None


def main():
    token = get_token()
    if not token:
        print("无 token")
        return
    for subject, basename, query, label in QUERIES:
        text_path, vec_path = find_material_paths(subject, basename)
        if not text_path or not vec_path.exists():
            print(f"  跳过 {subject}/{basename}（无索引）")
            continue
        print(f"\n\n{'#' * 78}")
        print(f"# 学科：{subject}  教材：{basename}")
        print(f"# 测试目的：{label}")
        print(f"{'#' * 78}")
        result = evaluate_one(text_path, vec_path, query, top_k=4, token=token)
        render_query_result(result, top_k=4)


if __name__ == "__main__":
    main()
