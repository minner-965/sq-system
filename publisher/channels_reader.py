"""读取视频号助手的作品列表：拿每条作品实际存下的文字和数据（浏览、点赞、评论数、收藏、转发）。只读。

视频号助手里看得到评论数，评论内容和私信这里不读；登录大约一天就过期，过期了要重新扫码。
"""
from __future__ import annotations

import asyncio
from pathlib import Path

from patchright.async_api import async_playwright

HERE = Path(__file__).parent.resolve()
POST_PAGE = "https://channels.weixin.qq.com/platform/post/list"
POST_LIST_API = "/mmfinderassistant-bin/post/post_list"


def cookie_file(account_id) -> Path:
    return HERE / "state" / "cookies" / f"tencent_{account_id}.json"


async def read_channels_posts(account_id) -> dict:
    """返回 {"logged_in": bool, "items": [{item_id, text, created, views, likes, comments, favorites, shares}]}，最近的在前。
    只取页面自己加载的第一页。调用方只取自己通过系统发布的那几条，其余的不保存。"""
    result = {"logged_in": True, "items": []}
    first_page: asyncio.Future = asyncio.get_event_loop().create_future()
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True, channel="chromium", args=["--no-sandbox", "--disable-blink-features=AutomationControlled"])
        context = await browser.new_context(storage_state=str(cookie_file(account_id)), viewport={"width": 1440, "height": 900})
        page = await context.new_page()

        async def capture(response):
            if POST_LIST_API in response.url and not first_page.done():
                try:
                    first_page.set_result(await response.json())
                except Exception as error:
                    if not first_page.done():
                        first_page.set_exception(error)

        page.on("response", capture)
        try:
            await page.goto(POST_PAGE, wait_until="domcontentloaded", timeout=90000)
            try:
                data = await asyncio.wait_for(first_page, timeout=40)
            except Exception:
                # 没拿到作品列表：多半是登录过期被带去了登录页。
                result["logged_in"] = False
                return result
            for post in (data.get("data") or {}).get("list") or []:
                if not post.get("objectId"):
                    continue
                result["items"].append({
                    "item_id": str(post["objectId"]),
                    # 平台把标题、话题、正文存在同一段文字里。
                    "text": str((post.get("desc") or {}).get("description") or ""),
                    "created": int(post.get("createTime") or 0),
                    "views": int(post.get("readCount") or 0),
                    "likes": int(post.get("likeCount") or 0),
                    "comments": int(post.get("commentCount") or 0),
                    "favorites": int(post.get("favCount") or 0),
                    "shares": int(post.get("forwardCount") or 0),
                })
            await context.storage_state(path=str(cookie_file(account_id)))
            return result
        finally:
            await context.close()
            await browser.close()


if __name__ == "__main__":
    # 手工试读：python channels_reader.py <账号编号> —— 只打印条数和数字，不显示文字，不写数据库。
    import sys
    data = asyncio.run(read_channels_posts(sys.argv[1]))
    print("logged_in", data["logged_in"], "posts", len(data["items"]))
    for item in data["items"][:3]:
        print({key: value for key, value in item.items() if key not in ("text", "item_id")})
