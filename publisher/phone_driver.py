"""专用安卓手机：发朋友圈、在抖音 App 里回私信。用开源的 uiautomator2 通过 USB 操作手机。

进度（2026-10-22）：手机还没到。点 App 的步骤已经按微信 8.x、抖音 30.x 的界面写好，并用假手机
（publisher/tools/check_phone_flow.py）验证过调用顺序和出错处理；界面上的名字（按钮文字、描述）
要等真机到了以后对一遍。没对过之前，两个开关在网页上是关着的，手机上什么都不会发。

  publisher\\.venv\\Scripts\\python.exe publisher\\phone_driver.py status          看手机状态
  publisher\\.venv\\Scripts\\python.exe publisher\\phone_driver.py check wechat    打开微信看一眼朋友圈页面（不发东西）
  publisher\\.venv\\Scripts\\python.exe publisher\\phone_driver.py check douyin    打开抖音看一眼消息页（不发东西）
  publisher\\.venv\\Scripts\\python.exe publisher\\phone_driver.py dump <名字>       把当前屏幕的界面结构和截图存到 publisher/state/diagnostics/

手机要求：打开“USB 调试”，连上这台电脑并在手机上点“允许调试”，亮屏解锁（最好把锁屏密码关掉），
登录好工作微信和发帖用的抖音号。

每一步都按“文字 → 描述 → 类名”几种找法依次去找，找不到就截图存到 publisher/state/diagnostics/，
报一句招商员看得懂的原因，不乱点。什么时候允许真的去发，由发布程序按网页上的开关决定，这里不管。
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).parent.resolve()
DIAGNOSTICS = HERE / "state" / "diagnostics"
WECHAT = "com.tencent.mm"
DOUYIN = "com.ss.android.ugc.aweme"
APP_LABEL = {"wechat": "微信", "douyin": "抖音"}
APP_PACKAGE = {"wechat": WECHAT, "douyin": DOUYIN}
# 推到手机相册里的图片放在这个文件夹，发完就删掉。
REMOTE_DIR = "/sdcard/DCIM/HZ"
MAX_IMAGES = 9
# 等界面出来的时间（秒）。手机慢、App 刚启动时会卡一下，宁可多等。
WAIT = 15
SHORT = 4

# 每一步的找法，按顺序试。微信、抖音改版时只改这里。
WECHAT_MAIN = [{"text": "发现"}, {"description": "发现"}]
WECHAT_LOGIN = [{"text": "登录"}, {"text": "注册"}, {"textContains": "切换帐号"}]
WECHAT_MOMENTS_ENTRY = [{"text": "朋友圈"}, {"description": "朋友圈"}]
WECHAT_CAMERA = [{"description": "拍照分享"}, {"descriptionContains": "拍照"}, {"descriptionContains": "发表"}]
WECHAT_FROM_ALBUM = [{"text": "从相册选择"}, {"textContains": "相册"}]
WECHAT_GOT_IT = [{"text": "我知道了"}, {"text": "知道了"}]
WECHAT_ALBUM_CHECK = [{"className": "android.widget.CheckBox"}, {"descriptionContains": "未选中"}]
WECHAT_ALBUM_DONE = [{"textMatches": r"^完成.*"}, {"textStartsWith": "完成"}]
WECHAT_EDITOR = [{"className": "android.widget.EditText"}]
WECHAT_PUBLISH = [{"text": "发表"}, {"description": "发表"}]

DOUYIN_MESSAGE_TAB = [{"text": "消息"}, {"description": "消息"}, {"descriptionContains": "消息"}]
DOUYIN_LOGIN = [{"textContains": "登录后"}, {"textContains": "一键登录"}, {"textContains": "手机号登录"}, {"text": "登录"}]
DOUYIN_MESSAGE_PAGE = [{"text": "互动消息"}, {"text": "新朋友"}, {"textContains": "陌生人"}, {"text": "消息助手"}, {"descriptionContains": "互动消息"}]
DOUYIN_STRANGER_FOLDER = [{"textContains": "陌生人消息"}, {"textContains": "陌生人"}, {"textContains": "消息请求"}]
DOUYIN_INPUT = [{"className": "android.widget.EditText"}, {"textContains": "发送消息"}]
DOUYIN_SEND = [{"text": "发送"}, {"description": "发送"}, {"descriptionContains": "发送"}]
DOUYIN_SEND_FAILED = [{"textContains": "发送失败"}, {"descriptionContains": "发送失败"}, {"descriptionContains": "重新发送"}, {"textContains": "对方已开启"}]
# 核对“发出去了”时只看显示出来的文字，不看输入框（输入框里还留着说明没发出去）。
NOT_INPUT = r"^(?!android\.widget\.EditText$).*"
# 抖音、微信偶尔弹出的升级、通知权限、青少年模式提示，点掉再继续。
POPUP_CLOSE = [{"text": "以后再说"}, {"text": "暂不"}, {"text": "我知道了"}, {"text": "取消"}, {"text": "关闭"}, {"textContains": "暂不开启"}]


class PhoneNotReady(RuntimeError):
    """手机现在用不了；信息是给招商员看的。"""


class PhoneStepFailed(RuntimeError):
    """手机上某一步没走通。screenshot 是出错时的截图（可能为空）。"""

    def __init__(self, message: str, screenshot: str | None = None, maybe_sent: bool = False):
        super().__init__(message)
        self.screenshot = screenshot
        self.maybe_sent = maybe_sent


def _adb() -> str | None:
    found = shutil.which("adb")
    if found:
        return found
    # winget 装的 adb 在这些位置；刚装完、环境变量还没刷新时 which 找不到。
    winget = Path.home() / "AppData" / "Local" / "Microsoft" / "WinGet"
    for candidate in [winget / "Links" / "adb.exe", *winget.glob("Packages/Google.PlatformTools_*/platform-tools/adb.exe")]:
        if candidate.exists():
            return str(candidate)
    return None


def _run(*args: str, timeout: int = 15) -> str:
    result = subprocess.run([_adb(), *args], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout, stdin=subprocess.DEVNULL)
    return (result.stdout or "") + (result.stderr or "")


def phone_status() -> dict:
    """手机的状态，一句话说明在 note 里。不改动手机上的任何东西。
    moments_ready / douyin_message_ready 在这里一律是 False：能不能真的去发，由发布程序按网页上的开关和测试结果补上。"""
    status = {"connected": False, "ready": False, "serial": None, "model": None, "wechat": False, "douyin": False,
              "awake": False, "locked": False, "moments_ready": False, "douyin_message_ready": False, "note": ""}
    if not _adb():
        status["note"] = "这台电脑上还没有装连接手机的工具"
        return status
    try:
        lines = [line.split("\t") for line in _run("devices").splitlines()[1:] if "\t" in line]
    except Exception as error:
        status["note"] = f"连接手机的工具出错：{error}"[:120]
        return status
    if not lines:
        status["note"] = "没有连接手机"
        return status
    waiting = [serial for serial, state in lines if state.strip() == "unauthorized"]
    online = [serial for serial, state in lines if state.strip() == "device"]
    if not online:
        status["note"] = "手机已插上，请在手机上点“允许 USB 调试”" if waiting else "手机已插上，但连不上，请重新插拔数据线"
        return status
    if len(online) > 1:
        status["note"] = "连了不止一台手机，只留专用的那一台"
        return status
    serial = online[0]
    status.update(connected=True, serial=serial)
    try:
        status["model"] = _run("-s", serial, "shell", "getprop", "ro.product.model").strip()[:40] or None
        packages = _run("-s", serial, "shell", "pm", "list", "packages")
        status["wechat"] = f"package:{WECHAT}" in packages
        status["douyin"] = f"package:{DOUYIN}" in packages
        power = _run("-s", serial, "shell", "dumpsys", "power")
        status["awake"] = "mWakefulness=Awake" in power
        status["locked"] = "mDreamingLockscreen=true" in _run("-s", serial, "shell", "dumpsys", "window")
    except Exception as error:
        status["note"] = f"手机连上了，但读不到状态：{error}"[:120]
        return status
    # 屏幕黑着不算问题：真要用时会先点亮。锁着（有密码）才是问题。
    problems = [text for missing, text in ((not status["wechat"], "没有装微信"), (not status["douyin"], "没有装抖音"),
                                           (status["locked"] and status["awake"], "屏幕锁着")) if missing]
    status["ready"] = not problems
    status["note"] = "手机已连接，可以使用" if not problems else "手机已连接，但" + "、".join(problems)
    return status


def _connect(app: str | None = None):
    """连上手机，并确认要用的 App 装了。返回 uiautomator2 的设备对象。"""
    status = phone_status()
    if not status["connected"]:
        raise PhoneNotReady(status["note"])
    if app and not status[app]:
        raise PhoneNotReady(f"手机上没有装{APP_LABEL[app]}")
    import uiautomator2
    return uiautomator2.connect(status["serial"])


# ---------- 找控件、截图 ----------

def _find(device, candidates: list[dict], timeout: float = WAIT):
    """按顺序试几种找法，在 timeout 秒内找到一个就返回，找不到返回 None。"""
    deadline = time.monotonic() + timeout
    while True:
        for selector in candidates:
            element = device(**selector)
            if element.exists:
                return element
        if time.monotonic() >= deadline:
            return None
        time.sleep(0.5)


def _snapshot(device, name: str) -> str | None:
    """把当前屏幕的截图和界面结构存到 diagnostics，返回截图路径。存不下来不影响主流程。"""
    try:
        DIAGNOSTICS.mkdir(parents=True, exist_ok=True)
        stem = f"phone_{name}_{time.strftime('%Y%m%d_%H%M%S')}"
        try:
            (DIAGNOSTICS / f"{stem}.xml").write_text(device.dump_hierarchy(), encoding="utf-8")
        except Exception:
            pass
        path = DIAGNOSTICS / f"{stem}.png"
        device.screenshot(str(path))
        return str(path)
    except Exception:
        return None


def _snippet(text: str, limit: int) -> str:
    """拿来在屏幕上找的一小段原文：界面上空格、换行的显示方式说不准，所以取不含空白的最长一段，最多 limit 个字。"""
    pieces = (text or "").split()
    return max(pieces, key=len)[:limit] if pieces else ""


def _step_failed(device, name: str, message: str, maybe_sent: bool = False) -> PhoneStepFailed:
    return PhoneStepFailed(message, _snapshot(device, name), maybe_sent)


def _click(device, candidates: list[dict], what: str, step: str, timeout: float = WAIT) -> None:
    element = _find(device, candidates, timeout)
    if element is None:
        raise _step_failed(device, step, f"手机上没找到“{what}”")
    element.click()
    time.sleep(1)


def _close_popups(device) -> None:
    """升级、权限之类的弹窗点掉。没有就什么都不做。"""
    for _ in range(2):
        element = _find(device, POPUP_CLOSE, timeout=1)
        if element is None:
            return
        element.click()
        time.sleep(1)


def _wake(device) -> None:
    device.screen_on()
    time.sleep(0.5)
    # 没设密码的锁屏，上滑就能解开；设了密码的解不开，后面找不到界面时会报出来。
    try:
        device.unlock()
    except Exception:
        pass


def _go_home(device) -> None:
    try:
        device.press("home")
    except Exception:
        pass


# ---------- 微信 ----------

def _open_wechat(device) -> bool:
    """从头打开微信，回到首页。返回是否已登录。"""
    _wake(device)
    device.app_start(WECHAT, stop=True)
    deadline = time.monotonic() + WAIT * 2
    while time.monotonic() < deadline:
        if _find(device, WECHAT_MAIN, timeout=1) is not None:
            return True
        if _find(device, WECHAT_LOGIN, timeout=1) is not None:
            return False
        _close_popups(device)
    raise _step_failed(device, "wechat_open", "微信打开后一直没进到首页（可能屏幕锁着，或者微信在升级）")


def _open_moments(device) -> None:
    _click(device, WECHAT_MAIN, "发现", "wechat_discover")
    _click(device, WECHAT_MOMENTS_ENTRY, "朋友圈", "wechat_moments_entry")
    if _find(device, WECHAT_CAMERA) is None:
        raise _step_failed(device, "wechat_moments_page", "朋友圈页面没有打开（右上角的相机按钮没找到）")


def check_app(app: str, device=None) -> dict:
    """“测试一下”：打开 App 看一眼要用的页面，截一张图，不发任何东西。
    返回 {logged_in, page_ok, note, screenshot}。"""
    if app not in APP_PACKAGE:
        raise ValueError(app)
    device = device or _connect(app)
    result = {"logged_in": False, "page_ok": False, "note": "", "screenshot": None}
    try:
        if app == "wechat":
            result["logged_in"] = _open_wechat(device)
            if not result["logged_in"]:
                result["note"] = "微信没有登录，请在手机上登录工作微信"
            else:
                _open_moments(device)
                result["page_ok"] = True
                result["note"] = "微信已登录，朋友圈页面能打开"
        else:
            result["logged_in"] = _open_douyin(device)
            if not result["logged_in"]:
                result["note"] = "抖音没有登录，请在手机上登录发帖用的抖音号"
            else:
                _open_douyin_messages(device)
                result["page_ok"] = True
                result["note"] = "抖音已登录，消息页能打开"
        result["screenshot"] = _snapshot(device, f"check_{app}")
    except PhoneStepFailed as error:
        result["note"] = str(error)
        result["screenshot"] = error.screenshot
    finally:
        _go_home(device)
    return result


def _push_images(device, images: list[str]) -> list[str]:
    """把图片推到手机相册。倒着推、每张隔一秒，相册里按时间新到旧排时，第一张图排在最前面。"""
    stamp = time.strftime("%Y%m%d%H%M%S")
    remote_paths = []
    device.shell(["mkdir", "-p", REMOTE_DIR])
    for index in reversed(range(len(images))):
        local = Path(images[index])
        remote = f"{REMOTE_DIR}/hz_{stamp}_{index + 1}{local.suffix.lower() or '.jpg'}"
        device.push(str(local), remote)
        device.shell(["am", "broadcast", "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE", "-d", f"file://{remote}"])
        remote_paths.insert(0, remote)
        time.sleep(1.1)
    time.sleep(2)
    return remote_paths


def _remove_images(device, remote_paths: list[str]) -> None:
    for remote in remote_paths:
        try:
            device.shell(["rm", "-f", remote])
            device.shell(["am", "broadcast", "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE", "-d", f"file://{remote}"])
        except Exception:
            pass


def _pick_album_images(device, count: int) -> None:
    """在“从相册选择”里，从最新的开始勾选 count 张，然后点“完成”。"""
    _click(device, WECHAT_FROM_ALBUM, "从相册选择", "wechat_from_album")
    boxes = None
    for selector in WECHAT_ALBUM_CHECK:
        found = device(**selector)
        if found.wait(timeout=WAIT) and found.count >= count:
            boxes = found
            break
    if boxes is None:
        raise _step_failed(device, "wechat_album", "相册里没找到可以勾选的图片")
    for index in range(count):
        boxes[index].click()
        time.sleep(0.6)
    _click(device, WECHAT_ALBUM_DONE, "完成", "wechat_album_done")


def post_moments(text: str, images: list[str], device=None) -> dict:
    """发一条朋友圈：有图就从相册选图，没图就长按相机按钮发纯文字。
    发完回到朋友圈里找这条的开头，找到才算发出。返回 {screenshot}。"""
    text = (text or "").strip()
    if not text and not images:
        raise PhoneNotReady("这条朋友圈既没有文字也没有图片")
    if len(images) > MAX_IMAGES:
        raise PhoneNotReady(f"朋友圈一次最多 {MAX_IMAGES} 张图，这条有 {len(images)} 张")
    missing = [path for path in images if not Path(path).exists()]
    if missing:
        raise PhoneNotReady(f"素材文件找不到：{Path(missing[0]).name}")
    device = device or _connect("wechat")
    pushed: list[str] = []
    try:
        if not _open_wechat(device):
            raise PhoneNotReady("微信没有登录，请在手机上登录工作微信")
        if images:
            pushed = _push_images(device, images)
        _open_moments(device)
        camera = _find(device, WECHAT_CAMERA)
        if images:
            camera.click()
            time.sleep(1)
            _pick_album_images(device, len(images))
        else:
            camera.long_click(duration=1.5)
            time.sleep(1)
            got_it = _find(device, WECHAT_GOT_IT, timeout=SHORT)
            if got_it is not None:
                got_it.click()
                time.sleep(1)
        editor = _find(device, WECHAT_EDITOR)
        if editor is None:
            raise _step_failed(device, "wechat_editor", "写朋友圈的页面没有打开")
        if text:
            editor.click()
            editor.set_text(text)
            time.sleep(1)
        _click(device, WECHAT_PUBLISH, "发表", "wechat_publish")
        # 发表后回到朋友圈，最上面是刚发的这一条。按正文开头去找。
        snippet = _snippet(text, 10)
        if snippet:
            seen = _find(device, [{"textContains": snippet, "classNameMatches": NOT_INPUT}], timeout=WAIT * 2)
            if seen is None:
                raise _step_failed(device, "wechat_verify", "已经点了“发表”，但朋友圈里没看到这一条。可能已经发出，请到手机上看一眼，不要直接重发", maybe_sent=True)
        else:
            time.sleep(SHORT)
            if _find(device, WECHAT_CAMERA, timeout=WAIT) is None:
                raise _step_failed(device, "wechat_verify", "已经点了“发表”，但没有回到朋友圈。可能已经发出，请到手机上看一眼，不要直接重发", maybe_sent=True)
        return {"screenshot": _snapshot(device, "moments_posted")}
    finally:
        _remove_images(device, pushed)
        _go_home(device)


# ---------- 抖音 ----------

def _open_douyin(device) -> bool:
    """从头打开抖音。返回是否已登录（底部有“消息”，并且没有弹登录框）。"""
    _wake(device)
    device.app_start(DOUYIN, stop=True)
    deadline = time.monotonic() + WAIT * 2
    while time.monotonic() < deadline:
        _close_popups(device)
        if _find(device, DOUYIN_LOGIN, timeout=1) is not None:
            return False
        if _find(device, DOUYIN_MESSAGE_TAB, timeout=1) is not None:
            return True
    raise _step_failed(device, "douyin_open", "抖音打开后一直没进到首页（可能屏幕锁着，或者抖音在升级）")


def _open_douyin_messages(device) -> None:
    _click(device, DOUYIN_MESSAGE_TAB, "消息", "douyin_message_tab")
    if _find(device, DOUYIN_LOGIN, timeout=2) is not None:
        raise _step_failed(device, "douyin_message_login", "抖音要求重新登录")
    if _find(device, DOUYIN_MESSAGE_PAGE) is None:
        raise _step_failed(device, "douyin_message_page", "抖音的消息页没有打开")


def _find_conversation(device, sender_name: str):
    """在消息列表里找这个人的会话：先找当前页，往下翻几屏；再到“陌生人消息”里找。"""
    target = [{"text": sender_name}]
    element = _find(device, target, timeout=SHORT)
    for _ in range(4):
        if element is not None:
            return element
        device.swipe_ext("up", scale=0.6)
        time.sleep(1)
        element = _find(device, target, timeout=2)
    if element is not None:
        return element
    folder = _find(device, DOUYIN_STRANGER_FOLDER, timeout=2)
    if folder is not None:
        folder.click()
        time.sleep(1.5)
        return _find(device, target, timeout=SHORT)
    return None


def send_douyin_message(sender_name: str, last_text: str, reply_text: str, device=None) -> dict:
    """在手机的抖音 App 里给这个人回一句。
    打开会话后先核对对方说过的那句话在不在，不在就不发（防止同名的人）。发完在对话里找到这句、没有“发送失败”才算发出。
    返回 {screenshot}。"""
    reply_text = (reply_text or "").strip()
    if not reply_text:
        raise PhoneNotReady("回复内容是空的")
    device = device or _connect("douyin")
    try:
        if not _open_douyin(device):
            raise PhoneNotReady("抖音没有登录，请在手机上登录发帖用的抖音号")
        _open_douyin_messages(device)
        conversation = _find_conversation(device, sender_name)
        if conversation is None:
            raise _step_failed(device, "douyin_conversation", f"消息列表里没找到“{sender_name}”的会话")
        conversation.click()
        time.sleep(1.5)
        heard = _snippet(last_text, 8)
        if heard and _find(device, [{"textContains": heard, "classNameMatches": NOT_INPUT}], timeout=WAIT) is None:
            raise _step_failed(device, "douyin_wrong_conversation", f"打开的会话里没看到“{sender_name}”说的那句话，为了不发错人，没有发送")
        box = _find(device, DOUYIN_INPUT)
        if box is None:
            raise _step_failed(device, "douyin_input", "会话里没找到输入框（对方可能限制了私信）")
        box.click()
        time.sleep(0.5)
        box.set_text(reply_text)
        time.sleep(1)
        _click(device, DOUYIN_SEND, "发送", "douyin_send", timeout=SHORT * 2)
        snippet = _snippet(reply_text, 12)
        # 输入框里还留着这句话不算（说明没发出去），要在对话气泡里看到。
        if _find(device, [{"textContains": snippet, "classNameMatches": NOT_INPUT}], timeout=WAIT) is None:
            raise _step_failed(device, "douyin_verify", "已经点了“发送”，但会话里没看到这句话。请到手机上看一眼，不要直接重发", maybe_sent=True)
        time.sleep(2)
        if _find(device, DOUYIN_SEND_FAILED, timeout=1) is not None:
            raise _step_failed(device, "douyin_send_failed", "抖音提示这条私信发送失败", maybe_sent=False)
        return {"screenshot": _snapshot(device, "douyin_sent")}
    finally:
        _go_home(device)


def dump_screen(name: str) -> Path:
    """把当前屏幕的界面结构和截图存下来，对界面时用。只读。"""
    device = _connect()
    DIAGNOSTICS.mkdir(parents=True, exist_ok=True)
    (DIAGNOSTICS / f"phone_{name}.xml").write_text(device.dump_hierarchy(), encoding="utf-8")
    device.screenshot(str(DIAGNOSTICS / f"phone_{name}.png"))
    return DIAGNOSTICS / f"phone_{name}.png"


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else "status"
    if command == "status":
        for key, value in phone_status().items():
            print(f"{key}: {value}")
    elif command == "check" and len(sys.argv) == 3 and sys.argv[2] in APP_PACKAGE:
        for key, value in check_app(sys.argv[2]).items():
            print(f"{key}: {value}")
    elif command == "dump" and len(sys.argv) == 3:
        print("已保存：", dump_screen(sys.argv[2]))
    else:
        print(__doc__)
