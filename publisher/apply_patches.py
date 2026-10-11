"""给固定版本的 social-auto-upload 打我们自己的小补丁。setup.ps1 每次都会调用，可重复运行。

只在上游还没修、而平台页面已经变了的地方打补丁；每一条都写明原因和发现日期。
上游修复后把 setup.ps1 里的版本号往前提，再删掉对应的补丁。
"""
from pathlib import Path

VENDOR = Path(__file__).parent / "vendor" / "social-auto-upload"

# (文件, 原文, 改成, 原因)
PATCHES = [
    (
        "uploader/douyin_uploader/main.py",
        """page.locator('input[placeholder*="填写作品标题"]').first""",
        """page.locator('input[placeholder*="作品标题"]').first""",
        "2026-10-11：抖音图文发布页的标题框提示是“添加作品标题”，视频页是“填写作品标题”；原写法只认后者，发图文时等 120 秒后超时。",
    ),
    (
        "uploader/douyin_uploader/main.py",
        """class DouYinBaseUploader(BaseVideoUploader):""",
        '''async def _hz_request_sms_code(page) -> bool:
    """恒兆补丁：替人点“获取验证码”。点完按钮上的字会变成倒计时，以此判断点没点上；三种点法轮着试。"""
    get_code = page.get_by_text("获取验证码", exact=True).first

    async def still_there() -> bool:
        try:
            return bool(await get_code.count()) and await get_code.is_visible()
        except Exception:
            return False

    if not await still_there():
        return True
    for attempt in ("mouse", "click", "script"):
        try:
            if attempt == "mouse":
                await _native_click(page, get_code)
            elif attempt == "click":
                await get_code.click(timeout=3000, force=True)
            else:
                await get_code.evaluate("element => element.click()")
        except Exception:
            pass
        await asyncio.sleep(1.5)
        if not await still_there():
            douyin_logger.info(_msg("📤", f"已自动点了“获取验证码”（{attempt}）"))
            return True
    douyin_logger.warning(_msg("⚠️", "没能自动点上“获取验证码”，请在窗口里手动点一下"))
    return False


async def _hz_wait_for_sms(page) -> None:
    """恒兆补丁：抖音有时在点发布后要求短信验证本人。验证码只能由人在弹出的浏览器窗口里输入：
    一看到验证框就替人点“获取验证码”，留一个标记让发布程序去提醒，然后最多等 10 分钟。没有验证框时立刻返回。"""
    sms_input = page.locator('input[placeholder*="验证码"]').first
    try:
        sms_visible = bool(await sms_input.count()) and await sms_input.is_visible()
    except Exception:
        sms_visible = False
    if not sms_visible:
        return
    if not getattr(page, "_hz_sms_seen", False):
        page._hz_sms_seen = True
        requested = await _hz_request_sms_code(page)
        flag = os.environ.get("HZ_SMS_FLAG")
        if flag:
            Path(flag).write_text("requested" if requested else "manual", encoding="utf-8")
        douyin_logger.warning(_msg("📱", "抖音要求短信验证，请在弹出的浏览器窗口里输入验证码并点“验证”"))
    for _ in range(300):
        await asyncio.sleep(2)
        if "content/manage" in page.url:
            return
        try:
            if not (await sms_input.count() and await sms_input.is_visible()):
                return
        except Exception:
            return
    raise RuntimeError("抖音要求短信验证，10 分钟内没有在弹出的浏览器窗口里输入验证码")


async def _hz_publish_stuck(page, limit: int = 20):
    """恒兆补丁：点了“发布”页面却不跳转时，别无限重试。到次数后截图、记下页面上的提示，然后报错退出。"""
    if getattr(page, "_hz_sms_seen", False) and "content/manage" in page.url:
        return
    await _hz_wait_for_sms(page)
    count = getattr(page, "_hz_publish_attempts", 0) + 1
    page._hz_publish_attempts = count
    if count < limit:
        return
    hint = ""
    try:
        hint = await page.evaluate(
            """() => [...document.querySelectorAll('[role="dialog"], .semi-modal, .semi-toast, [class*="modal"], [class*="toast"], [class*="verify"], [class*="captcha"]')]
                .filter(e => e.offsetParent !== null).map(e => e.innerText.trim().replace(/\\\\s+/g, ' ').slice(0, 200)).filter(Boolean).slice(0, 3).join(' | ')""")
    except Exception:
        pass
    shot = os.environ.get("HZ_FAILURE_SCREENSHOT") or str(Path(BASE_DIR) / "logs" / "hz_publish_failure.png")
    if shot:
        try:
            await page.screenshot(path=shot, full_page=True)
        except Exception:
            pass
    raise RuntimeError("点了发布但页面没有跳到发布成功" + (f"，页面提示：{hint}" if hint else "，页面上没有看到提示，请看失败截图"))


class DouYinBaseUploader(BaseVideoUploader):''',
        "2026-10-11：发布按钮点了没反应时原代码会无限重试，既不报错也不留截图。加上次数上限、失败截图和页面提示。",
    ),
    (
        "uploader/douyin_uploader/main.py",
        """                douyin_logger.info(_msg("🏃", "小人正在冲刺发布图文"))
                await asyncio.sleep(0.5)""",
        """                douyin_logger.info(_msg("🏃", "小人正在冲刺发布图文"))
                await _hz_publish_stuck(page)
                await asyncio.sleep(0.5)""",
        "2026-10-11：图文发布的重试循环接上面的次数上限。",
    ),
    (
        "uploader/douyin_uploader/main.py",
        """                publish_button = page.get_by_role("button", name="发布", exact=True)
                if await publish_button.count():
                    await publish_button.click()
                await page.wait_for_url(
                    "**/creator-micro/content/manage?enter_from=publish**",""",
        """                await _hz_wait_for_sms(page)
                if "content/manage" not in page.url:
                    publish_button = page.get_by_role("button", name="发布", exact=True)
                    if await publish_button.count():
                        await publish_button.click(timeout=5000)
                await page.wait_for_url(
                    "**/creator-micro/content/manage**",""",
        "2026-10-11：验证框一出现就处理（原来要等发布按钮点击超时 30 秒后才轮到，Simon 已经自己点了“获取验证码”）；"
        "验证通过后不再重复点发布；发布按钮被挡住时 5 秒就放弃这一次点击。",
    ),
]


def main() -> int:
    failed = 0
    for relative, before, after, reason in PATCHES:
        path = VENDOR / relative
        text = path.read_text(encoding="utf-8")
        if after in text:
            print(f"already applied: {relative}")
        elif before in text:
            path.write_text(text.replace(before, after), encoding="utf-8", newline="\n")
            print(f"applied: {relative}")
        else:
            print(f"CANNOT APPLY (upstream changed?): {relative} -- {reason}")
            failed += 1
    return failed


if __name__ == "__main__":
    raise SystemExit(main())
