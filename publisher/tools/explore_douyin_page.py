"""只读探查：打开创作者中心的某个页面，记录它调用了哪些数据接口、返回什么结构，并截图。
写读取程序或平台改版后重新对接口时用。不点任何会改动内容的按钮。

  publisher\\.venv\\Scripts\\python.exe publisher\\tools\\explore_douyin_page.py <账号编号> <页面地址> <结果文件名前缀>
"""
import asyncio
import json
import sys
from pathlib import Path

from patchright.async_api import async_playwright

HERE = Path(__file__).resolve().parent.parent
OUT = HERE / "state" / "diagnostics"


def shape(value, depth=0):
    """只留结构和很短的示例，不把内容整段存下来。"""
    if depth > 4:
        return "…"
    if isinstance(value, dict):
        return {key: shape(item, depth + 1) for key, item in list(value.items())[:40]}
    if isinstance(value, list):
        return [shape(value[0], depth + 1), f"×{len(value)}"] if value else []
    if isinstance(value, str):
        return value[:24]
    return value


async def main(account_id: str, url: str, prefix: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    cookie = HERE / "state" / "cookies" / f"douyin_{account_id}.json"
    calls = []
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True, channel="chromium", args=["--no-sandbox", "--disable-blink-features=AutomationControlled"])
        context = await browser.new_context(storage_state=str(cookie), viewport={"width": 1440, "height": 900})
        page = await context.new_page()

        async def capture(response):
            if response.request.resource_type not in ("xhr", "fetch"):
                return
            try:
                body = await response.json()
            except Exception:
                return
            calls.append({"url": response.url.split("?")[0], "query": response.url.split("?")[1][:300] if "?" in response.url else "", "method": response.request.method, "shape": shape(body)})

        page.on("response", capture)
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=90000)
            await page.wait_for_timeout(12000)
            text = await page.evaluate("() => document.body.innerText.replace(/\\s+/g, ' ').slice(0, 1500)")
            await page.screenshot(path=str(OUT / f"{prefix}.png"), full_page=True)
            (OUT / f"{prefix}.json").write_text(json.dumps({"final_url": page.url, "calls": calls, "text": text}, ensure_ascii=False, indent=1), encoding="utf-8")
            print("final url:", page.url)
            for call in calls:
                print(call["method"], call["url"])
            print("text:", text[:600])
        finally:
            await context.close()
            await browser.close()


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1], sys.argv[2], sys.argv[3]))
