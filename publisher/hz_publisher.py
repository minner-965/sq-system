"""恒兆广场内容发布程序。

只发布已经人工确认、并且到了发布时间的任务；一次只发一条；同一账号两次发布至少隔 10 分钟；
失败不重试，记下原因并通知。真正去平台发布的动作交给开源组件 social-auto-upload（vendor/ 下，固定版本）。

用法（在仓库根目录）：
  publisher\\.venv\\Scripts\\python.exe publisher\\hz_publisher.py login <发布账号名称>   弹出浏览器扫码登录
  publisher\\.venv\\Scripts\\python.exe publisher\\hz_publisher.py check                  检查各账号登录是否有效
  publisher\\.venv\\Scripts\\python.exe publisher\\hz_publisher.py once                   处理一遍到点的任务
  publisher\\.venv\\Scripts\\python.exe publisher\\hz_publisher.py run                    常驻运行，每 20 秒看一次
"""
from __future__ import annotations

import asyncio
import hashlib
import os
import random
import subprocess
import sys
import time
from pathlib import Path

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from xiaohongshu_reader import read_xiaohongshu_notes
from douyin_reader import ReplyError, read_douyin, read_douyin_metrics, read_stranger_messages, send_comment_reply, send_stranger_message

HERE = Path(__file__).parent.resolve()
ROOT = HERE.parent
VENDOR = HERE / "vendor" / "social-auto-upload"
MEDIA_DIR = Path(os.environ.get("HZ_MEDIA_DIR") or ROOT / "data" / "media")
# 写进在线状态里，方便确认正在运行的是不是最新的程序。改了发布逻辑就加一。
VERSION = "v9"
POLL_SECONDS = 20
RUN_LOCK_KEY = 20261011
# 两条私信回复之间至少隔这么久（发得太密容易被平台限制）。
MESSAGE_GAP_MINUTES = 3
METRICS_HOURS = 6
METRICS_DAYS = 30
MIN_GAP_MINUTES = 10
UPLOAD_TIMEOUT_SECONDS = 15 * 60
# 发布组件里各平台的名字。没列出的平台还没有接入。
SAU_PLATFORM = {"douyin": "douyin", "xiaohongshu": "xiaohongshu", "channels": "tencent"}
# 只能发视频、不能发图文的平台。
VIDEO_ONLY = {"channels"}
PLATFORM_LABEL = {"douyin": "抖音", "channels": "视频号", "xiaohongshu": "小红书", "moments": "朋友圈"}


def load_env() -> dict[str, str]:
    """读仓库根目录的 .env；进程环境变量优先。"""
    values: dict[str, str] = {}
    env_file = ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                values[key.strip()] = value.strip()
    values.update(os.environ)
    return values


def connect() -> psycopg.Connection:
    env = load_env()
    return psycopg.connect(
        host=env.get("HZ_DB_HOST", "127.0.0.1"),
        port=int(env.get("HZ_DB_PORT") or env.get("POSTGRES_HOST_PORT") or 5433),
        dbname=env["POSTGRES_DB"],
        user=env["POSTGRES_USER"],
        password=env["POSTGRES_PASSWORD"],
        options=f"-c TimeZone={env.get('TZ', 'Asia/Shanghai')}",
        row_factory=dict_row,
        autocommit=True,
    )


def sau(*args: str, timeout: int = 120, capture: bool = True, extra_env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    """调用发布组件的命令行。登录状态文件按账号编号命名，放在 publisher/state/cookies。"""
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1", **(extra_env or {})}
    return subprocess.run(
        [sys.executable, "sau_cli.py", *args], cwd=VENDOR, env=env, timeout=timeout,
        capture_output=capture, text=True, encoding="utf-8", errors="replace", stdin=subprocess.DEVNULL,
    )


def run_upload(conn: psycopg.Connection, task: dict, args: list[str], screenshot: Path) -> tuple[int, str]:
    """带窗口运行一次上传。平台要求短信验证时发通知，等人在弹出的窗口里输入。返回退出码和输出。"""
    flag = HERE / "state" / f"sms_waiting_{task['account_id']}.flag"
    flag.unlink(missing_ok=True)
    log_file = HERE / "state" / f"upload_{task['id']}.log"
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1", "HZ_FAILURE_SCREENSHOT": str(screenshot), "HZ_SMS_FLAG": str(flag)}
    started = time.monotonic()
    notified = False
    with open(log_file, "w", encoding="utf-8", errors="replace") as output:
        process = subprocess.Popen([sys.executable, "sau_cli.py", *args, "--headed"], cwd=VENDOR, env=env, stdout=output, stderr=subprocess.STDOUT,
                                   stdin=subprocess.DEVNULL)  # 组件遇到验证码时会想在这个黑色窗口里等人打字；不给它键盘，一律在浏览器窗口里处理
        while process.poll() is None:
            if not notified and flag.exists():
                notified = True
                # 标记里写着“获取验证码”有没有自动点上；没点上要告诉人先点。
                requested = flag.read_text(encoding="utf-8", errors="replace").strip() != "manual"
                step = "验证码已经自动发到手机，请在弹出的浏览器窗口里输入，然后点“验证”" if requested else "请在弹出的浏览器窗口里先点“获取验证码”，再输入手机收到的验证码，然后点“验证”"
                print(f"抖音要求短信验证：{step}。（{task['account_name']}）")
                notify(conn, "抖音要求短信验证", f"正在发布“{task['topic']}”。{step}，10 分钟内有效。",
                       f"/publishing.html?id={task['material_id']}", task["confirmed_by"])
            if time.monotonic() - started > UPLOAD_TIMEOUT_SECONDS:
                process.kill()
                process.wait()
                flag.unlink(missing_ok=True)
                raise subprocess.TimeoutExpired(args, UPLOAD_TIMEOUT_SECONDS)
            time.sleep(1)
    flag.unlink(missing_ok=True)
    text = log_file.read_text(encoding="utf-8", errors="replace")
    log_file.unlink(missing_ok=True)
    return process.returncode, text


def last_lines(text: str, limit: int = 300) -> str:
    lines = [line.strip() for line in (text or "").splitlines() if line.strip()]
    # 组件报错的最后一行通常是 “RuntimeError: 原因”，只留原因。
    for line in reversed(lines):
        if line.startswith(("RuntimeError:", "ValueError:")):
            return line.split(":", 1)[1].strip()[:limit]
    return " / ".join(lines[-3:])[-limit:]


def notify(conn: psycopg.Connection, title: str, body: str, link: str, user_id=None) -> None:
    conn.execute(
        "INSERT INTO leadgen.notifications (recipient_role, kind, title, body, link) VALUES ('admin', 'publishing', %s, %s, %s)",
        (title, body, link))
    # 确认这条内容的人如果本身就是管理员，上面那条已经能看到，不再发第二遍。
    if user_id and not conn.execute("SELECT 1 FROM leadgen.users WHERE id = %s AND role_key = 'admin'", (user_id,)).fetchone():
        conn.execute(
            "INSERT INTO leadgen.notifications (recipient_user_id, kind, title, body, link) VALUES (%s, 'publishing', %s, %s, %s)",
            (user_id, title, body, link))


def account_is_logged_in(conn: psycopg.Connection, account: dict) -> bool:
    result = sau(SAU_PLATFORM[account["platform"]], "check", "--account", str(account["id"]))
    valid = result.returncode == 0 and "valid" in result.stdout and "invalid" not in result.stdout
    status = "ok" if valid else ("never" if account["login_status"] == "never" else "expired")
    conn.execute("UPDATE leadgen.publish_accounts SET login_status = %s, updated_at = now() WHERE id = %s", (status, account["id"]))
    return valid


def login(conn: psycopg.Connection, account: dict) -> tuple[bool, str]:
    """弹出浏览器让人扫码。返回是否成功和一句说明。"""
    if account["platform"] not in SAU_PLATFORM:
        return False, f"{PLATFORM_LABEL[account['platform']]}还没有接入"
    print(f"即将弹出浏览器窗口，请用{PLATFORM_LABEL[account['platform']]} App 扫码登录“{account['account_name']}”。")
    try:
        result = sau(SAU_PLATFORM[account["platform"]], "login", "--account", str(account["id"]), "--headed", timeout=600, capture=False)
    except subprocess.TimeoutExpired:
        return False, "10 分钟内没有扫码"
    if result.returncode != 0 or not account_is_logged_in(conn, account):
        return False, "登录没有成功，请重新发起"
    conn.execute("UPDATE leadgen.publish_accounts SET login_status = 'ok', last_login_at = now(), updated_at = now() WHERE id = %s", (account["id"],))
    return True, "登录成功"


def command_login(account_name: str) -> int:
    with connect() as conn:
        account = conn.execute(
            "SELECT id, platform, account_name, login_status FROM leadgen.publish_accounts WHERE account_name = %s", (account_name,)).fetchone()
        if not account:
            print(f"没有找到发布账号“{account_name}”，请先在“发布账号”页添加。")
            return 1
        ok, message = login(conn, account)
        print(message)
        return 0 if ok else 1


def process_login_requests(conn: psycopg.Connection) -> None:
    """处理页面上发起的扫码登录。超过 15 分钟没被处理的请求作废，免得很久以后突然弹窗。"""
    conn.execute(
        "UPDATE leadgen.publish_login_requests SET status = 'failed', message = '发布程序当时没有在运行', finished_at = now() "
        "WHERE status = 'queued' AND created_at < now() - interval '15 minutes'")
    while True:
        request = conn.execute(
            """
            SELECT r.id AS request_id, a.id, a.platform, a.account_name, a.login_status
            FROM leadgen.publish_login_requests r JOIN leadgen.publish_accounts a ON a.id = r.account_id
            WHERE r.status = 'queued' ORDER BY r.created_at LIMIT 1
            """).fetchone()
        if not request:
            return
        conn.execute("UPDATE leadgen.publish_login_requests SET status = 'opened' WHERE id = %s", (request["request_id"],))
        try:
            ok, message = login(conn, request)
        except Exception as error:
            ok, message = False, f"发布程序出错：{error}"
        conn.execute(
            "UPDATE leadgen.publish_login_requests SET status = %s, message = %s, finished_at = now() WHERE id = %s",
            ("succeeded" if ok else "failed", message, request["request_id"]))
        print(f"{request['account_name']}：{message}")


def heartbeat(conn: psycopg.Connection) -> None:
    conn.execute("UPDATE leadgen.publisher_heartbeat SET last_seen_at = now(), host_name = %s WHERE id = 1", (f"{os.environ.get('COMPUTERNAME', '')} · {VERSION}",))


def command_check() -> int:
    with connect() as conn:
        accounts = conn.execute(
            "SELECT id, platform, account_name, login_status FROM leadgen.publish_accounts WHERE purpose = 'publish' ORDER BY created_at").fetchall()
        for account in accounts:
            if account["platform"] not in SAU_PLATFORM:
                print(f"{account['account_name']}：{PLATFORM_LABEL[account['platform']]}还没有接入")
                continue
            print(f"{account['account_name']}：{'登录正常' if account_is_logged_in(conn, account) else '需要扫码登录'}")
    return 0


def claim_due_task(conn: psycopg.Connection) -> dict | None:
    """取一条到点的已确认任务并标为发布中。账号暂停、或 10 分钟内刚发过的先不取。"""
    with conn.transaction():
        task = conn.execute(
            """
            SELECT t.id, t.material_id, t.platform, t.title, t.body, t.topics, t.confirmed_by, m.topic,
                   a.id AS account_id, a.account_name, a.login_status
            FROM leadgen.publish_tasks t
            JOIN leadgen.materials m ON m.id = t.material_id
            JOIN leadgen.publish_accounts a ON a.id = t.account_id
            WHERE t.status = 'confirmed' AND t.scheduled_at <= now() AND NOT a.is_paused
              AND NOT EXISTS (
                SELECT 1 FROM leadgen.publish_tasks other
                WHERE other.account_id = t.account_id AND other.id <> t.id
                  AND (other.status = 'publishing'
                       OR COALESCE(other.published_at, other.publish_started_at) > now() - make_interval(mins => %s)))
            ORDER BY t.scheduled_at LIMIT 1 FOR UPDATE OF t SKIP LOCKED
            """, (MIN_GAP_MINUTES,)).fetchone()
        if task:
            conn.execute("UPDATE leadgen.publish_tasks SET status = 'publishing', publish_started_at = now(), updated_at = now() WHERE id = %s", (task["id"],))
        return task


def failure_screenshot(task: dict) -> tuple[Path, str]:
    """失败截图存在素材目录下，页面上可以直接点开看。返回磁盘路径和相对路径。"""
    relative = f"publish-failures/{task['id']}.png"
    path = MEDIA_DIR / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    return path, relative


def fail(conn: psycopg.Connection, task: dict, reason: str) -> None:
    path, relative = failure_screenshot(task)
    conn.execute(
        "UPDATE leadgen.publish_tasks SET status = 'failed', error_message = %s, error_screenshot = %s, updated_at = now() WHERE id = %s",
        (reason[:500], relative if path.exists() else None, task["id"]))
    notify(conn, f"{PLATFORM_LABEL[task['platform']]}发布失败", f"{task['topic']}：{reason[:200]}", f"/publishing.html?id={task['material_id']}", task["confirmed_by"])
    print(f"失败：{task['topic']}（{PLATFORM_LABEL[task['platform']]}）{reason}")


def publish(conn: psycopg.Connection, task: dict) -> None:
    platform = SAU_PLATFORM.get(task["platform"])
    if not platform:
        fail(conn, task, f"{PLATFORM_LABEL[task['platform']]}还没有接入发布程序")
        return
    account = {"id": task["account_id"], "platform": task["platform"], "login_status": task["login_status"]}
    if not account_is_logged_in(conn, account):
        fail(conn, task, "这个账号还没有登录，请先扫码" if task["login_status"] == "never" else "登录已过期，请重新扫码")
        return
    files = conn.execute(
        "SELECT kind, file_path FROM leadgen.material_files WHERE material_id = %s ORDER BY sort_order", (task["material_id"],)).fetchall()
    videos = [str(MEDIA_DIR / row["file_path"]) for row in files if row["kind"] == "video"]
    images = [str(MEDIA_DIR / row["file_path"]) for row in files if row["kind"] == "image"]
    missing = [path for path in videos + images if not Path(path).exists()]
    if missing:
        fail(conn, task, f"素材文件找不到：{Path(missing[0]).name}")
        return
    if not videos and task["platform"] in VIDEO_ONLY:
        fail(conn, task, f"{PLATFORM_LABEL[task['platform']]}只能发视频，这条素材里没有视频")
        return
    tags = ",".join(task["topics"] or [])
    title = task["title"] or task["topic"]
    if videos:
        args = [platform, "upload-video", "--account", str(task["account_id"]), "--file", videos[0], "--title", title, "--desc", task["body"], "--tags", tags]
    else:
        args = [platform, "upload-note", "--account", str(task["account_id"]), "--images", *images, "--title", title, "--note", task["body"], "--tags", tags]
    screenshot, _ = failure_screenshot(task)
    screenshot.unlink(missing_ok=True)
    try:
        returncode, output = run_upload(conn, task, args, screenshot)
    except subprocess.TimeoutExpired:
        fail(conn, task, "发布超过 15 分钟没有完成")
        return
    if returncode != 0:
        fail(conn, task, last_lines(output) or "发布程序异常退出")
        return
    conn.execute("UPDATE leadgen.publish_tasks SET status = 'published', published_at = now(), error_message = NULL, error_screenshot = NULL, updated_at = now() WHERE id = %s", (task["id"],))
    print(f"已发布：{task['topic']}（{PLATFORM_LABEL[task['platform']]}，{task['account_name']}）")
    # 马上读一遍，把帖子链接补上；读不到不算发布失败，下一次定时检查会再补。
    try:
        time.sleep(8)
        print(sync_account(conn, {"id": task["account_id"], "platform": task["platform"], "account_name": task["account_name"]}))
    except Exception as error:
        print(f"帖子链接暂时没读到：{error}")


def clean_link(link: str) -> str:
    """分享链接后面一长串追踪参数不要。"""
    return link.split("?")[0] if link else link


def sync_account(conn: psycopg.Connection, account: dict, trigger: str = "scheduled") -> str:
    """读一遍这个账号：给刚发布的内容补上帖子链接；把我们发布的帖子下的新评论收进互动收件箱。
    只读我们自己通过系统发布的帖子，账号上原有的其他作品不碰。返回一句结果说明。"""
    if account["platform"] == "xiaohongshu":
        return sync_xiaohongshu(conn, account)
    if account["platform"] != "douyin":
        return f"{PLATFORM_LABEL[account['platform']]}的评论和私信请在手机上查看"
    linked = conn.execute(
        "SELECT id, platform_post_id, title, post_url FROM leadgen.publish_tasks WHERE account_id = %s AND platform_post_id IS NOT NULL", (account["id"],)).fetchall()
    unlinked = conn.execute(
        """SELECT id, title FROM leadgen.publish_tasks WHERE account_id = %s AND status = 'published' AND platform_post_id IS NULL
           ORDER BY published_at DESC""", (account["id"],)).fetchall()
    data = asyncio.run(read_douyin(account["id"], {row["platform_post_id"] for row in linked}))
    if not data["logged_in"]:
        conn.execute("UPDATE leadgen.publish_accounts SET login_status = 'expired', updated_at = now() WHERE id = %s", (account["id"],))
        return "登录已过期，请重新扫码"

    # 平台上的作品标题是“标题 + 正文”的开头。按标题开头去对，已经对上的作品不重复用。
    taken = {row["platform_post_id"] for row in linked}
    newly_linked = 0
    for task in unlinked:
        match = next((item for item in data["items"] if item["item_id"] not in taken and task["title"] and item["title"].startswith(task["title"][:12])), None)
        if match:
            taken.add(match["item_id"])
            newly_linked += 1
            conn.execute("UPDATE leadgen.publish_tasks SET platform_post_id = %s, post_url = %s, updated_at = now() WHERE id = %s",
                         (match["item_id"], clean_link(match["link"]), task["id"]))
    if newly_linked:
        # 刚对上的帖子这一轮还没取评论，马上再读一次。
        linked = conn.execute(
            "SELECT id, platform_post_id, title, post_url FROM leadgen.publish_tasks WHERE account_id = %s AND platform_post_id IS NOT NULL", (account["id"],)).fetchall()
        data = asyncio.run(read_douyin(account["id"], {row["platform_post_id"] for row in linked}))

    by_post = {row["platform_post_id"]: row for row in linked}
    new_messages = 0
    for item in data["items"]:
        task = by_post.get(item["item_id"])
        if not task:
            continue
        conn.execute("UPDATE leadgen.publish_tasks SET stat_comments = %s, stats_at = now() WHERE id = %s", (item["comment_count"], task["id"]))
        for comment in data["comments"].get(item["item_id"], []):
            if not comment["sender_id"]:
                # 追评里没有和一级评论一致的用户编号：同一个账号下按昵称找这个人之前的评论，沿用那个编号，转线索时才会并到同一个客户。
                known = conn.execute(
                    "SELECT sender_platform_id FROM leadgen.interaction_messages WHERE account_id = %s AND sender_name = %s AND sender_platform_id NOT LIKE 'name:%%' ORDER BY created_at LIMIT 1",
                    (account["id"], comment["sender_name"])).fetchone()
                comment["sender_id"] = known["sender_platform_id"] if known else None
            inserted = conn.execute(
                """INSERT INTO leadgen.interaction_messages
                     (platform, kind, platform_message_id, account_id, publish_task_id, post_title, post_url,
                      sender_name, sender_platform_id, content, sent_at, source, thread_comment_text, thread_sender_name)
                   VALUES ('douyin', 'comment', %s, %s, %s, %s, %s, %s, %s, %s, %s, 'reader', %s, %s)
                   ON CONFLICT (platform, platform_message_id) DO NOTHING RETURNING id""",
                (comment["comment_id"], account["id"], task["id"], task["title"], task["post_url"],
                 comment["sender_name"], comment["sender_id"] or f"name:{comment['sender_name']}", comment["text"], comment["sent_at"],
                 comment.get("thread_comment_text"), comment.get("thread_sender_name"))).fetchone()
            new_messages += 1 if inserted else 0
    note = f"读了 {len(by_post)} 条我们发布的帖子，新评论 {new_messages} 条" + (f"，补上帖子链接 {newly_linked} 条" if newly_linked else "")
    if data.get("errors"):
        note += f"；{data['errors'][0]}"
    try:
        note += f"，{sync_stranger_messages(conn, account)}"
    except Exception as error:
        note += f"；私信没读到：{error}"[:120]
    return note


def sync_xiaohongshu(conn: psycopg.Connection, account: dict) -> str:
    """小红书：给我们发布的笔记补上链接，更新浏览、点赞等数字。账号上原有的其他笔记不保存。
    创作服务平台里看不到评论和私信的内容，只有评论数。"""
    data = asyncio.run(read_xiaohongshu_notes(account["id"]))
    if not data["logged_in"]:
        conn.execute("UPDATE leadgen.publish_accounts SET login_status = 'expired', updated_at = now() WHERE id = %s", (account["id"],))
        return "登录已过期，请重新扫码"
    tasks = conn.execute(
        "SELECT id, title, platform_post_id FROM leadgen.publish_tasks WHERE account_id = %s AND status = 'published' ORDER BY published_at DESC", (account["id"],)).fetchall()
    taken = {task["platform_post_id"] for task in tasks if task["platform_post_id"]}
    by_id = {item["item_id"]: item for item in data["items"]}
    linked = updated = 0
    for task in tasks:
        item = by_id.get(task["platform_post_id"]) if task["platform_post_id"] else None
        if not item and not task["platform_post_id"]:
            # 按标题去对，已经对上的笔记不重复用。
            item = next((note for note in data["items"] if note["item_id"] not in taken and task["title"] and note["title"].startswith(task["title"][:12])), None)
            if item:
                taken.add(item["item_id"])
                linked += 1
        if not item:
            continue
        updated += 1
        conn.execute(
            """UPDATE leadgen.publish_tasks SET platform_post_id = %s, post_url = COALESCE(post_url, %s), stat_views = %s, stat_likes = %s, stat_comments = %s,
                 stat_favorites = %s, stat_shares = %s, metrics_at = now(), stats_at = now(), updated_at = now() WHERE id = %s""",
            (item["item_id"], item["link"], item["views"], item["likes"], item["comments"], item["favorites"], item["shares"], task["id"]))
    note = f"读了 {updated} 条我们发布的笔记的数据" + (f"，补上链接 {linked} 条" if linked else "")
    return f"{note}；评论和私信请在手机上查看"


def sync_stranger_messages(conn: psycopg.Connection, account: dict) -> str:
    """把陌生人发来的私信收进互动收件箱。朋友私信和群消息不读。
    第一次读的时候，这一栏里已经有的会话只记下来、不收；之后新来的（或老会话里的新一句）才收。"""
    data = asyncio.run(read_stranger_messages(account["id"]))
    if not data["logged_in"]:
        return "私信页打不开"
    if data.get("errors"):
        return data["errors"][0]
    keyed = [(hashlib.sha1(f"{row['sender_name']}|{row['text']}".encode("utf-8")).hexdigest(), row) for row in data["rows"]]
    state = conn.execute("SELECT dm_baseline_at, dm_baseline_keys FROM leadgen.publish_accounts WHERE id = %s", (account["id"],)).fetchone()
    if state["dm_baseline_at"] is None:
        conn.execute("UPDATE leadgen.publish_accounts SET dm_baseline_at = now(), dm_baseline_keys = %s WHERE id = %s",
                     (Jsonb([key for key, _ in keyed]), account["id"]))
        return "陌生人私信从现在开始收"
    skipped = set(state["dm_baseline_keys"] or [])
    # 我们回过话以后，会话列表里显示的最近一句是我们自己说的，不是对方的新消息。
    ours = conn.execute(
        "SELECT sender_name, reply_text FROM leadgen.interaction_messages WHERE account_id = %s AND kind = 'direct_message' AND reply_text IS NOT NULL AND reply_status IN ('sent', 'manual', 'failed', 'queued')",
        (account["id"],)).fetchall()
    said = {(row["sender_name"], " ".join(row["reply_text"].split())[:20]) for row in ours}
    new_messages = 0
    for key, row in keyed:
        if key in skipped or (row["sender_name"], " ".join(row["text"].split())[:20]) in said:
            continue
        inserted = conn.execute(
            """INSERT INTO leadgen.interaction_messages
                 (platform, kind, platform_message_id, account_id, sender_name, sender_platform_id, content, sent_at, source)
               VALUES ('douyin', 'direct_message', %s, %s, %s, %s, %s, now(), 'reader')
               ON CONFLICT (platform, platform_message_id) DO NOTHING RETURNING id""",
            (f"dm:{key}", account["id"], row["sender_name"], f"name:{row['sender_name']}", row["text"])).fetchone()
        new_messages += 1 if inserted else 0
    return f"新私信 {new_messages} 条"


def process_inbox_checks(conn: psycopg.Connection) -> None:
    """“立即检查”的请求，加上每小时一次的定时检查（下一次的时间带 0–8 分钟随机偏移，避免固定节奏）。"""
    accounts = conn.execute(
        """
        SELECT a.id, a.platform, a.account_name, a.login_status,
               (SELECT r.id FROM leadgen.inbox_check_requests r WHERE r.account_id = a.id AND r.status = 'queued' ORDER BY r.created_at LIMIT 1) AS request_id,
               (a.next_inbox_check_at IS NULL OR a.next_inbox_check_at <= now()) AS due,
               (a.last_inbox_check_at IS NOT NULL AND a.last_inbox_check_at > now() - make_interval(mins => %s)) AS too_soon
        FROM leadgen.publish_accounts a
        WHERE a.purpose = 'publish' AND a.login_status = 'ok' AND a.platform = ANY(%s)
        """, (MIN_GAP_MINUTES, list(SAU_PLATFORM))).fetchall()
    for account in accounts:
        if not (account["request_id"] or account["due"]):
            continue
        if account["too_soon"]:
            if account["request_id"]:
                conn.execute("UPDATE leadgen.inbox_check_requests SET status = 'failed', error_message = '距上次检查不到 10 分钟，请稍后再试', finished_at = now() WHERE account_id = %s AND status = 'queued'", (account["id"],))
            continue
        conn.execute("UPDATE leadgen.inbox_check_requests SET status = 'running' WHERE account_id = %s AND status = 'queued'", (account["id"],))
        try:
            note, ok = sync_account(conn, account, "manual" if account["request_id"] else "scheduled"), True
        except Exception as error:
            note, ok = f"读取出错：{error}"[:300], False
        conn.execute(
            """UPDATE leadgen.publish_accounts SET last_inbox_check_at = now(), last_inbox_check_note = %s,
                 next_inbox_check_at = now() + interval '1 hour' + make_interval(secs => %s) WHERE id = %s""",
            (note, random.randint(0, 480), account["id"]))
        conn.execute(
            "UPDATE leadgen.inbox_check_requests SET status = %s, error_message = %s, finished_at = now() WHERE account_id = %s AND status = 'running'",
            ("completed" if ok else "failed", None if ok else note, account["id"]))
        print(f"{account['account_name']}：{note}")


def process_metrics(conn: psycopg.Connection) -> None:
    """已发布帖子的浏览、点赞等数据：每 6 小时读一次，发布满 30 天后不再读。一轮只读一个账号。"""
    account = conn.execute(
        """
        SELECT a.id, a.account_name, array_agg(t.platform_post_id) AS post_ids
        FROM leadgen.publish_accounts a JOIN leadgen.publish_tasks t ON t.account_id = a.id
        WHERE a.platform = 'douyin' AND a.login_status = 'ok' AND t.status = 'published' AND t.platform_post_id IS NOT NULL
          AND t.published_at > now() - make_interval(days => %s)
          AND (t.metrics_at IS NULL OR t.metrics_at < now() - make_interval(hours => %s))
        GROUP BY a.id, a.account_name LIMIT 1
        """, (METRICS_DAYS, METRICS_HOURS)).fetchone()
    if not account:
        return
    try:
        data = asyncio.run(read_douyin_metrics(account["id"], set(account["post_ids"])))
    except Exception as error:
        data = {"logged_in": True, "metrics": {}}
        print(f"{account['account_name']}：帖子数据没读到：{error}"[:200])
    for post_id, numbers in data["metrics"].items():
        conn.execute(
            """UPDATE leadgen.publish_tasks SET stat_views = %s, stat_likes = %s, stat_comments = %s, stat_favorites = %s, stat_shares = %s,
                 metrics_at = now(), stats_at = now() WHERE account_id = %s AND platform_post_id = %s""",
            (numbers["views"], numbers["likes"], numbers["comments"], numbers["favorites"], numbers["shares"], account["id"], post_id))
    # 这一轮没读到的也记上时间，6 小时后再试，免得每 20 秒重试一次。
    conn.execute("UPDATE leadgen.publish_tasks SET metrics_at = now() WHERE account_id = %s AND platform_post_id = ANY(%s) AND NOT (platform_post_id = ANY(%s))",
                 (account["id"], account["post_ids"], list(data["metrics"])))
    print(f"{account['account_name']}：读了 {len(data['metrics'])} 条帖子的数据")


def process_replies(conn: psycopg.Connection) -> None:
    """把确认过的回复发到平台上：评论回复，和陌生人私信的回复（人确认的，或固定话术自动回的）。
    一轮只发一条；发不出去就标明原因，让招商员复制到手机上回，不重试。私信两条之间至少隔几分钟。
    追评在评论管理页上不单独显示，回复落在它所在的那条一级评论下面（同一串对话里）。"""
    message = conn.execute(
        """
        SELECT i.id, i.kind, i.account_id, i.reply_text, i.post_title AS post_title, t.title AS task_title, a.account_name, i.sender_name AS who,
               COALESCE(i.thread_sender_name, i.sender_name) AS sender_name, COALESCE(i.thread_comment_text, i.content) AS content
        FROM leadgen.interaction_messages i
        JOIN leadgen.publish_accounts a ON a.id = i.account_id
        LEFT JOIN leadgen.publish_tasks t ON t.id = i.publish_task_id
        WHERE i.reply_status = 'queued' AND i.platform = 'douyin' AND a.login_status = 'ok' AND NOT a.is_paused
          AND ((i.kind = 'comment' AND t.id IS NOT NULL)
               OR (i.kind = 'direct_message' AND i.source = 'reader' AND NOT EXISTS (
                     SELECT 1 FROM leadgen.interaction_messages recent
                     WHERE recent.kind = 'direct_message' AND recent.account_id = i.account_id AND recent.replied_at > now() - make_interval(mins => %s))))
        ORDER BY i.reply_confirmed_at LIMIT 1
        """, (MESSAGE_GAP_MINUTES,)).fetchone()
    if not message:
        return
    try:
        if message["kind"] == "direct_message":
            asyncio.run(send_stranger_message(message["account_id"], message["who"], message["content"], message["reply_text"]))
        else:
            asyncio.run(send_comment_reply(message["account_id"], message["task_title"], message["sender_name"], message["content"], message["reply_text"]))
    except ReplyError as error:
        reason = str(error)
    except Exception as error:
        reason = f"发送时出错：{error}"[:200]
    else:
        conn.execute("UPDATE leadgen.interaction_messages SET reply_status = 'sent', replied_at = now(), reply_error = NULL, updated_at = now() WHERE id = %s", (message["id"],))
        print(f"已回复 {message['who']}（{message['account_name']}）")
        return
    conn.execute(
        "UPDATE leadgen.interaction_messages SET reply_status = 'failed', replied_at = CASE WHEN kind = 'direct_message' THEN now() ELSE replied_at END, reply_error = %s, updated_at = now() WHERE id = %s",
        (reason if "点了发送" in reason else f"{reason}。请复制回复内容到手机上回复", message["id"]))
    print(f"回复没有发出去：{message['who']}，{reason}")


def process_due(conn: psycopg.Connection) -> int:
    done = 0
    while task := claim_due_task(conn):
        try:
            publish(conn, task)
        except Exception as error:  # 任何意外都不能让任务停在“发布中”
            fail(conn, task, f"发布程序出错：{error}")
        done += 1
    return done


def recover_interrupted(conn: psycopg.Connection) -> None:
    """程序上次被中断时留在“发布中”的任务，不知道发没发出去，标为失败让人来核对，不自动重发。"""
    rows = conn.execute(
        """
        UPDATE leadgen.publish_tasks SET status = 'failed', updated_at = now(),
               error_message = '发布过程被中断，不确定是否已经发出。请到平台上看一眼，没发出再重新确认'
        WHERE status = 'publishing' AND publish_started_at < now() - interval '20 minutes' RETURNING id
        """).fetchall()
    if rows:
        print(f"有 {len(rows)} 条任务上次被中断，已标为失败等待核对。")


def main(argv: list[str]) -> int:
    command = argv[1] if len(argv) > 1 else "run"
    if command == "login" and len(argv) == 3:
        return command_login(argv[2])
    if command == "check":
        return command_check()
    if command == "metrics":
        # 只读一遍已发布帖子的数据，不发布任何内容。
        with connect() as conn:
            process_metrics(conn)
        return 0
    if command == "sync":
        # 只读一遍各账号（补帖子链接、收新评论），不发布任何内容。
        with connect() as conn:
            for account in conn.execute("SELECT id, platform, account_name, login_status FROM leadgen.publish_accounts WHERE purpose = 'publish' AND login_status = 'ok'").fetchall():
                print(f"{account['account_name']}：{sync_account(conn, account)}")
        return 0
    if command == "once":
        with connect() as conn:
            recover_interrupted(conn)
            print(f"处理了 {process_due(conn)} 条任务。")
            return 0
    if command == "run":
        sources = [HERE / "hz_publisher.py", HERE / "douyin_reader.py", HERE / "xiaohongshu_reader.py"]
        loaded = [path.stat().st_mtime for path in sources]
        waiting = False
        while True:
            # 开机自动启动时数据库可能还没起来，或者中途断开：等一会儿再连，不退出。
            try:
                conn = connect()
            except psycopg.OperationalError:
                if not waiting:
                    print("还连不上数据库（Docker 可能还没启动好），每 15 秒重试一次。")
                    waiting = True
                time.sleep(15)
                continue
            waiting = False
            try:
                with conn:
                    # 同一时间只允许一个发布程序在跑，避免同一条内容被发两次。
                    if not conn.execute("SELECT pg_try_advisory_lock(%s) AS locked", (RUN_LOCK_KEY,)).fetchone()["locked"]:
                        print("已经有一个发布程序在运行，这个窗口不需要，可以关掉。")
                        return 0
                    recover_interrupted(conn)
                    print(f"发布程序已启动（{VERSION}）。关掉这个窗口就停止发布。")
                    while True:
                        # 程序文件更新了就退出，由 start-publisher.cmd 立刻重新启动，用上新程序。
                        if [path.stat().st_mtime for path in sources] != loaded:
                            print("程序已更新，正在重新启动。")
                            return 75
                        heartbeat(conn)
                        process_login_requests(conn)
                        process_due(conn)
                        process_inbox_checks(conn)
                        process_replies(conn)
                        process_metrics(conn)
                        time.sleep(POLL_SECONDS)
            except psycopg.OperationalError:
                print("数据库连接断了，15 秒后重新连接。")
                time.sleep(15)
    print(__doc__)
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except KeyboardInterrupt:
        sys.exit(0)
