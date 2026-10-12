"""读“信用广州”上黄埔区、广州开发区的行政许可公示（政府公开页面，不用登录）。只读。

用法：谁刚在黄埔新办了食品经营等许可，说明这个品牌或商家正在本区开店。
只按正常方式打开区一级的列表页，取页面自己加载出来的最新一页（大约最近三天）；不用搜索框（搜索要验证码），
不去翻历史。只取经营主体名称、文书号、文书名称、日期，不取法定代表人和证件号。
必须走直连通道（见 direct_proxy.py）：这个网站拒绝国外地址。

  publisher\\.venv\\Scripts\\python.exe publisher\\gov_permits.py     试读一遍，只打印统计，不写数据库
"""
from __future__ import annotations

import asyncio
import json
import re

from patchright.async_api import async_playwright

LIST_PAGE = "https://credit1.gz.gov.cn/creditPublicNew/creditXkDepartNew?dwbh=440112"
LIST_API = "/creditSgsNew/xkb"
DETAIL_PAGE = "https://credit1.gz.gov.cn/sgs/sgsXkDetailNew?id="
BLOCKED = "黑名单"


def classify(doc_no: str, doc_title: str) -> tuple[str, str]:
    """从文书号和文书名称看出是哪一类许可、是新办还是变更注销。文书号例：埔食药监黄食营行许准字〔2026〕07669号。"""
    text = f"{doc_no} {doc_title}"
    category = "food" if "食营" in text or "食品经营" in text else "device" if "械营" in text or "医疗器械" in text else "drug" if "药营" in text or "药品" in text else "other"
    if "注销" in text or "注公" in text or "注决" in text:
        kind = "cancel"
    elif "变更" in text or "变决" in text or "变通" in text:
        kind = "change"
    elif "延" in doc_no or "延续" in text:
        kind = "renew"
    elif "准予" in doc_title or re.search(r"许(准字|决|通)", doc_no):
        kind = "new"
    else:
        kind = "other"
    return category, kind


async def read_permits() -> dict:
    """返回 {"ok": bool, "note": str, "rows": [{source_id, doc_no, doc_title, holder_name, kind, category, decided_on, source_url}]}。"""
    result = {"ok": False, "note": "", "rows": []}
    loaded: asyncio.Future = asyncio.get_event_loop().create_future()
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True, channel="chromium")
        page = await (await browser.new_context(viewport={"width": 1440, "height": 900}, locale="zh-CN")).new_page()

        async def capture(response):
            if LIST_API in response.url and not loaded.done():
                try:
                    loaded.set_result(await response.text())
                except Exception as error:
                    if not loaded.done():
                        loaded.set_exception(error)

        page.on("response", capture)
        try:
            await page.goto(LIST_PAGE, wait_until="domcontentloaded", timeout=60000)
            if BLOCKED in await page.title():
                result["note"] = "公示网站拒绝了这次访问（它不接受国外地址，要走直连通道）"
                return result
            try:
                data = json.loads(await asyncio.wait_for(loaded, timeout=40))
            except Exception:
                result["note"] = "公示网站的列表没有加载出来"
                return result
            for row in data.get("rows") or []:
                name = str(row.get("xkXdrMc") or "").strip()
                source_id = str(row.get("id") or "").strip()
                if not name or not source_id:
                    continue
                doc_no, doc_title = str(row.get("xkWsh") or "").strip(), str(row.get("xkXkws") or "").strip()
                category, kind = classify(doc_no, doc_title)
                decided = str(row.get("xkJdrq") or "")[:10]
                result["rows"].append({
                    "source_id": source_id, "doc_no": doc_no[:120], "doc_title": doc_title[:80], "holder_name": name[:120],
                    "kind": kind, "category": category, "decided_on": decided if re.fullmatch(r"\d{4}-\d{2}-\d{2}", decided) else None,
                    "source_url": DETAIL_PAGE + source_id,
                })
            result["ok"] = True
            result["note"] = f"读到 {len(result['rows'])} 条公示"
            return result
        finally:
            await browser.close()


if __name__ == "__main__":
    import collections
    import os
    import sys
    from pathlib import Path

    here = Path(__file__).parent.resolve()
    # 单独试读时自己接上直连通道（要先有通道在跑：发布程序开着，或另开窗口运行 direct_proxy.py serve）。
    os.environ.setdefault("HZ_DIRECT_PROXY", "http://127.0.0.1:7901")
    sys.path.insert(0, str(here / "hz_netpatch"))
    import importlib
    import sitecustomize
    importlib.reload(sitecustomize)
    outcome = asyncio.run(read_permits())
    print(outcome["ok"], outcome["note"])
    counts = collections.Counter((row["category"], row["kind"]) for row in outcome["rows"])
    for (category, kind), number in counts.most_common():
        print(f"  {category} / {kind}: {number}")
    for row in [item for item in outcome["rows"] if item["kind"] == "new" and item["category"] == "food"][:5]:
        print("  新办食品经营许可：", row["holder_name"], row["decided_on"])
