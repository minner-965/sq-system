"""读广东省公共资源交易平台上黄埔区工程建设的“中标结果”公告（政府公开平台，不用登录）。只读。

用法：谁刚中标了黄埔的工程。施工单位要进场设项目部，需要住宿、用餐、临时办公。
按平台页面自己的方式取：先打开交易公开页，再取黄埔区最新的一页中标结果，对没见过的逐条取公告详情里的
“中标人名称”“中标金额”“标段名称”。每次最多看 20 条，不翻历史。必须走直连通道（见 direct_proxy.py）。

  publisher\\.venv\\Scripts\\python.exe publisher\\gov_tenders.py     试读一遍，只打印，不写数据库
"""
from __future__ import annotations

import asyncio
import json
import re
from urllib.parse import quote

from patchright.async_api import async_playwright

ENTRY_PAGE = "https://ygp.gdzwfw.gov.cn/#/44/jygg"
LIST_API = "/ggzy-portal/search/v2/items"
NODE_API = "/ggzy-portal/center/apis/trading-notice/new/nodeList"
DETAIL_API = "/ggzy-portal/center/apis/trading-notice/new/detail"
DISTRICT = "440112"          # 黄埔区
AWARD_STEPS = "2C52,3C52,513"  # 平台上“中标结果”这一步对应的环节编号
PAGE_SIZE = 20


def work_kind(title: str) -> str:
    """从标题看出是哪一类：施工、总承包要进场；监理少量人驻场；其余（设计、勘察、检测、采购、服务）基本不驻场。"""
    head = title.split("中标信息")[0]
    if "监理" in head:
        return "supervision"
    if re.search(r"施工|总承包|EPC", head):
        return "construction"
    # “××工程”结尾、又不是采购检测服务一类的，是分包的工程（比如建筑智能化工程），同样要进场。
    if head.endswith("工程") and not re.search(r"采购|检测|监测|勘察|设计|服务|咨询|造价", head):
        return "construction"
    return "other"


def _fields(data) -> dict[str, str]:
    """公告详情是一层层的表格；把里面“名称: 值”的格子摊平。"""
    found: dict[str, str] = {}

    def walk(node):
        if isinstance(node, dict):
            label = node.get("label") or node.get("name") or node.get("key") or node.get("title")
            value = node.get("value") if "value" in node else node.get("content")
            if isinstance(label, str) and isinstance(value, (str, int, float)) and str(value).strip():
                found.setdefault(label.strip(), str(value).strip())
            for child in node.values():
                walk(child)
        elif isinstance(node, list):
            for child in node:
                walk(child)

    walk(data)
    return found


async def read_tenders(known_ids: set[str] | None = None) -> dict:
    """返回 {"ok": bool, "note": str, "rows": [...]}；known_ids 里的公告不再取详情。"""
    known_ids = known_ids or set()
    result = {"ok": False, "note": "", "rows": []}
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True, channel="chromium")
        page = await (await browser.new_context(viewport={"width": 1440, "height": 900}, locale="zh-CN")).new_page()
        try:
            await page.goto(ENTRY_PAGE, wait_until="domcontentloaded", timeout=60000)
            await page.wait_for_timeout(5000)
            listing = await page.evaluate(
                """async ([path, body]) => {
                    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                    try { return await response.json(); } catch { return { errcode: -1 }; }
                }""",
                [LIST_API, {"type": "trading-type", "openConvert": False, "keyword": "", "siteCode": DISTRICT, "secondType": "A", "tradingProcess": AWARD_STEPS,
                            "thirdType": "[]", "projectType": "", "publishStartTime": "", "publishEndTime": "", "pageNo": 1, "pageSize": PAGE_SIZE}])
            if listing.get("errcode") != 0:
                result["note"] = "交易平台的中标结果列表没有取到"
                return result

            async def get(path: str) -> dict:
                return await page.evaluate("async (path) => { try { return await (await fetch(path)).json(); } catch { return {}; } }", path)

            for row in (listing.get("data") or {}).get("pageData") or []:
                notice_id = str(row.get("noticeId") or "")
                title = str(row.get("noticeTitle") or "").strip()
                if not notice_id or not title or notice_id in known_ids:
                    continue
                query = f"siteCode={row.get('regionCode')}&tradingType=A&bizCode={row.get('tradingProcess')}&projectCode={row.get('projectCode')}"
                nodes = (await get(f"{NODE_API}?{query}&classify={row.get('projectType') or ''}")).get("data") or []
                node = next((item for item in nodes if item.get("selectedBizCode") == row.get("tradingProcess")), None)
                fields: dict[str, str] = {}
                if node:
                    detail = await get(f"{DETAIL_API}?nodeId={node['nodeId']}&version={row.get('edition')}&tradingType=A&noticeId={quote(notice_id)}&{query}")
                    fields = _fields(detail.get("data") or {})
                    await page.wait_for_timeout(800)
                amount = fields.get("中标金额") or fields.get("中标价") or ""
                stamp = str(row.get("publishDate") or "")
                result["rows"].append({
                    "notice_id": notice_id,
                    "title": title[:300],
                    "section_name": (fields.get("标段（包）名称") or fields.get("标段(包)名称") or "")[:300] or None,
                    "project_type": str(row.get("projectTypeName") or "")[:40] or None,
                    "owner_name": str(row.get("projectOwner") or "").strip()[:120] or None,
                    "winner_name": (fields.get("中标人名称") or fields.get("中标单位名称") or "")[:160] or None,
                    "amount": float(amount) if re.fullmatch(r"\d+(\.\d+)?", amount) else None,
                    "work_kind": work_kind(title),
                    "published_at": f"{stamp[:4]}-{stamp[4:6]}-{stamp[6:8]} {stamp[8:10]}:{stamp[10:12]}:{stamp[12:14]}+08" if re.fullmatch(r"\d{14}", stamp) else None,
                    "source_url": (f"https://ygp.gdzwfw.gov.cn/#/44/new/jygg/{row.get('edition')}/A?noticeId={quote(notice_id)}&projectCode={row.get('projectCode')}"
                                   f"&bizCode={row.get('tradingProcess')}&siteCode={row.get('regionCode')}&publishDate={stamp}"),
                })
            result["ok"] = True
            result["note"] = f"看了黄埔区最新 {PAGE_SIZE} 条中标结果，新的 {len(result['rows'])} 条"
            return result
        finally:
            await browser.close()


if __name__ == "__main__":
    import os
    import sys
    from pathlib import Path

    here = Path(__file__).parent.resolve()
    os.environ.setdefault("HZ_DIRECT_PROXY", "http://127.0.0.1:7901")
    sys.path.insert(0, str(here / "hz_netpatch"))
    import importlib
    import sitecustomize
    importlib.reload(sitecustomize)
    outcome = asyncio.run(read_tenders())
    print(outcome["ok"], outcome["note"])
    for item in outcome["rows"][:20]:
        print(f"  {str(item['published_at'])[:10]} | {item['work_kind']:<12} | {item['winner_name']} | {item['amount']} | {item['title'][:44]}")
