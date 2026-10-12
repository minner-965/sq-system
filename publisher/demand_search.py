"""主动发现需求：用搜索专用小号在小红书、抖音上按关键词搜公开帖子和帖子下的评论。只读。

搜索交给开源项目 MediaCrawler（publisher/vendor/mediacrawler，非商业学习许可，只用在这一处）。这里只做三件事：
把它的设置改成我们要的（独立的浏览器、按时间排序）、起一个子进程去搜、把它写出来的结果文件读成统一的格式。
它存下来的发帖人只有匿名编号和打了码的昵称，没有个人资料；我们也只存这些。

  publisher\\.venv\\Scripts\\python.exe publisher\\demand_search.py parse <结果目录> <xiaohongshu|douyin>    只读一个结果目录，打印条数
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).parent.resolve()
VENDOR = HERE / "vendor" / "mediacrawler"
PYTHON = HERE / ".venv-mc" / "Scripts" / "python.exe"
RESULT_DIR = HERE / "state" / "demand"
# 我们的平台名 -> MediaCrawler 的平台名
MC_PLATFORM = {"xiaohongshu": "xhs", "douyin": "dy"}
SEARCH_TIMEOUT_SECONDS = 40 * 60
LOGIN_TIMEOUT_SECONDS = 6 * 60
COMMENTS_PER_POST = 10

# (文件, 原文, 改成, 原因)。每次搜索前都核对一遍，上游改了写法就报错不搜。
CONFIG_PATCHES = [
    ("config/base_config.py", "ENABLE_CDP_MODE = True", "ENABLE_CDP_MODE = False",
     "原设置会接管电脑上已经开着的 Chrome（里面是 Simon 自己的登录）。改成用它自己单独的浏览器和单独的登录目录。"),
    ("config/base_config.py", "CDP_CONNECT_EXISTING = True", "CDP_CONNECT_EXISTING = False", "同上：不连接已经打开的浏览器。"),
    ("config/xhs_config.py", 'SORT_TYPE = "popularity_descending"', 'SORT_TYPE = "time_descending"', "要最近发的帖子，不要最热的。"),
]


class SearchError(Exception):
    pass


def ready() -> tuple[bool, str]:
    if not (VENDOR / "main.py").exists():
        return False, "搜索组件还没有装（publisher/vendor/mediacrawler）"
    if not PYTHON.exists():
        return False, "搜索组件的运行环境还没有装（publisher/.venv-mc）"
    return True, ""


def ensure_config() -> None:
    """把 MediaCrawler 的设置改成我们要的。已经改过的不动；找不到原文也找不到改后的写法时报错。"""
    for relative, before, after, reason in CONFIG_PATCHES:
        path = VENDOR / relative
        text = path.read_text(encoding="utf-8")
        if after in text:
            continue
        if before not in text:
            raise SearchError(f"搜索组件的设置变了，没法确认安全：{relative}（{reason}）")
        path.write_text(text.replace(before, after), encoding="utf-8", newline="\n")
    base = (VENDOR / "config" / "base_config.py").read_text(encoding="utf-8")
    if "ENABLE_CDP_MODE = False" not in base or "CDP_CONNECT_EXISTING = False" not in base:
        raise SearchError("搜索组件仍然设置成接管已有浏览器，不搜")


def _run(platform: str, keywords: list[str], posts_per_keyword: int, out_dir: Path, headless: bool, timeout: int) -> tuple[int, str]:
    ensure_config()
    out_dir.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    proxy = env.get("HZ_DIRECT_PROXY")
    if proxy:
        # 浏览器和它直接发的请求都从本机宽带出去，不要一个走国内一个走国外。
        env["PYTHONPATH"] = str(HERE / "hz_netpatch") + os.pathsep + env.get("PYTHONPATH", "")
        for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
            env[name] = proxy
    args = [str(PYTHON), "main.py", "--platform", MC_PLATFORM[platform], "--lt", "qrcode", "--type", "search",
            "--keywords", ",".join(keyword.replace(",", " ") for keyword in keywords),
            "--crawler_max_notes_count", str(posts_per_keyword), "--get_comment", "yes", "--get_sub_comment", "no",
            "--max_comments_count_singlenotes", str(COMMENTS_PER_POST), "--get_media", "no", "--max_concurrency_num", "1",
            "--save_data_option", "jsonl", "--save_data_path", str(out_dir), "--headless", "yes" if headless else "no"]
    done = subprocess.run(args, cwd=str(VENDOR), env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    return done.returncode, (done.stdout or "")[-4000:] + (done.stderr or "")[-4000:]


def _read_jsonl(folder: Path, item_type: str) -> list[dict]:
    rows: list[dict] = []
    for path in sorted(folder.glob(f"search_{item_type}_*.jsonl")):
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def _when(value) -> datetime | None:
    """结果里的时间有的是毫秒、有的是秒。"""
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    if number <= 0:
        return None
    if number > 10_000_000_000:
        number //= 1000
    return datetime.fromtimestamp(number, tz=timezone.utc)


def parse_output(platform: str, out_dir: Path, max_age_days: int = 30, now: datetime | None = None) -> list[dict]:
    """把 MediaCrawler 写出来的帖子和评论读成统一格式。超过 max_age_days 的帖子不要；评论跟着帖子走。"""
    folder = out_dir / MC_PLATFORM[platform] / "jsonl"
    if not folder.exists():
        return []
    oldest = (now or datetime.now(timezone.utc)) - timedelta(days=max_age_days)
    id_key, url_key, time_key = ("note_id", "note_url", "time") if platform == "xiaohongshu" else ("aweme_id", "aweme_url", "create_time")
    rows: list[dict] = []
    kept: dict[str, dict] = {}
    for item in _read_jsonl(folder, "contents"):
        item_id = str(item.get(id_key) or "").strip()
        posted = _when(item.get(time_key))
        text = str(item.get("desc") or "").strip()
        title = str(item.get("title") or "").strip()
        if not item_id or item_id in kept or not (text or title) or (posted and posted < oldest):
            continue
        # 抖音的标题就是正文，不重复存。
        if title == text or platform == "douyin":
            title = ""
        row = {
            "kind": "post", "platform_item_id": item_id, "parent_item_id": None, "parent_title": None,
            "author_key": str(item.get("creator_hash") or "") or None, "author_name": str(item.get("nickname") or "")[:60] or None,
            "title": title[:200] or None, "content": (text or title)[:2000], "post_url": str(item.get(url_key) or "") or None,
            "posted_at": posted, "keyword": str(item.get("source_keyword") or "")[:60] or None,
        }
        kept[item_id] = row
        rows.append(row)
    seen: set[str] = set()
    for item in _read_jsonl(folder, "comments"):
        comment_id = str(item.get("comment_id") or "").strip()
        parent = kept.get(str(item.get(id_key) or ""))
        text = str(item.get("content") or "").strip()
        # 太短的评论（“同问”“求”之类）单看看不出需求，不收。
        if not comment_id or comment_id in seen or parent is None or len(text) < 6:
            continue
        seen.add(comment_id)
        rows.append({
            "kind": "comment", "platform_item_id": comment_id, "parent_item_id": parent["platform_item_id"],
            "parent_title": (parent["title"] or parent["content"])[:120],
            "author_key": str(item.get("creator_hash") or "") or None, "author_name": str(item.get("nickname") or "")[:60] or None,
            "title": None, "content": text[:2000], "post_url": parent["post_url"],
            "posted_at": _when(item.get("create_time")), "keyword": parent["keyword"],
        })
    return rows


def search(platform: str, keywords: list[str], posts_per_keyword: int = 20, max_age_days: int = 30, headless: bool = True) -> dict:
    """搜一轮。返回 {"ok": bool, "note": str, "rows": [...]}。结果目录每轮一个，读完留着备查。"""
    ok, why = ready()
    if not ok:
        return {"ok": False, "note": why, "rows": []}
    out_dir = RESULT_DIR / f"{platform}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    try:
        code, output = _run(platform, keywords, posts_per_keyword, out_dir, headless, SEARCH_TIMEOUT_SECONDS if headless else LOGIN_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        return {"ok": False, "note": "搜索超时没有完成", "rows": parse_output(platform, out_dir, max_age_days)}
    except SearchError as error:
        return {"ok": False, "note": str(error), "rows": []}
    rows = parse_output(platform, out_dir, max_age_days)
    if code != 0 and not rows:
        tail = " / ".join(line.strip() for line in output.splitlines()[-3:] if line.strip())[-300:]
        return {"ok": False, "note": f"搜索没有成功，可能是登录过期或被要求验证：{tail}", "rows": []}
    posts = sum(1 for row in rows if row["kind"] == "post")
    return {"ok": True, "note": f"搜了 {len(keywords)} 个词，最近 {max_age_days} 天的帖子 {posts} 条、评论 {len(rows) - posts} 条", "rows": rows}


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "parse":
        found = parse_output(sys.argv[3], Path(sys.argv[2]), max_age_days=36500)
        print("posts", sum(1 for row in found if row["kind"] == "post"), "comments", sum(1 for row in found if row["kind"] == "comment"))
    else:
        print(__doc__)
