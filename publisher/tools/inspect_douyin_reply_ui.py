"""只读探查：评论管理页上“选择作品”和“回复”这两处的页面结构。会点开回复框，但不输入、不发送。

  publisher\\.venv\\Scripts\\python.exe publisher\\tools\\inspect_douyin_reply_ui.py <账号编号>
"""
import asyncio
import json
import sys
from pathlib import Path

from patchright.async_api import async_playwright

HERE = Path(__file__).resolve().parent.parent
OUT = HERE / "state" / "diagnostics"

DESCRIBE = """(root) => {
  const describe = (e) => ({ tag: e.tagName, cls: (e.className || '').toString().slice(0, 90), text: (e.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 60),
    placeholder: e.getAttribute('placeholder') || e.getAttribute('data-placeholder'), editable: e.getAttribute('contenteditable') });
  const visible = (e) => e.offsetParent !== null;
  return {
    selectWork: [...document.querySelectorAll('*')].filter(e => visible(e) && e.children.length < 4 && /^选择作品$/.test((e.innerText || '').trim())).slice(0, 3).map(describe),
    replyButtons: [...document.querySelectorAll('*')].filter(e => visible(e) && e.children.length === 0 && (e.innerText || '').trim() === '回复').slice(0, 3).map(e => ({ ...describe(e), parent: describe(e.parentElement), grand: describe(e.parentElement.parentElement) })),
    inputs: [...document.querySelectorAll('input, textarea, [contenteditable="true"]')].filter(visible).map(describe),
    sendButtons: [...document.querySelectorAll('button, [role="button"], div, span')].filter(e => visible(e) && e.children.length === 0 && (e.innerText || '').trim() === '发送').slice(0, 4).map(e => ({ ...describe(e), parent: describe(e.parentElement) })),
    commentBlocks: [...document.querySelectorAll('[class*="comment"]')].filter(e => visible(e) && /回复/.test(e.innerText || '') && (e.innerText || '').length < 200).slice(0, 3).map(describe),
  };
}"""


async def main(account_id: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    cookie = HERE / "state" / "cookies" / f"douyin_{account_id}.json"
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True, channel="chromium", args=["--no-sandbox", "--disable-blink-features=AutomationControlled"])
        context = await browser.new_context(storage_state=str(cookie), viewport={"width": 1440, "height": 900})
        page = await context.new_page()
        try:
            await page.goto("https://creator.douyin.com/creator-micro/interactive/comment", wait_until="domcontentloaded", timeout=90000)
            await page.wait_for_timeout(10000)
            before = await page.evaluate(DESCRIBE)
            await page.screenshot(path=str(OUT / "reply_ui_before.png"))
            # 点开“选择作品”，看作品列表长什么样，然后按 Esc 关掉。
            picker = page.get_by_text("选择作品", exact=True).first
            works = []
            if await picker.count():
                await picker.click()
                await page.wait_for_timeout(2500)
                works = await page.evaluate("""() => [...document.querySelectorAll('[class*="drawer"], [class*="modal"], [class*="sidesheet"], [role="dialog"]')]
                    .filter(e => e.offsetParent !== null).map(e => ({ cls: e.className.toString().slice(0, 80), text: e.innerText.trim().replace(/\\s+/g, ' ').slice(0, 500),
                      rows: [...e.querySelectorAll('[class*="item"], [class*="card"], li')].filter(r => r.offsetParent !== null).slice(0, 4).map(r => ({ cls: r.className.toString().slice(0, 80), text: r.innerText.trim().replace(/\\s+/g, ' ').slice(0, 80) })) }))""")
                await page.screenshot(path=str(OUT / "reply_ui_picker.png"))
                # 选一条有评论的作品（命令行第二个参数是标题里的几个字），好看到“回复”按钮。
                if len(sys.argv) > 2:
                    row = page.locator(".douyin-creator-interactive-sidesheet-body [class*='container']", has_text=sys.argv[2]).first
                    if not await row.count():
                        row = page.locator(".douyin-creator-interactive-sidesheet-body").get_by_text(sys.argv[2]).first
                    await row.click()
                    await page.wait_for_timeout(4000)
                else:
                    await page.keyboard.press("Escape")
                    await page.wait_for_timeout(1000)
            # 点开第一条评论的“回复”，只看输入框和发送按钮，不输入、不发送。
            reply = page.get_by_text("回复", exact=True).first
            after = None
            if await reply.count():
                await reply.click()
                await page.wait_for_timeout(2000)
                after = await page.evaluate(DESCRIBE)
                await page.screenshot(path=str(OUT / "reply_ui_open.png"))
            result = {"before": before, "works_picker": works, "after_reply_click": after}
            (OUT / "reply_ui.json").write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
            print(json.dumps(result, ensure_ascii=False, indent=1)[:6000])
        finally:
            await context.close()
            await browser.close()


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1]))
