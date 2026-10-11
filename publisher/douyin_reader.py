"""读取抖音创作者中心：作品列表（拿帖子链接和数据）、我们发布的作品下的评论。只读，不点任何会改动内容的按钮。

平台的数据接口带签名参数，没法直接请求；这里打开创作者中心的页面，用页面自己的请求通道去取，
页面改版时用 tools/explore_douyin_page.py 重新对一遍接口。
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path

from patchright.async_api import async_playwright

HERE = Path(__file__).parent.resolve()
COMMENT_PAGE = "https://creator.douyin.com/creator-micro/interactive/comment"
ITEM_LIST_API = "/aweme/v1/creator/item/list/"
COMMENT_LIST_API = "/aweme/v1/creator/comment/list/"
MAX_COMMENT_PAGES = 10


def cookie_file(account_id) -> Path:
    return HERE / "state" / "cookies" / f"douyin_{account_id}.json"


async def _page_get(page, path: str, params: dict) -> dict:
    """用页面自己的 fetch 请求同站接口（页面的安全脚本会自动补上签名）。"""
    return await page.evaluate(
        """async ([path, params]) => {
            const url = new URL(path, location.origin);
            for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
            const response = await fetch(url, { credentials: 'include', headers: { accept: 'application/json' } });
            const text = await response.text();
            try { return JSON.parse(text); } catch { return { status_code: -1, status_msg: text.slice(0, 200) }; }
        }""", [path, params])


async def read_douyin(account_id, wanted_item_ids: set[str]) -> dict:
    """返回 {"logged_in": bool, "items": [...], "comments": {作品编号: [...]}}。只取 wanted_item_ids 里的作品的评论。"""
    result = {"logged_in": True, "items": [], "comments": {}}
    first_list: asyncio.Future = asyncio.get_event_loop().create_future()
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True, channel="chromium", args=["--no-sandbox", "--disable-blink-features=AutomationControlled"])
        context = await browser.new_context(storage_state=str(cookie_file(account_id)), viewport={"width": 1440, "height": 900})
        page = await context.new_page()

        async def capture(response):
            if ITEM_LIST_API in response.url and not first_list.done():
                try:
                    first_list.set_result(await response.json())
                except Exception as error:  # 交给下面的超时处理
                    if not first_list.done():
                        first_list.set_exception(error)

        page.on("response", capture)
        try:
            await page.goto(COMMENT_PAGE, wait_until="domcontentloaded", timeout=90000)
            try:
                listing = await asyncio.wait_for(first_list, timeout=40)
            except Exception:
                # 没拿到作品列表：多半是登录失效被带去了登录页。
                result["logged_in"] = False
                return result
            items = list(listing.get("item_info_list") or [])
            cursor, has_more = listing.get("cursor"), listing.get("has_more")
            for _ in range(5):
                if not has_more:
                    break
                more = await _page_get(page, ITEM_LIST_API, {"cursor": str(cursor), "aid": "2906"})
                items.extend(more.get("item_info_list") or [])
                cursor, has_more = more.get("cursor"), more.get("has_more")
            result["items"] = [{
                "item_id": str(item.get("item_id_plain") or ""),
                "token": item.get("item_id"),
                "title": item.get("title") or "",
                "link": item.get("item_link") or "",
                "comment_count": int(item.get("comment_count") or 0),
                "created_text": item.get("create_time") or "",
            } for item in items if item.get("item_id_plain")]

            for item in result["items"]:
                if item["item_id"] not in wanted_item_ids or not item["comment_count"]:
                    continue
                comments, cursor = [], "0"
                for _ in range(MAX_COMMENT_PAGES):
                    data = await _page_get(page, COMMENT_LIST_API, {"cursor": str(cursor), "count": "20", "item_id": item["token"], "sort": "TIME", "aid": "2906"})
                    if data.get("status_code") != 0:
                        result.setdefault("errors", []).append(f"评论接口返回 {data.get('status_code')}：{data.get('status_msg')}")
                        break
                    for comment in data.get("comment_info_list") or []:
                        if comment.get("is_author"):
                            continue
                        user = comment.get("user_info") or {}
                        comments.append({
                            "comment_id": comment.get("comment_id"),
                            "text": comment.get("text") or "",
                            "sender_name": user.get("screen_name") or "抖音用户",
                            "sender_id": user.get("user_id"),
                            "sent_at": datetime.fromtimestamp(int(comment.get("create_time") or 0), tz=timezone.utc).isoformat(),
                        })
                    if not data.get("has_more"):
                        break
                    cursor = data.get("cursor")
                result["comments"][item["item_id"]] = comments
            # 顺手把登录状态续上。
            await context.storage_state(path=str(cookie_file(account_id)))
            return result
        finally:
            await context.close()
            await browser.close()


if __name__ == "__main__":
    # 手工试读：python douyin_reader.py <账号编号> [作品编号,作品编号]  —— 只打印条数和结构，不写数据库。
    import sys
    wanted = set(sys.argv[2].split(",")) if len(sys.argv) > 2 else set()
    data = asyncio.run(read_douyin(sys.argv[1], wanted))
    print(json.dumps({
        "logged_in": data["logged_in"], "errors": data.get("errors"),
        "items": [{**item, "token": "…", "title": item["title"][:16]} for item in data["items"]],
        "comments": {key: [{"sender": c["sender_name"], "text": c["text"][:20], "sent_at": c["sent_at"]} for c in value] for key, value in data["comments"].items()},
    }, ensure_ascii=False, indent=1))
