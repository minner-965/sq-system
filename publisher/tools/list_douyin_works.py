"""只读：打开抖音创作者中心的“内容管理”，列出最近的作品（标题、状态、时间、链接），并保存截图。

  publisher\\.venv\\Scripts\\python.exe publisher\\tools\\list_douyin_works.py <账号编号>
"""
import asyncio
import json
import sys
from pathlib import Path

from patchright.async_api import async_playwright

HERE = Path(__file__).resolve().parent.parent
OUT = HERE / "state" / "diagnostics"


async def main(account_id: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    cookie = HERE / "state" / "cookies" / f"douyin_{account_id}.json"
    responses = []
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True, channel="chromium", args=["--no-sandbox", "--disable-blink-features=AutomationControlled"])
        context = await browser.new_context(storage_state=str(cookie), viewport={"width": 1440, "height": 900})
        page = await context.new_page()

        async def capture(response):
            # 作品列表接口返回的 JSON 里有作品编号和分享链接，比读页面文字可靠。
            if "/work_list" in response.url or "/item/list" in response.url or "aweme/post" in response.url:
                try:
                    responses.append({"url": response.url.split("?")[0], "body": await response.json()})
                except Exception:
                    pass

        page.on("response", capture)
        try:
            await page.goto("https://creator.douyin.com/creator-micro/content/manage", wait_until="domcontentloaded", timeout=90000)
            await page.wait_for_timeout(12000)
            cards = await page.evaluate(
                """() => [...document.querySelectorAll('[class*="video-card"], [class*="content-card"], [class*="card-container"]')]
                    .filter(e => e.offsetParent !== null).slice(0, 10)
                    .map(e => e.innerText.trim().replace(/\\s+/g, ' ').slice(0, 200))""")
            text = await page.evaluate("() => document.querySelector('main, #root')?.innerText.replace(/\\s+/g, ' ').slice(0, 1200)")
            await page.screenshot(path=str(OUT / "douyin_works.png"), full_page=True)
            (OUT / "douyin_works_api.json").write_text(json.dumps(responses, ensure_ascii=False, indent=1)[:200000], encoding="utf-8")
            print(json.dumps({"cards": cards, "api_calls": [item["url"] for item in responses], "page_text": text}, ensure_ascii=False, indent=1))
        finally:
            await context.close()
            await browser.close()


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1]))
