r"""核对“需求发现”搜索这一头不用登录就能核对的部分：搜索组件的设置改对了没有；它写出来的结果文件我们读得对不对。

  publisher\.venv\Scripts\python.exe publisher\tools\check_demand_search.py

结果文件的样本是照搜索组件自己的存储代码（store/xhs、store/douyin）里的字段写的。真实搜索要等搜索专用小号登录。
"""
import json
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

import demand_search  # noqa: E402

now = datetime(2026, 10, 12, 8, 0, tzinfo=timezone.utc)
ms = lambda days: int((now - timedelta(days=days)).timestamp() * 1000)
sec = lambda days: int((now - timedelta(days=days)).timestamp())


def write(folder: Path, name: str, rows: list[dict]) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / name).write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n", encoding="utf-8")


ok, why = demand_search.ready()
print("搜索组件装好了：", ok, why)
assert ok, why
demand_search.ensure_config()
base = (demand_search.VENDOR / "config" / "base_config.py").read_text(encoding="utf-8")
assert "ENABLE_CDP_MODE = False" in base and "CDP_CONNECT_EXISTING = False" in base
assert 'SORT_TYPE = "time_descending"' in (demand_search.VENDOR / "config" / "xhs_config.py").read_text(encoding="utf-8")
print("设置：用它自己单独的浏览器，不接管电脑上已经开着的浏览器；小红书按时间排序 ✔")

with tempfile.TemporaryDirectory() as temp:
    out = Path(temp)
    write(out / "xhs" / "jsonl", "search_contents_2026-10-12.jsonl", [
        {"note_id": "n1", "type": "normal", "title": "科学城附近求租办公室", "desc": "想租 150 平办公室", "time": ms(3), "creator_hash": "h1", "nickname": "小*",
         "note_url": "https://www.xiaohongshu.com/explore/n1?xsec_token=t", "source_keyword": "黄埔 办公室 求租"},
        {"note_id": "n1", "title": "重复的一条", "desc": "重复", "time": ms(3), "creator_hash": "h1", "nickname": "小*", "note_url": "u", "source_keyword": "k"},
        {"note_id": "n2", "title": "太旧的帖子", "desc": "两个月前发的", "time": ms(60), "creator_hash": "h2", "nickname": "老*", "note_url": "u2", "source_keyword": "k"},
        {"note_id": "n3", "title": "", "desc": "", "time": ms(1), "creator_hash": "h3", "nickname": "空*", "note_url": "u3", "source_keyword": "k"},
    ])
    write(out / "xhs" / "jsonl", "search_comments_2026-10-12.jsonl", [
        {"comment_id": "c1", "note_id": "n1", "content": "同问，我们也在找长岭居附近的办公室", "create_time": ms(2), "creator_hash": "h9", "nickname": "路*"},
        {"comment_id": "c2", "note_id": "n1", "content": "同问", "create_time": ms(2), "creator_hash": "h8", "nickname": "短*"},
        {"comment_id": "c3", "note_id": "n2", "content": "旧帖子下面的评论不要了哦", "create_time": ms(2), "creator_hash": "h7", "nickname": "旧*"},
    ])
    rows = demand_search.parse_output("xiaohongshu", out, max_age_days=30, now=now)
    assert [(row["kind"], row["platform_item_id"]) for row in rows] == [("post", "n1"), ("comment", "c1")], rows
    post, comment = rows
    assert post["title"] == "科学城附近求租办公室" and post["author_key"] == "h1" and post["keyword"] == "黄埔 办公室 求租"
    assert post["posted_at"].date() == (now - timedelta(days=3)).date()
    assert comment["parent_item_id"] == "n1" and comment["parent_title"] == "科学城附近求租办公室" and comment["post_url"] == post["post_url"]
    print("小红书：帖子和评论读对了；重复的、超过 30 天的、空的、太短的评论、旧帖下的评论都没收 ✔")

    write(out / "dy" / "jsonl", "search_contents_2026-10-12.jsonl", [
        {"aweme_id": "v1", "title": "黄埔求推荐能住一个月的公寓", "desc": "黄埔求推荐能住一个月的公寓", "create_time": sec(5), "creator_hash": "d1", "nickname": "抖*",
         "aweme_url": "https://www.douyin.com/video/v1", "source_keyword": "黄埔 公寓 求租"},
    ])
    write(out / "dy" / "jsonl", "search_comments_2026-10-12.jsonl", [
        {"comment_id": "dc1", "aweme_id": "v1", "content": "我也想找，长岭居那边有吗", "create_time": sec(4), "creator_hash": "d2", "nickname": "评*"},
    ])
    rows = demand_search.parse_output("douyin", out, max_age_days=30, now=now)
    assert [(row["kind"], row["platform_item_id"], row["title"]) for row in rows] == [("post", "v1", None), ("comment", "dc1", None)], rows
    assert rows[0]["post_url"] == "https://www.douyin.com/video/v1" and rows[0]["posted_at"].date() == (now - timedelta(days=5)).date()
    print("抖音：帖子和评论读对了；时间按秒算；标题和正文一样时不重复存 ✔")
    assert demand_search.parse_output("xiaohongshu", out / "nothing") == []
print("都对。")
