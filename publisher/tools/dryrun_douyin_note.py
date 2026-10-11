"""演练用：按发布程序的步骤把抖音图文的图片、标题、正文、话题都填好，截图，然后离开。不点“发布”，不会发出任何内容。

改了发布组件或平台改版之后，先用它确认表单还能填对：
  publisher\\.venv\\Scripts\\python.exe publisher\\tools\\dryrun_douyin_note.py <账号编号> <图片路径> <标题> <正文> <话题,话题>
截图写到 publisher/state/diagnostics/douyin_note_filled.png。
"""
import asyncio
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE / "vendor" / "social-auto-upload"))

from patchright.async_api import async_playwright  # noqa: E402
from uploader.douyin_uploader.main import DouYinNote  # noqa: E402

OUT = HERE / "state" / "diagnostics"


async def main(account_id: str, image: str, title: str, note: str, tags: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    cookie = HERE / "state" / "cookies" / f"douyin_{account_id}.json"
    uploader = DouYinNote(image_paths=[image], note=note, tags=[tag for tag in tags.split(",") if tag], publish_date=0, account_file=str(cookie), title=title)
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
            await uploader.fill_title_and_description(page, title, note, uploader.tags)
            await page.wait_for_timeout(45000)
            filled = await page.evaluate(
                """() => ({
                    title: document.querySelector('input[placeholder*="作品标题"]')?.value,
                    body: document.querySelector('div.zone-container[contenteditable="true"]')?.innerText,
                    publishButtons: [...document.querySelectorAll('button')].filter(e => e.innerText.trim() === '发布')
                        .map(e => ({ disabled: e.disabled, cls: e.className.slice(0, 120), ariaDisabled: e.getAttribute('aria-disabled') })),
                    assistant: [...document.querySelectorAll('[class*="assistant"], [class*="detect"], [class*="check"]')].filter(e => e.offsetParent !== null)
                        .map(e => e.innerText.trim().replace(/\\s+/g, ' ').slice(0, 200)).filter(Boolean).slice(0, 6),
                    dialogs: [...document.querySelectorAll('[role="dialog"], .semi-modal, .semi-toast, [class*="modal"], [class*="toast"]')].filter(e => e.offsetParent !== null)
                        .map(e => e.innerText.trim().replace(/\\s+/g, ' ').slice(0, 300)).filter(Boolean).slice(0, 6),
                    cover: document.body.innerText.match(/封面设置[\\s\\S]{0,60}/)?.[0].replace(/\\s+/g, ' '),
                    declaration: document.body.innerText.match(/自主声明[\\s\\S]{0,40}/)?.[0].replace(/\\s+/g, ' '),
                })""")
            await page.screenshot(path=str(OUT / "douyin_note_filled.png"), full_page=True)
            print(filled)
        finally:
            await context.close()
            await browser.close()


if __name__ == "__main__":
    asyncio.run(main(*sys.argv[1:6]))
