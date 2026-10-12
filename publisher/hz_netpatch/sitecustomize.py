"""让这个进程里打开的浏览器走直连通道（见 publisher/direct_proxy.py）。

发布程序给自己和它调用的发布组件都带上这个目录（PYTHONPATH）和 HZ_DIRECT_PROXY 环境变量；
Python 启动时会自动加载名叫 sitecustomize 的模块。没有设置 HZ_DIRECT_PROXY 时这里什么都不做。
这样不用去改开源组件里每一处打开浏览器的代码。
"""
import os

_proxy = os.environ.get("HZ_DIRECT_PROXY")


def _wrap(browser_type_class):
    for name in ("launch", "launch_persistent_context"):
        original = getattr(browser_type_class, name, None)
        if original is None or getattr(original, "_hz_direct", False):
            continue

        def make(original=original):
            async def launch(self, *args, **kwargs):
                # 调用方自己指定了代理的，尊重它。
                kwargs.setdefault("proxy", {"server": _proxy})
                return await original(self, *args, **kwargs)
            launch._hz_direct = True
            return launch

        setattr(browser_type_class, name, make())


if _proxy:
    for module_name in ("patchright.async_api", "playwright.async_api"):
        try:
            module = __import__(module_name, fromlist=["BrowserType"])
            _wrap(module.BrowserType)
        except Exception:
            # 这个进程里没有装对应的库，或库的结构变了：不拦着程序启动，只是这个库不走直连。
            pass
