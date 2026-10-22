"""用一台“假手机”把 phone_driver 里的几个动作走一遍，检查点击顺序和出错处理。不需要真手机，不连数据库。

  publisher\\.venv\\Scripts\\python.exe publisher\\tools\\check_phone_flow.py

假手机按页面来模拟：每个页面是一组控件（文字、描述、类名），点某个控件会跳到下一个页面。
真机到了以后，界面上的名字要用 `phone_driver.py dump <名字>` 对一遍，这里只证明流程本身对。
"""
from __future__ import annotations

import re
import sys
import tempfile
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import phone_driver  # noqa: E402
from phone_driver import PhoneNotReady, PhoneStepFailed  # noqa: E402


class FakeClock:
    """不真等：每问一次时间就往前走半秒，等待循环很快就到点。"""

    def __init__(self):
        self.now = 0.0

    def monotonic(self):
        self.now += 0.5
        return self.now

    def sleep(self, _seconds):
        self.now += 0.01

    def strftime(self, fmt):
        return "20261022_120000" if "_" in fmt else "20261022120000"


def node(text=None, description=None, class_name="android.widget.TextView", go=None, on_click=None):
    return {"text": text, "description": description, "className": class_name, "go": go, "on_click": on_click}


def matches(item: dict, selector: dict) -> bool:
    for key, wanted in selector.items():
        text, desc = item["text"] or "", item["description"] or ""
        if key == "text" and text != wanted:
            return False
        if key == "textContains" and (not text or wanted not in text):
            return False
        if key == "textMatches" and not re.match(wanted, text):
            return False
        if key == "textStartsWith" and not text.startswith(wanted):
            return False
        if key == "description" and desc != wanted:
            return False
        if key == "descriptionContains" and (not desc or wanted not in desc):
            return False
        if key == "className" and item["className"] != wanted:
            return False
        if key == "classNameMatches" and not re.match(wanted, item["className"]):
            return False
    return True


class FakeElement:
    def __init__(self, device, items):
        self.device, self.items = device, items

    @property
    def exists(self):
        return bool(self.items)

    @property
    def count(self):
        return len(self.items)

    def wait(self, timeout=None):
        return self.exists

    def __getitem__(self, index):
        return FakeElement(self.device, [self.items[index]])

    def _target(self):
        if not self.items:
            raise AssertionError("点了一个不存在的控件")
        return self.items[0]

    def click(self):
        self.device.tap(self._target(), "click")

    def long_click(self, duration=None):
        self.device.tap(self._target(), "long_click")

    def set_text(self, text):
        item = self._target()
        item["text"] = text  # 输入框里显示着打的字，核对时不能把它当成已发出
        self.device.log.append(("set_text", text))
        self.device.typed = text


class FakeDevice:
    """screens: {页面名: [控件...]}；控件的 go 是点了以后去的页面（可以是 {"click": 页面, "long_click": 页面}）。"""

    def __init__(self, screens: dict, start: dict):
        self.screens, self.start, self.screen = screens, start, None
        self.log: list[tuple] = []
        self.typed = ""
        self.sent: list[str] = []

    def __call__(self, **selector):
        items = [item for item in self.screens.get(self.screen, []) if matches(item, selector)]
        return FakeElement(self, items)

    def tap(self, item, kind):
        self.log.append((kind, item["text"] or item["description"] or item["className"]))
        if item["on_click"]:
            item["on_click"](self)
        target = item["go"].get(kind) if isinstance(item["go"], dict) else item["go"]
        if target:
            self.screen = target

    def app_start(self, package, stop=False):
        self.log.append(("app_start", package, stop))
        self.screen = self.start[package]

    def screen_on(self):
        self.log.append(("screen_on",))

    def unlock(self):
        pass

    def press(self, key):
        self.log.append(("press", key))
        self.screen = "launcher"

    def push(self, local, remote):
        self.log.append(("push", Path(local).name, remote))

    def shell(self, command):
        self.log.append(("shell", " ".join(command) if isinstance(command, list) else command))

    def swipe_ext(self, direction, scale=None):
        self.log.append(("swipe", direction))

    def screenshot(self, path):
        Path(path).write_bytes(b"png")
        self.log.append(("screenshot", Path(path).name))

    def dump_hierarchy(self):
        return "<hierarchy/>"

    def actions(self, kind):
        return [entry[1] for entry in self.log if entry[0] == kind]


# ---------- 两个 App 的假界面 ----------

def wechat(album_boxes=3, show_post=True, logged_in=True):
    def publish(device):
        if show_post:
            device.screens["moments_after"].append(node(text=device.typed))
    boxes = [node(class_name="android.widget.CheckBox", go=None) for _ in range(album_boxes)]
    return FakeDevice({
        "login": [node(text="登录"), node(text="注册")],
        "home": [node(text="微信"), node(text="通讯录"), node(text="发现", go="discover"), node(text="我")],
        "discover": [node(text="发现", go="discover"), node(text="朋友圈", go="moments"), node(text="视频号")],
        "moments": [node(text="朋友圈"), node(description="拍照分享", class_name="android.widget.ImageView", go={"click": "menu", "long_click": "editor"})],
        "menu": [node(text="拍摄"), node(text="从相册选择", go="album"), node(text="取消")],
        "album": [*boxes, node(text="完成(0/9)", class_name="android.widget.Button", go="editor")],
        "editor": [node(class_name="android.widget.EditText"), node(text="发表", class_name="android.widget.Button", go="moments_after", on_click=publish)],
        "moments_after": [node(text="朋友圈"), node(description="拍照分享", class_name="android.widget.ImageView")],
    }, {phone_driver.WECHAT: "home" if logged_in else "login"})


def douyin(sender="王先生", last="1307 还租吗", in_list=True, in_folder=False, send_ok=True, echo=True):
    def send(device):
        device.sent.append(device.typed)
        if echo:
            device.screens["chat"].append(node(text=device.typed))
            for item in device.screens["chat"]:
                if item["className"] == "android.widget.EditText":
                    item["text"] = None
        if not send_ok:
            device.screens["chat"].append(node(description="发送失败", class_name="android.widget.ImageView"))
    conversation = node(text=sender, go="chat")
    return FakeDevice({
        "home": [node(text="首页"), node(text="朋友"), node(text="消息", go="messages"), node(text="我")],
        "messages": [node(text="互动消息"), node(text="新朋友"), *([conversation] if in_list else []),
                     *([node(text="陌生人消息", go="strangers")] if in_folder else [])],
        "strangers": [node(text="陌生人消息"), conversation],
        "chat": [node(text=sender), node(text=last), node(class_name="android.widget.EditText"), node(text="发送", go="chat", on_click=send)],
    }, {phone_driver.DOUYIN: "home"})


# ---------- 检查 ----------

results: list[tuple[str, bool, str]] = []


def check(name):
    def wrap(fn):
        try:
            fn()
            results.append((name, True, ""))
        except Exception as error:
            results.append((name, False, f"{type(error).__name__}: {error}\n{traceback.format_exc(limit=3)}"))
        return fn
    return wrap


def images(count):
    folder = Path(tempfile.mkdtemp(prefix="hz_phone_imgs_"))
    paths = []
    for index in range(count):
        path = folder / f"p{index + 1}.jpg"
        path.write_bytes(b"jpg")
        paths.append(str(path))
    return paths


def main() -> int:
    phone_driver.time = FakeClock()
    phone_driver.DIAGNOSTICS = Path(tempfile.mkdtemp(prefix="hz_phone_diag_"))

    @check("测试微信：打开微信 → 发现 → 朋友圈，截图，回桌面，不发东西")
    def _():
        device = wechat()
        result = phone_driver.check_app("wechat", device)
        assert result["logged_in"] and result["page_ok"], result
        assert ("app_start", phone_driver.WECHAT, True) in device.log
        assert device.actions("click") == ["发现", "朋友圈"], device.actions("click")
        assert result["screenshot"] and Path(result["screenshot"]).exists()
        assert device.log[-1] == ("press", "home")
        assert not device.actions("set_text") and not device.actions("long_click")

    @check("测试微信：没登录时报“没有登录”，不往下点")
    def _():
        device = wechat(logged_in=False)
        result = phone_driver.check_app("wechat", device)
        assert result["logged_in"] is False and not result["page_ok"], result
        assert "没有登录" in result["note"]
        assert device.actions("click") == []

    @check("测试抖音：打开抖音 → 消息，截图，不发东西")
    def _():
        device = douyin()
        result = phone_driver.check_app("douyin", device)
        assert result["logged_in"] and result["page_ok"], result
        assert device.actions("click") == ["消息"]
        assert not device.sent

    @check("发朋友圈（2 张图）：推图 → 相机 → 从相册选择 → 勾 2 张 → 完成 → 写字 → 发表 → 核对 → 删图")
    def _():
        device = wechat()
        paths = images(2)
        result = phone_driver.post_moments("恒兆广场 1 栋 13 层整层招租，欢迎来看", paths, device)
        assert result["screenshot"]
        pushed = [entry for entry in device.log if entry[0] == "push"]
        assert [entry[1] for entry in pushed] == ["p2.jpg", "p1.jpg"], pushed  # 倒着推：第一张最新，排在相册最前
        assert device.actions("click") == ["发现", "朋友圈", "拍照分享", "从相册选择", "android.widget.CheckBox", "android.widget.CheckBox", "完成(0/9)", "android.widget.EditText", "发表"], device.actions("click")
        assert device.actions("set_text") == ["恒兆广场 1 栋 13 层整层招租，欢迎来看"]
        removed = [entry[1] for entry in device.log if entry[0] == "shell" and entry[1].startswith("rm -f")]
        assert len(removed) == 2, removed
        assert device.log[-1] == ("press", "home")

    @check("发朋友圈（纯文字）：长按相机按钮")
    def _():
        device = wechat()
        phone_driver.post_moments("周末宜尚酒店有空房", [], device)
        assert device.actions("long_click") == ["拍照分享"]
        assert "发表" in device.actions("click") and not [entry for entry in device.log if entry[0] == "push"]

    @check("发朋友圈：相册里勾不到图时停下、截图、删掉推上去的图，不点“发表”")
    def _():
        device = wechat(album_boxes=0)
        try:
            phone_driver.post_moments("测试", images(1), device)
        except PhoneStepFailed as error:
            assert "相册" in str(error) and error.screenshot and Path(error.screenshot).exists()
            assert not error.maybe_sent
        else:
            raise AssertionError("应该报错")
        assert "发表" not in device.actions("click")
        assert any(entry[1].startswith("rm -f") for entry in device.log if entry[0] == "shell")
        assert device.log[-1] == ("press", "home")

    @check("发朋友圈：点了“发表”却没在朋友圈里看到这条时，报“可能已经发出，不要直接重发”")
    def _():
        device = wechat(show_post=False)
        try:
            phone_driver.post_moments("恒兆广场招商", images(1), device)
        except PhoneStepFailed as error:
            assert error.maybe_sent and "不要直接重发" in str(error)
        else:
            raise AssertionError("应该报错")

    @check("发朋友圈：超过 9 张图、文件找不到时不碰手机")
    def _():
        device = wechat()
        for args in (("文字", images(10)), ("文字", ["E:/不存在/1.jpg"]), ("", [])):
            try:
                phone_driver.post_moments(*args, device=device)
            except PhoneNotReady:
                pass
            else:
                raise AssertionError("应该报错")
        assert device.log == []

    @check("微信没登录时发朋友圈报“没有登录”")
    def _():
        device = wechat(logged_in=False)
        try:
            phone_driver.post_moments("文字", [], device)
        except PhoneNotReady as error:
            assert "没有登录" in str(error)
        else:
            raise AssertionError("应该报错")

    @check("回抖音私信：消息 → 找到会话 → 核对对方的话 → 输入 → 发送 → 看到这句")
    def _():
        device = douyin()
        result = phone_driver.send_douyin_message("王先生", "1307 还租吗", "您好，1307 还在租，方便留个电话吗", device)
        assert result["screenshot"]
        assert device.actions("click") == ["消息", "王先生", "android.widget.EditText", "发送"], device.actions("click")
        assert device.sent == ["您好，1307 还在租，方便留个电话吗"]
        assert device.log[-1] == ("press", "home")

    @check("回抖音私信：会话在“陌生人消息”里也能找到")
    def _():
        device = douyin(in_list=False, in_folder=True)
        phone_driver.send_douyin_message("王先生", "1307 还租吗", "您好", device)
        assert "陌生人消息" in device.actions("click") and device.sent == ["您好"]
        assert device.actions("swipe"), "先在列表里往下翻"

    @check("回抖音私信：会话里没有对方说过的那句话（可能同名）时不发")
    def _():
        device = douyin(last="别的话")
        try:
            phone_driver.send_douyin_message("王先生", "1307 还租吗", "您好", device)
        except PhoneStepFailed as error:
            assert "没有发送" in str(error) and error.screenshot
        else:
            raise AssertionError("应该报错")
        assert not device.sent and not device.actions("set_text")

    @check("回抖音私信：找不到这个人时报原因，不发")
    def _():
        device = douyin(in_list=False)
        try:
            phone_driver.send_douyin_message("王先生", "1307 还租吗", "您好", device)
        except PhoneStepFailed as error:
            assert "没找到" in str(error)
        else:
            raise AssertionError("应该报错")
        assert not device.sent

    @check("回抖音私信：抖音提示“发送失败”时算没发出")
    def _():
        device = douyin(send_ok=False)
        try:
            phone_driver.send_douyin_message("王先生", "1307 还租吗", "您好", device)
        except PhoneStepFailed as error:
            assert "发送失败" in str(error) and not error.maybe_sent
        else:
            raise AssertionError("应该报错")

    @check("回抖音私信：点了发送却没看到这句时，报“不要直接重发”")
    def _():
        device = douyin(echo=False)
        try:
            phone_driver.send_douyin_message("王先生", "1307 还租吗", "您好", device)
        except PhoneStepFailed as error:
            assert error.maybe_sent and "不要直接重发" in str(error)
        else:
            raise AssertionError("应该报错")

    @check("回复内容是空的不碰手机")
    def _():
        device = douyin()
        try:
            phone_driver.send_douyin_message("王先生", "", "  ", device)
        except PhoneNotReady:
            pass
        else:
            raise AssertionError("应该报错")
        assert device.log == []

    failed = [item for item in results if not item[1]]
    for name, ok, detail in results:
        print(f"{'通过' if ok else '没通过'}  {name}")
        if detail:
            print("      " + detail.replace("\n", "\n      "))
    print(f"\n共 {len(results)} 项，通过 {len(results) - len(failed)} 项，没通过 {len(failed)} 项")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
