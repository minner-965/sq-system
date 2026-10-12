"""读取小红书创作服务平台的笔记列表：拿笔记链接和数据（浏览、点赞、评论数、收藏、转发）；读回单条笔记实际存下的文字。只读。

创作服务平台里没有评论和私信的内容，只有数量；评论和私信要在手机上看。
"""
from __future__ import annotations

import asyncio
from pathlib import Path

from patchright.async_api import async_playwright

HERE = Path(__file__).parent.resolve()
NOTE_PAGE = "https://creator.xiaohongshu.com/new/note-manager"
NOTE_LIST_API = "/api/galaxy/v2/creator/note/user/posted"
MAX_NOTE_PAGES = 4
NOTE_EDIT_PAGE = "https://creator.xiaohongshu.com/publish/update"
NOTE_DETAIL_API = "/web_api/sns/capa/postgw/note/detail"


def cookie_file(account_id) -> Path:
    return HERE / "state" / "cookies" / f"xiaohongshu_{account_id}.json"


async def read_xiaohongshu_notes(account_id) -> dict:
    """返回 {"logged_in": bool, "items": [{item_id, title, type, link, time, sticky, views, likes, comments, favorites, shares}]}，最近的在前。
    列表只有页面自己发的请求拿得到数据（请求带签名），所以靠往下滚让页面自己加载后面几页，最多 MAX_NOTE_PAGES 页。
    调用方只取自己通过系统发布的那几条，其余的不保存。"""
    result = {"logged_in": True, "items": []}
    pages: list[dict] = []
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True, channel="chromium", args=["--no-sandbox", "--disable-blink-features=AutomationControlled"])
        context = await browser.new_context(storage_state=str(cookie_file(account_id)), viewport={"width": 1440, "height": 900})
        page = await context.new_page()

        async def capture(response):
            if NOTE_LIST_API in response.url:
                try:
                    pages.append(await response.json())
                except Exception:
                    pass

        page.on("response", capture)
        try:
            await page.goto(NOTE_PAGE, wait_until="domcontentloaded", timeout=90000)
            for _ in range(40):
                if pages:
                    break
                await page.wait_for_timeout(1000)
            if not pages:
                # 没拿到笔记列表：多半是登录失效被带去了登录页。
                result["logged_in"] = False
                return result
            for _ in range(MAX_NOTE_PAGES - 1):
                loaded = len(pages)
                if ((pages[-1].get("data") or {}).get("page")) in (None, -1):
                    break
                await page.mouse.move(800, 600)
                for _ in range(8):
                    await page.mouse.wheel(0, 2500)
                    await page.wait_for_timeout(700)
                    if len(pages) > loaded:
                        break
                if len(pages) == loaded:
                    break
            seen = set()
            for data in pages:
                for note in (data.get("data") or {}).get("notes") or []:
                    note_id = str(note.get("id") or "")
                    if not note_id or note_id in seen:
                        continue
                    seen.add(note_id)
                    result["items"].append({
                        "item_id": note_id,
                        "title": note.get("display_title") or "",
                        "type": str(note.get("type") or "normal"),
                        "link": f"https://www.xiaohongshu.com/explore/{note_id}",
                        "views": int(note.get("view_count") or 0),
                        "likes": int(note.get("likes") or 0),
                        "comments": int(note.get("comments_count") or 0),
                        "favorites": int(note.get("collected_count") or 0),
                        "shares": int(note.get("shared_count") or 0),
                        # 发布时间（“2026-10-11 22:12”）和是否置顶：用来判断“我们发的那条本该排在读到的范围里”。
                        "time": str(note.get("time") or ""),
                        "sticky": str(note.get("sticky")) == "True",
                    })
            await context.storage_state(path=str(cookie_file(account_id)))
            return result
        finally:
            await context.close()
            await browser.close()


async def read_xiaohongshu_note_text(account_id, note_id: str, note_type: str = "normal") -> dict | None:
    """读一条我们自己发的笔记在平台上实际存下的标题、正文、话题，用来和确认稿核对。
    列表里没有正文；打开这条笔记的编辑页，页面会自己取一次笔记详情，从那里读。只看不改，不点保存。读不到返回 None。"""
    detail: asyncio.Future = asyncio.get_event_loop().create_future()
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True, channel="chromium", args=["--no-sandbox", "--disable-blink-features=AutomationControlled"])
        context = await browser.new_context(storage_state=str(cookie_file(account_id)), viewport={"width": 1440, "height": 900})
        page = await context.new_page()

        async def capture(response):
            if NOTE_DETAIL_API in response.url and not detail.done():
                try:
                    detail.set_result(await response.json())
                except Exception:
                    pass

        page.on("response", capture)
        try:
            await page.goto(f"{NOTE_EDIT_PAGE}?id={note_id}&noteType={note_type}", wait_until="domcontentloaded", timeout=90000)
            try:
                data = (await asyncio.wait_for(detail, timeout=40)).get("data") or {}
            except Exception:
                return None
            if not data.get("id"):
                return None
            return {"title": str(data.get("title") or ""), "text": str(data.get("desc") or ""),
                    "topics": [str(tag.get("name") or "") for tag in data.get("hash_tag") or []]}
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
