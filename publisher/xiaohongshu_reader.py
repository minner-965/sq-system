"""读取小红书创作服务平台的笔记列表：拿笔记链接和数据（浏览、点赞、评论数、收藏、转发）。只读。

创作服务平台里没有评论和私信的内容，只有数量；评论和私信要在手机上看。
"""
from __future__ import annotations

import asyncio
from pathlib import Path

from patchright.async_api import async_playwright

HERE = Path(__file__).parent.resolve()
NOTE_PAGE = "https://creator.xiaohongshu.com/new/note-manager"
NOTE_LIST_API = "/api/galaxy/v2/creator/note/user/posted"
MAX_NOTE_PAGES = 3


def cookie_file(account_id) -> Path:
    return HERE / "state" / "cookies" / f"xiaohongshu_{account_id}.json"


async def read_xiaohongshu_notes(account_id) -> dict:
    """返回 {"logged_in": bool, "items": [{item_id, title, link, views, likes, comments, favorites, shares}]}，最近的在前。
    调用方只取自己通过系统发布的那几条，其余的不保存。"""
    result = {"logged_in": True, "items": []}
    first_page: asyncio.Future = asyncio.get_event_loop().create_future()
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True, channel="chromium", args=["--no-sandbox", "--disable-blink-features=AutomationControlled"])
        context = await browser.new_context(storage_state=str(cookie_file(account_id)), viewport={"width": 1440, "height": 900})
        page = await context.new_page()

        async def capture(response):
            if NOTE_LIST_API in response.url and not first_page.done():
                try:
                    first_page.set_result(await response.json())
                except Exception as error:
                    if not first_page.done():
                        first_page.set_exception(error)

        page.on("response", capture)
        try:
            await page.goto(NOTE_PAGE, wait_until="domcontentloaded", timeout=90000)
            try:
                data = await asyncio.wait_for(first_page, timeout=40)
            except Exception:
                # 没拿到笔记列表：多半是登录失效被带去了登录页。
                result["logged_in"] = False
                return result
            for number in range(MAX_NOTE_PAGES):
                notes = (data.get("data") or {}).get("notes") or []
                for note in notes:
                    result["items"].append({
                        "item_id": str(note.get("id") or ""),
                        "title": note.get("display_title") or "",
                        "link": f"https://www.xiaohongshu.com/explore/{note.get('id')}",
                        "views": int(note.get("view_count") or 0),
                        "likes": int(note.get("likes") or 0),
                        "comments": int(note.get("comments_count") or 0),
                        "favorites": int(note.get("collected_count") or 0),
                        "shares": int(note.get("shared_count") or 0),
                        # 发布时间（“2026-10-11 22:12”）和是否置顶：用来判断“我们发的那条本该排在这一页里”。
                        "time": str(note.get("time") or ""),
                        "sticky": str(note.get("sticky")) == "True",
                    })
                next_page = (data.get("data") or {}).get("page")
                if not notes or next_page in (None, -1) or number == MAX_NOTE_PAGES - 1:
                    break
                data = await page.evaluate(
                    """async ([path, page]) => {
                        const url = new URL(path, location.origin);
                        url.searchParams.set('tab', '0'); url.searchParams.set('page', String(page));
                        const response = await fetch(url, { credentials: 'include', headers: { accept: 'application/json' } });
                        try { return await response.json(); } catch { return {}; }
                    }""", [NOTE_LIST_API, next_page])
            await context.storage_state(path=str(cookie_file(account_id)))
            return result
        finally:
            await context.close()
            await browser.close()


if __name__ == "__main__":
    # 手工试读：python xiaohongshu_reader.py <账号编号> —— 只打印条数和数字，不显示标题，不写数据库。
    import sys
    data = asyncio.run(read_xiaohongshu_notes(sys.argv[1]))
    print("logged_in", data["logged_in"], "notes", len(data["items"]))
    for item in data["items"][:3]:
        print({key: value for key, value in item.items() if key not in ("title", "link")})
