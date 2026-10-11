"""专用安卓手机：发朋友圈、在抖音 App 里回私信。用开源的 uiautomator2 通过 USB 操作手机。

现在的进度（2026-10-12）：手机还没到。已经写好并能跑的是“看手机在不在、能不能用”；
真正去点 App 的两个动作（发朋友圈、回抖音私信）要对着真机看过界面才能写，这里先留着接口，
调用时明确报“还没有对着真机调过”，不假装能用。手机接上后：

  publisher\\.venv\\Scripts\\python.exe publisher\\phone_driver.py status     看手机状态
  publisher\\.venv\\Scripts\\python.exe publisher\\phone_driver.py dump <名字>  把当前屏幕的界面结构和截图存到 publisher/state/diagnostics/

手机要求：打开“USB 调试”，连上这台电脑并在手机上点“允许调试”，亮屏解锁，登录好工作微信和发帖用的抖音号。
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent.resolve()
WECHAT = "com.tencent.mm"
DOUYIN = "com.ss.android.ugc.aweme"
# 两个动作各自对着真机调通、并从对方那一侧验证过以后，才改成 True。
MOMENTS_READY = False
DOUYIN_MESSAGE_READY = False


class PhoneNotReady(RuntimeError):
    """手机现在用不了；信息是给招商员看的。"""


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
    """手机的状态，一句话说明在 note 里。不改动手机上的任何东西。"""
    status = {"connected": False, "ready": False, "serial": None, "model": None, "wechat": False, "douyin": False,
              "moments_ready": MOMENTS_READY, "douyin_message_ready": DOUYIN_MESSAGE_READY, "note": ""}
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
        awake = "mWakefulness=Awake" in power
        locked = "mDreamingLockscreen=true" in _run("-s", serial, "shell", "dumpsys", "window")
    except Exception as error:
        status["note"] = f"手机连上了，但读不到状态：{error}"[:120]
        return status
    problems = [text for missing, text in ((not status["wechat"], "没有装微信"), (not status["douyin"], "没有装抖音"),
                                           (not awake, "屏幕是黑的"), (locked, "屏幕锁着")) if missing]
    status["ready"] = not problems
    status["note"] = "手机已连接，可以使用" if not problems else "手机已连接，但" + "、".join(problems)
    return status


def _device():
    status = phone_status()
    if not status["connected"]:
        raise PhoneNotReady(status["note"])
    import uiautomator2
    return uiautomator2.connect(status["serial"]), status


def dump_screen(name: str) -> Path:
    """把当前屏幕的界面结构和截图存下来，写点击步骤时对着看。只读。"""
    device, _ = _device()
    folder = HERE / "state" / "diagnostics"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"phone_{name}.xml").write_text(device.dump_hierarchy(), encoding="utf-8")
    device.screenshot(str(folder / f"phone_{name}.png"))
    return folder / f"phone_{name}.png"


def post_moments(text: str, images: list[str]) -> None:
    """发一条朋友圈。还没有对着真机调过，现在调用一定报错。"""
    status = phone_status()
    if not status["ready"]:
        raise PhoneNotReady(status["note"])
    if not MOMENTS_READY:
        raise PhoneNotReady("手机已连接，但发朋友圈的步骤还没有对着这台手机调过")
    raise NotImplementedError


def send_douyin_message(sender_name: str, last_text: str, reply_text: str) -> None:
    """在手机的抖音 App 里给这个人回一句。还没有对着真机调过，现在调用一定报错。"""
    status = phone_status()
    if not status["ready"]:
        raise PhoneNotReady(status["note"])
    if not DOUYIN_MESSAGE_READY:
        raise PhoneNotReady("手机已连接，但在抖音里回私信的步骤还没有对着这台手机调过")
    raise NotImplementedError


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else "status"
    if command == "status":
        for key, value in phone_status().items():
            print(f"{key}: {value}")
    elif command == "dump" and len(sys.argv) == 3:
        print("已保存：", dump_screen(sys.argv[2]))
    else:
        print(__doc__)
