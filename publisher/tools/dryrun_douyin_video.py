r"""演练用：按发布程序的步骤把抖音视频的文件、标题、正文、话题都填好，读回表单里实际留下的内容，截图，然后离开。不点“发布”，不会发出任何内容。

改了发布组件或平台改版之后，先用它确认表单还能填对：
  publisher\.venv\Scripts\python.exe publisher\tools\dryrun_douyin_video.py <账号编号> <视频路径> <标题> <正文> <话题,话题>
截图写到 publisher/state/diagnostics/douyin_video_filled.png。
"""
import asyncio
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE / "vendor" / "social-auto-upload"))

from patchright.async_api import async_playwright  # noqa: E402
from uploader.douyin_uploader.main import DouYinVideo  # noqa: E402

OUT = HERE / "state" / "diagnostics"
READ = """() => ({
    title: document.querySelector('input[placeholder*="作品标题"]')?.value,
    body: document.querySelector('div.zone-container[contenteditable="true"]')?.innerText,
    editors: document.querySelectorAll('div.zone-container[contenteditable="true"]').length,
    uploaded: [...document.querySelectorAll('[class^="long-card"] div')].some(e => e.innerText.includes('重新上传')),
})"""


async def main(account_id: str, video: str, title: str, desc: str, tags: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    cookie = HERE / "state" / "cookies" / f"douyin_{account_id}.json"
    uploader = DouYinVideo(title=title, file_path=video, tags=[tag for tag in tags.split(",") if tag], publish_date=0, account_file=str(cookie), desc=desc)
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True, channel="chromium", args=["--no-sandbox", "--disable-blink-features=AutomationControlled"])
        context = await browser.new_context(storage_state=str(cookie), viewport={"width": 1440, "height": 900})
        page = await context.new_page()
        try:
            await page.goto("https://creator.douyin.com/creator-micro/content/upload", wait_until="domcontentloaded", timeout=90000)
            await page.wait_for_timeout(2000)
            await page.locator("input.upload-btn-input, div[class^='container'] input[accept]").first.set_input_files(video)
            await page.wait_for_url("**/creator-micro/content/post/video?**", timeout=90000)
            await asyncio.sleep(1)
            await uploader.fill_title_and_description(page, title, desc, uploader.tags)
            print("刚填完：", await page.evaluate(READ))
            for _ in range(60):
                if (await page.evaluate(READ))["uploaded"]:
                    break
                await page.wait_for_timeout(2000)
            print("视频传完：", await page.evaluate(READ))
            # 发布程序在点“发布”之前还要走的几步，一步一步看正文还在不在。
            for name in ("apply_self_declaration", "apply_collection", "set_thumbnail"):
                await getattr(uploader, name)(page)
                print(f"{name} 之后：", await page.evaluate(READ))
            # 和发布程序点“发布”前清浮层用的是同一句。
            await uploader._clear_blocking_overlays(page)
            await page.evaluate('''() => { document.querySelectorAll('.shepherd-element, .shepherd-modal-overlay-container, [class*="mention-wrapper"]').forEach(e => { if (!e.querySelector('[contenteditable], input, textarea')) e.remove(); }); }''')
            print("清掉浮层之后：", await page.evaluate(READ))
            await page.screenshot(path=str(OUT / "douyin_video_filled.png"), full_page=True)
        finally:
            await context.close()
            await browser.close()


if __name__ == "__main__":
    asyncio.run(main(*sys.argv[1:6]))
