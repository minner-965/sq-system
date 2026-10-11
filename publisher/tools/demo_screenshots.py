"""给每个页面截两张图（电脑 1440、手机 390），并检查有没有横向滚动和页面报错。验收和演示前用。

用只读的老板账号登录，所以截图里不会出现只有管理员能看的内容（比如底价）。
密码从本机的 data/accounts.local.txt 读，不显示。

  publisher\\.venv\\Scripts\\python.exe publisher\\tools\\demo_screenshots.py [地址，默认 http://localhost:3000] [账号，默认 boss]
"""
import asyncio
import re
import sys
from pathlib import Path

from patchright.async_api import async_playwright

ROOT = Path(__file__).resolve().parent.parent.parent
OUT = ROOT / "docs" / "hz" / "screenshots" / "wp07"
PAGES = [
    ("总览", "/"), ("企业发现", "/discovery.html"), ("招商客户", "/customers.html"), ("内容发布", "/publishing.html"),
    ("互动收件箱", "/inbox.html"), ("发布账号", "/accounts.html"), ("系统设置", "/settings.html"),
]
SIZES = {"1440": (1440, 900), "390": (390, 844)}


def password_of(username: str) -> str:
    lines = (ROOT / "data" / "accounts.local.txt").read_text(encoding="utf-8").splitlines()
    for line in reversed(lines):
        match = re.search(rf"账号 {re.escape(username)}\s+密码 (\S+)", line)
        if match:
            return match.group(1)
    raise SystemExit(f"data/accounts.local.txt 里没有账号 {username}")


async def main(base: str, username: str) -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    problems = []
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True, channel="chromium")
        for label, (width, height) in SIZES.items():
            context = await browser.new_context(viewport={"width": width, "height": height}, locale="zh-CN", timezone_id="Asia/Shanghai")
            page = await context.new_page()
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
            await page.goto(base + "/login.html", wait_until="networkidle")
            if label == "1440":
                await page.screenshot(path=str(OUT / "登录_1440.png"))
            await page.fill("#username", username)
            await page.fill("#password", password_of(username))
            await page.click("button[type=submit]")
            await page.wait_for_url(lambda url: "login" not in url, timeout=15000)
            pages = list(PAGES)
            # 再加一个企业详情页：从招商客户里取第一家。
            await page.goto(base + "/customers.html", wait_until="networkidle")
            first = await page.locator('a[href*="company.html"]').first.get_attribute("href") if await page.locator('a[href*="company.html"]').count() else None
            if first:
                pages.append(("企业详情", first))
            for name, path in pages:
                errors.clear()
                await page.goto(base + path, wait_until="networkidle")
                await page.wait_for_timeout(800)
                overflow = await page.evaluate("document.documentElement.scrollWidth - window.innerWidth")
                await page.screenshot(path=str(OUT / f"{name}_{label}.png"), full_page=True)
                if overflow > 0:
                    problems.append(f"{name} {label}：横向多出 {overflow}px")
                if errors:
                    problems.append(f"{name} {label}：页面报错 {errors[0][:120]}")
                print(f"{name} {label} ok" if overflow <= 0 and not errors else f"{name} {label} 有问题")
            await context.close()
        await browser.close()
    for problem in problems:
        print("问题：", problem)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3000", sys.argv[2] if len(sys.argv) > 2 else "boss")))
