"""诊断用：打开抖音图文发布页、选好图片，列出页面上的输入框，保存一张截图。不点“发布”，不会发出任何内容。

平台改版导致“页面元素未找到”时用它看现在的页面长什么样：
  publisher\\.venv\\Scripts\\python.exe publisher\\tools\\inspect_douyin_note_form.py <账号编号> <图片路径>
截图和结果写到 publisher/state/diagnostics/。
"""
import asyncio
import json
import sys
from pathlib import Path

from patchright.async_api import async_playwright

HERE = Path(__file__).resolve().parent.parent
OUT = HERE / "state" / "diagnostics"


async def main(account_id: str, image: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    cookie = HERE / "state" / "cookies" / f"douyin_{account_id}.json"
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True, channel="chromium", args=["--no-sandbox", "--disable-blink-features=AutomationControlled"])
        context = await browser.new_context(storage_state=str(cookie), viewport={"width": 1440, "height": 900})
        page = await context.new_page()
        try:
            await page.goto("https://creator.douyin.com/creator-micro/content/upload", wait_until="domcontentloaded", timeout=90000)
            await page.wait_for_timeout(5000)
            await page.get_by_text("发布图文", exact=True).click()
            await page.wait_for_timeout(1500)
            await page.locator("div[class^='container'] input[accept*='image']").set_input_files([image])
            await page.wait_for_url("**/creator-micro/content/post/image?**", timeout=60000)
            await page.wait_for_timeout(15000)
            fields = await page.evaluate(
                """() => ({
                    url: location.href,
                    inputs: [...document.querySelectorAll('input, textarea')].filter(e => e.offsetParent !== null)
                        .map(e => ({ tag: e.tagName, type: e.type, placeholder: e.placeholder, cls: e.className.slice(0, 80), maxlength: e.maxLength })),
                    editables: [...document.querySelectorAll('[contenteditable="true"]')].filter(e => e.offsetParent !== null)
                        .map(e => ({ cls: e.className.slice(0, 100), placeholder: e.getAttribute('data-placeholder') || e.getAttribute('placeholder'), text: e.innerText.slice(0, 40) })),
                    buttons: [...document.querySelectorAll('button')].filter(e => e.offsetParent !== null).map(e => e.innerText.trim()).filter(Boolean).slice(0, 30),
                    headings: [...document.querySelectorAll('[class*="title"], h1, h2, h3')].filter(e => e.offsetParent !== null).map(e => e.innerText.trim().slice(0, 30)).filter(Boolean).slice(0, 40),
                })""")
            (OUT / "douyin_note_form.json").write_text(json.dumps(fields, ensure_ascii=False, indent=2), encoding="utf-8")
            await page.screenshot(path=str(OUT / "douyin_note_form.png"), full_page=True)
            print(json.dumps(fields, ensure_ascii=False, indent=2))
        finally:
            await context.close()
            await browser.close()


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1], sys.argv[2]))
