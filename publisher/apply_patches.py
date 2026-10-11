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
    (
        "uploader/douyin_uploader/main.py",
        """        if not self.declaration:
            self.declaration = "内容由AI生成"
        await self.apply_self_declaration(page)""",
        """        # 恒兆补丁：没有明确指定就不加自主声明（原来会默认声明“内容由AI生成”，我们发的是实拍视频）。
        await self.apply_self_declaration(page)""",
        "2026-10-11：发视频时组件默认勾选自主声明“内容由AI生成”。我们的视频是实拍，这样标不符合事实；改为不指定就不声明。",
    ),
    (
        "uploader/douyin_uploader/main.py",
        '                # 检测并处理短信验证码弹窗\n                sms_input = page.locator(\'input[placeholder*="验证码"], input[type="tel"], input[placeholder*="短信"], input[placeholder*="手机号"]\').first\n                if await sms_input.count() and await sms_input.is_visible():\n                    douyin_logger.warning(_msg("📱", "检测到短信验证码弹窗"))\n                    # 点击「获取验证码」按钮（仅首次）\n                    get_code_btn = page.get_by_text("获取验证码").first\n                    if await get_code_btn.count() and await get_code_btn.is_visible():\n                        await get_code_btn.click()\n                        douyin_logger.info(_msg("📤", "已点击「获取验证码」，请查看手机短信"))\n                    code_file = os.path.join(BASE_DIR, "verify_code.txt")\n                    code = await _read_verify_code(code_file)\n                    if code:\n                        sms_prompt_logged = False\n                        await self._submit_sms_verify_code(page, sms_input, code, code_file)\n                    elif not sms_prompt_logged:\n                        douyin_logger.warning(_msg("⏳", f"等待验证码输入；可在交互终端直接输入，或写入文件: {code_file}"))\n                        sms_prompt_logged = True\n',
        '                # 恒兆补丁：验证码只在弹出的浏览器窗口里输入；这里自动点“获取验证码”、提醒人，然后等。\n                await _hz_wait_for_sms(page)\n',
        "2026-10-11：发视频遇到短信验证时，组件会停在黑色窗口里等人打字输入验证码，浏览器里输了也不认，15 分钟后超时失败。改成和图文一样：自动点获取验证码、页面提醒、等人在浏览器窗口里输入。",
    ),
    (
        "uploader/douyin_uploader/main.py",
        '                publish_button = page.get_by_role("button", name="发布", exact=True)\n                if await publish_button.count():\n                    await publish_button.click(force=True)\n                await page.wait_for_url(\n                    "https://creator.douyin.com/creator-micro/content/manage**",',
        '                if "content/manage" not in page.url:\n                    publish_button = page.get_by_role("button", name="发布", exact=True)\n                    if await publish_button.count():\n                        await publish_button.click(force=True)\n                await page.wait_for_url(\n                    "https://creator.douyin.com/creator-micro/content/manage**",',
        "2026-10-11：发视频时验证通过后页面已经跳走，不再重复点发布。",
    ),
    (
        "uploader/tencent_uploader/main.py",
        '        label_text = getattr(self, "content_label", None) or "含AI生成内容"\n',
        '        # 恒兆补丁：没有明确指定标注就不标（原来默认标“含AI生成内容”，我们发的是实拍视频）。\n        if not getattr(self, "content_label", None):\n            return\n        label_text = self.content_label\n',
        "2026-10-11：视频号发视频时组件默认把视频标注选成“含AI生成内容”。我们的视频是实拍，不符合事实；改为不指定就不标。",
    ),
    (
        "uploader/xiaohongshu_uploader/main.py",
        '        source = getattr(self, "repost_source", "") or ""\n        try:\n            # 1. 点「添加内容类型声明」',
        '        source = getattr(self, "repost_source", "") or ""\n        # 恒兆补丁：没有指定转载来源就不做“来源转载”声明（原来会声明成转载且来源留空，我们发的是自己的内容）。\n        if not source:\n            return\n        try:\n            # 1. 点「添加内容类型声明」',
        "2026-10-11：小红书发布时组件默认添加“来源转载”声明且来源为空。我们发的是自己的内容；改为没有来源就不声明。",
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
