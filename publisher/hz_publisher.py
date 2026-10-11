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

import os
import subprocess
import sys
import time
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

HERE = Path(__file__).parent.resolve()
ROOT = HERE.parent
VENDOR = HERE / "vendor" / "social-auto-upload"
MEDIA_DIR = Path(os.environ.get("HZ_MEDIA_DIR") or ROOT / "data" / "media")
POLL_SECONDS = 20
MIN_GAP_MINUTES = 10
UPLOAD_TIMEOUT_SECONDS = 15 * 60
# 发布组件里各平台的名字。没列出的平台还没有接入。
SAU_PLATFORM = {"douyin": "douyin"}
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


def sau(*args: str, timeout: int = 120, capture: bool = True) -> subprocess.CompletedProcess:
    """调用发布组件的命令行。登录状态文件按账号编号命名，放在 publisher/state/cookies。"""
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
    return subprocess.run(
        [sys.executable, "sau_cli.py", *args], cwd=VENDOR, env=env, timeout=timeout,
        capture_output=capture, text=True, encoding="utf-8", errors="replace",
    )


def last_lines(text: str, limit: int = 300) -> str:
    lines = [line.strip() for line in (text or "").splitlines() if line.strip()]
    return " / ".join(lines[-3:])[-limit:]


def notify(conn: psycopg.Connection, title: str, body: str, link: str, user_id=None) -> None:
    conn.execute(
        "INSERT INTO leadgen.notifications (recipient_role, kind, title, body, link) VALUES ('admin', 'publishing', %s, %s, %s)",
        (title, body, link))
    if user_id:
        conn.execute(
            "INSERT INTO leadgen.notifications (recipient_user_id, kind, title, body, link) VALUES (%s, 'publishing', %s, %s, %s)",
            (user_id, title, body, link))


def account_is_logged_in(conn: psycopg.Connection, account: dict) -> bool:
    result = sau(SAU_PLATFORM[account["platform"]], "check", "--account", str(account["id"]))
    valid = result.returncode == 0 and "valid" in result.stdout and "invalid" not in result.stdout
    status = "ok" if valid else ("never" if account["login_status"] == "never" else "expired")
    conn.execute("UPDATE leadgen.publish_accounts SET login_status = %s, updated_at = now() WHERE id = %s", (status, account["id"]))
    return valid


def command_login(account_name: str) -> int:
    with connect() as conn:
        account = conn.execute(
            "SELECT id, platform, account_name, login_status FROM leadgen.publish_accounts WHERE account_name = %s", (account_name,)).fetchone()
        if not account:
            print(f"没有找到发布账号“{account_name}”，请先在“内容发布”页添加。")
            return 1
        if account["platform"] not in SAU_PLATFORM:
            print(f"{PLATFORM_LABEL[account['platform']]}还没有接入。")
            return 1
        print(f"即将弹出浏览器窗口，请用{PLATFORM_LABEL[account['platform']]} App 扫码登录“{account_name}”。")
        result = sau(SAU_PLATFORM[account["platform"]], "login", "--account", str(account["id"]), "--headed", timeout=600, capture=False)
        if result.returncode != 0 or not account_is_logged_in(conn, account):
            print("登录没有成功，可以重新运行这条命令再试。")
            return 1
        conn.execute("UPDATE leadgen.publish_accounts SET login_status = 'ok', last_login_at = now(), updated_at = now() WHERE id = %s", (account["id"],))
        print("登录成功。")
        return 0


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


def fail(conn: psycopg.Connection, task: dict, reason: str) -> None:
    conn.execute("UPDATE leadgen.publish_tasks SET status = 'failed', error_message = %s, updated_at = now() WHERE id = %s", (reason[:500], task["id"]))
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
    tags = ",".join(task["topics"] or [])
    title = task["title"] or task["topic"]
    if videos:
        args = [platform, "upload-video", "--account", str(task["account_id"]), "--file", videos[0], "--title", title, "--desc", task["body"], "--tags", tags]
    else:
        args = [platform, "upload-note", "--account", str(task["account_id"]), "--images", *images, "--title", title, "--note", task["body"], "--tags", tags]
    try:
        result = sau(*args, timeout=UPLOAD_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        fail(conn, task, "发布超过 15 分钟没有完成")
        return
    if result.returncode != 0:
        fail(conn, task, last_lines(result.stderr or result.stdout) or "发布程序异常退出")
        return
    conn.execute("UPDATE leadgen.publish_tasks SET status = 'published', published_at = now(), error_message = NULL, updated_at = now() WHERE id = %s", (task["id"],))
    print(f"已发布：{task['topic']}（{PLATFORM_LABEL[task['platform']]}，{task['account_name']}）")


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
    if command in ("once", "run"):
        with connect() as conn:
            recover_interrupted(conn)
            if command == "once":
                print(f"处理了 {process_due(conn)} 条任务。")
                return 0
            print("发布程序已启动，按 Ctrl+C 停止。")
            while True:
                process_due(conn)
                time.sleep(POLL_SECONDS)
    print(__doc__)
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except KeyboardInterrupt:
        sys.exit(0)
