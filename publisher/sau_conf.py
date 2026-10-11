# social-auto-upload 的配置。setup.ps1 会把它复制成 vendor/social-auto-upload/conf.py。
from pathlib import Path

BASE_DIR = Path(__file__).parent.resolve()
XHS_SERVER = "http://127.0.0.1:11901"
LOCAL_CHROME_PATH = ""
# 发布时不弹浏览器窗口；扫码登录由命令行参数 --headed 单独打开窗口。
LOCAL_CHROME_HEADLESS = True
DEBUG_MODE = False
YT_PROXY = None
