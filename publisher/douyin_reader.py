"""读取抖音创作者中心：作品列表（拿帖子链接和数据）、我们发布的作品下的评论。只读，不点任何会改动内容的按钮。

平台的数据接口带签名参数，没法直接请求；这里打开创作者中心的页面，用页面自己的请求通道去取，
页面改版时用 tools/explore_douyin_page.py 重新对一遍接口。
"""
from __future__ import annotations

import asyncio
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from patchright.async_api import async_playwright

HERE = Path(__file__).parent.resolve()
COMMENT_PAGE = "https://creator.douyin.com/creator-micro/interactive/comment"
ITEM_LIST_API = "/aweme/v1/creator/item/list/"
COMMENT_LIST_API = "/aweme/v1/creator/comment/list/"
MAX_COMMENT_PAGES = 10
MESSAGE_PAGE = "https://creator.douyin.com/creator-micro/data/following/chat"
MAX_MESSAGE_ROWS = 30
# 会话列表里的时间：刚刚、3分钟前、昨天 12:30、星期二、10-09、2026-10-09、12:30。
TIME_LIKE = re.compile(r"^(刚刚|\d+\s*(秒|分钟|小时|天)前|(昨天|前天|星期.|周.)(\s*\d{1,2}:\d{2})?|(\d{4}[-/.])?\d{1,2}[-/.]\d{1,2}(\s+\d{1,2}:\d{2})?|\d{1,2}:\d{2}|(\d{4}年)?\d{1,2}月\d{1,2}日)$")


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


async def read_stranger_messages(account_id) -> dict:
    """读私信管理页的“陌生人私信”一栏，返回 {"logged_in": bool, "rows": [{"sender_name", "text"}]}。
    只点这一个栏目，不点开任何会话（点开会把消息标成已读），所以拿到的是每个人最近的一句话。
    朋友私信和群消息两栏不碰。私信走的是加密通道，没有可读的数据接口，只能读页面上显示的内容。"""
    result = {"logged_in": True, "rows": []}
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True, channel="chromium", args=["--no-sandbox", "--disable-blink-features=AutomationControlled"])
        context = await browser.new_context(storage_state=str(cookie_file(account_id)), viewport={"width": 1440, "height": 900})
        page = await context.new_page()
        try:
            await page.goto(MESSAGE_PAGE, wait_until="domcontentloaded", timeout=90000)
            tab = page.get_by_role("tab", name="陌生人私信")
            try:
                await tab.wait_for(state="visible", timeout=40000)
            except Exception:
                result["logged_in"] = False
                return result
            # 页面刚出来时点栏目有时不生效，多点几次，直到选中的确实是这一栏。
            for _ in range(5):
                await page.wait_for_timeout(3000)
                if (await page.locator(".semi-tabs-tab-active").first.inner_text()).strip() == "陌生人私信":
                    break
                await tab.click()
            pane = page.locator(".semi-tabs-pane-active").first
            empty = pane.get_by_text("还没有收到私信")
            rows = pane.locator(".ReactVirtualized__Grid__innerScrollContainer > *")
            # 刚点完栏目时，页面上还留着上一栏（全部私信，里面有朋友的聊天）的列表，绝不能在这时候读。
            # 先等够切换的时间，再要求：当前选中的确实是“陌生人私信”，并且隔几秒读两次结果一致，才算数。
            await page.wait_for_timeout(10000)
            previous = None
            for _ in range(10):
                active = (await page.locator(".semi-tabs-tab-active").first.inner_text()).strip()
                if active != "陌生人私信":
                    result.setdefault("errors", []).append("没能切到陌生人私信一栏，这次不读")
                    return result
                current = (await empty.count(), await rows.count(), await pane.inner_text())
                if previous == current and (current[0] or current[1]):
                    break
                previous = current
                await page.wait_for_timeout(4000)
            else:
                result.setdefault("errors", []).append("私信页一直在加载，这次没读到")
                return result
            if await empty.count():
                return result
            for index in range(min(await rows.count(), MAX_MESSAGE_ROWS)):
                lines = [line.strip() for line in (await rows.nth(index).inner_text()).splitlines() if line.strip()]
                # 一行会话 = 昵称、时间、最近一句话、未读数。去掉时间和纯数字，第一项是昵称，其余是内容。
                lines = [line for line in lines if not TIME_LIKE.match(line) and not line.isdigit()]
                if len(lines) >= 2:
                    result["rows"].append({"sender_name": lines[0][:60], "text": " ".join(lines[1:])[:2000]})
            return result
        finally:
            await context.close()
            await browser.close()


class ReplyError(RuntimeError):
    """回复没有发出去；信息是给招商员看的。"""


async def send_comment_reply(account_id, post_title: str, sender_name: str, comment_text: str, reply_text: str, rehearse: bool = False) -> None:
    """在评论管理页找到指定帖子下的那条评论，点“回复”，填入内容并发送。
    rehearse=True 时只填不发，填完点“取消”，用来确认页面还能对上。找不到帖子或评论时抛 ReplyError。"""
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True, channel="chromium", args=["--no-sandbox", "--disable-blink-features=AutomationControlled"])
        context = await browser.new_context(storage_state=str(cookie_file(account_id)), viewport={"width": 1440, "height": 900})
        page = await context.new_page()
        try:
            await page.goto(COMMENT_PAGE, wait_until="domcontentloaded", timeout=90000)
            picker = page.get_by_role("button", name=re.compile(r"选择作品")).first
            try:
                await picker.wait_for(state="visible", timeout=40000)
            except Exception:
                raise ReplyError("打不开评论管理页，可能需要重新扫码登录")
            # 页面默认显示最新的一条作品。已经是要找的帖子就不用再选；不是才打开“选择作品”去挑。
            await page.wait_for_timeout(4000)
            shown = page.get_by_text(post_title[:12]).first
            if not (await shown.count() and await shown.is_visible()):
                await picker.click()
                sheet = page.locator("[class*='sidesheet-body'], [class*='sidesheet-content']").first
                row = sheet.get_by_text(post_title[:12]).first
                try:
                    await row.wait_for(state="visible", timeout=20000)
                except Exception:
                    raise ReplyError("在作品列表里没有找到这条帖子，可能已被删除")
                await row.click()
                await page.wait_for_timeout(4000)

            # 包含这条评论原文和“回复”按钮的最里层那一块，就是这条评论。
            needle = comment_text.split("[")[0].strip()[:20] or comment_text[:20]
            # 同一句话可能有几个人说过：逐个看，找昵称也对得上的那条。
            matches = page.get_by_text(needle)
            try:
                await matches.first.wait_for(state="visible", timeout=20000)
            except Exception:
                raise ReplyError("在帖子下没有找到这条评论，可能已被对方删除")
            block = None
            for index in range(await matches.count()):
                candidate = matches.nth(index).locator("xpath=ancestor::div[.//*[normalize-space(text())='回复']][1]")
                if await candidate.count() and sender_name in (await candidate.inner_text()):
                    block = candidate
                    break
            if block is None:
                raise ReplyError("在帖子下没有找到这条评论，可能已被对方删除")
            await block.get_by_text("回复", exact=True).first.click()
            box = page.locator('div[contenteditable="true"]').last
            await box.wait_for(state="visible", timeout=10000)
            hint = await box.get_attribute("placeholder") or await box.get_attribute("data-placeholder") or ""
            if "回复" not in hint:
                raise ReplyError("回复框没有打开")
            await box.click()
            await page.keyboard.type(reply_text, delay=30)
            await page.wait_for_timeout(800)
            if reply_text[:10] not in (await box.inner_text()):
                raise ReplyError("回复框里没有填进内容")
            # 两个字的按钮，页面会在字中间插一个空格（“发 送”）。
            send = page.get_by_role("button", name=re.compile(r"^发\s*送$")).last
            if not await send.count() or await send.is_disabled():
                raise ReplyError("发送按钮点不了，可能内容不符合平台要求")
            if rehearse:
                return
            await send.click()
            # 评论区里（输入框以外）出现了这条回复，才算发出。回复框收起后，页面顶部还有一个常驻的评论框，不能拿输入框是否消失来判断。
            posted = False
            for _ in range(15):
                await page.wait_for_timeout(2000)
                shown = page.get_by_text(reply_text[:15])
                for index in range(await shown.count()):
                    if await shown.nth(index).evaluate("element => !element.closest('[contenteditable]')"):
                        posted = True
                        break
                if posted:
                    break
            if not posted:
                raise ReplyError("点了发送，但没有在评论区看到这条回复，请到手机上确认")
            await context.storage_state(path=str(cookie_file(account_id)))
        except Exception:
            # 留一张出错时的截图，方便看页面当时是什么样。
            try:
                (HERE / "state" / "diagnostics").mkdir(parents=True, exist_ok=True)
                await page.screenshot(path=str(HERE / "state" / "diagnostics" / "reply_failure.png"), full_page=True)
            except Exception:
                pass
            raise
        finally:
            await context.close()
            await browser.close()


if __name__ == "__main__" and len(sys_argv := __import__("sys").argv) > 2 and sys_argv[1] == "rehearse-reply":
    # 演练回复：python douyin_reader.py rehearse-reply <账号编号> <帖子标题开头> <对方昵称> <评论原文开头> —— 只填不发。
    asyncio.run(send_comment_reply(sys_argv[2], sys_argv[3], sys_argv[4], sys_argv[5], "（演练，不会发出）您好，具体情况我私信您", rehearse=True))
    print("演练通过：找到了帖子和评论，回复框能填，没有发送。")
elif __name__ == "__main__":
    # 手工试读：python douyin_reader.py <账号编号> [作品编号,作品编号]  —— 只打印条数和结构，不写数据库。
    import sys
    wanted = set(sys.argv[2].split(",")) if len(sys.argv) > 2 else set()
    data = asyncio.run(read_douyin(sys.argv[1], wanted))
    print(json.dumps({
        "logged_in": data["logged_in"], "errors": data.get("errors"),
        "items": [{**item, "token": "…", "title": item["title"][:16]} for item in data["items"]],
        "comments": {key: [{"sender": c["sender_name"], "text": c["text"][:20], "sent_at": c["sent_at"]} for c in value] for key, value in data["comments"].items()},
    }, ensure_ascii=False, indent=1))
