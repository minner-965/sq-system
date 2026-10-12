"""直连通道：让发布程序打开的浏览器走这台电脑自己的宽带出去，不经过电脑上的代理软件。

为什么要有它：这台电脑上的代理软件把所有流量（包括国内网站）都送到国外再出去，抖音、小红书、视频号和政府网站
看到的是“一个国外机房的地址在操作”，于是频繁要验证、把账号登出、直接拒绝访问。改代理软件的设置会影响电脑上
别的程序，所以不去动它；这里只在本机开一个小通道（只听 127.0.0.1），把经过它的连接绑定到真实网卡上发出去，
域名也通过真实网卡去查。只有明确指到这个通道的程序才会走它，其余一切照旧。

  publisher\\.venv\\Scripts\\python.exe publisher\\direct_proxy.py check    看真实网卡是哪块、从它出去是什么地址
  publisher\\.venv\\Scripts\\python.exe publisher\\direct_proxy.py serve    单独运行通道（发布程序平时会自己带起来）
"""
from __future__ import annotations

import asyncio
import ipaddress
import os
import random
import socket
import struct
import subprocess
import sys
import time

HOST = "127.0.0.1"
PORT = int(os.environ.get("HZ_DIRECT_PORT") or 7901)
DNS_SERVERS = ("223.5.5.5", "119.29.29.29")
# 代理软件的虚拟网卡用的地址段；从这里出去的不是直连。
VIRTUAL_NET = ipaddress.ip_network("198.18.0.0/15")
_dns_cache: dict[str, tuple[float, list[str]]] = {}


def real_adapter_ip() -> str | None:
    """这台电脑真实上网那块网卡的地址。可以在 .env 里用 HZ_DIRECT_BIND_IP 指定；否则从路由表里找默认出口。"""
    configured = (os.environ.get("HZ_DIRECT_BIND_IP") or "").strip()
    if configured:
        return configured
    try:
        output = subprocess.run(["route", "print", "-4"], capture_output=True, timeout=10, stdin=subprocess.DEVNULL).stdout.decode("gbk", "replace")
    except Exception:
        return None
    candidates = []
    for line in output.splitlines():
        parts = line.split()
        # 默认路由：0.0.0.0  0.0.0.0  网关  接口地址  跃点数
        if len(parts) == 5 and parts[0] == "0.0.0.0" and parts[1] == "0.0.0.0":
            try:
                gateway, interface, metric = ipaddress.ip_address(parts[2]), ipaddress.ip_address(parts[3]), int(parts[4])
            except ValueError:
                continue
            if gateway in VIRTUAL_NET or interface in VIRTUAL_NET or not interface.is_private:
                continue
            candidates.append((metric, str(interface)))
    return sorted(candidates)[0][1] if candidates else None


def _query(name: str, server: str, bind_ip: str) -> list[str]:
    """用真实网卡向公共域名服务器查一个域名（代理软件会改写经过它的域名查询，所以不能用系统的）。"""
    packet = struct.pack(">HHHHHH", random.randint(0, 65535), 0x0100, 1, 0, 0, 0)
    packet += b"".join(bytes([len(label)]) + label.encode("idna") for label in name.rstrip(".").split(".")) + b"\0" + struct.pack(">HH", 1, 1)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.bind((bind_ip, 0))
        sock.settimeout(4)
        sock.sendto(packet, (server, 53))
        data, _ = sock.recvfrom(2048)
    position = 12
    while data[position]:
        position += data[position] + 1
    position += 5
    addresses = []
    for _ in range(struct.unpack(">H", data[6:8])[0]):
        if data[position] & 0xC0:
            position += 2
        else:
            while data[position]:
                position += data[position] + 1
            position += 1
        record_type, _cls, _ttl, length = struct.unpack(">HHIH", data[position:position + 10])
        position += 10
        if record_type == 1 and length == 4:
            addresses.append(".".join(map(str, data[position:position + 4])))
        position += length
    return addresses


def resolve(name: str, bind_ip: str) -> list[str]:
    try:
        ipaddress.ip_address(name)
        return [name]
    except ValueError:
        pass
    cached = _dns_cache.get(name)
    if cached and cached[0] > time.monotonic():
        return cached[1]
    for server in DNS_SERVERS:
        try:
            addresses = _query(name, server, bind_ip)
        except Exception:
            continue
        if addresses:
            _dns_cache[name] = (time.monotonic() + 300, addresses)
            return addresses
    raise OSError(f"查不到 {name} 的地址")


async def _pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except Exception:
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def _open(host: str, port: int, bind_ip: str):
    addresses = await asyncio.to_thread(resolve, host, bind_ip)
    last_error: Exception | None = None
    for address in addresses[:3]:
        try:
            return await asyncio.wait_for(asyncio.open_connection(address, port, local_addr=(bind_ip, 0)), timeout=15)
        except Exception as error:
            last_error = error
    raise last_error or OSError("连不上")


async def _handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, bind_ip: str) -> None:
    try:
        head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=20)
        request_line, _, rest = head.partition(b"\r\n")
        method, target, _version = request_line.decode("latin-1").split(" ", 2)
        if method.upper() == "CONNECT":
            host, _, port = target.rpartition(":")
            upstream_reader, upstream_writer = await _open(host.strip("[]"), int(port or 443), bind_ip)
            writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
            await writer.drain()
        else:
            # 普通的 http:// 请求：把绝对地址改回路径再转发。
            scheme, _, remainder = target.partition("://")
            hostport, _, path = remainder.partition("/")
            host, _, port = hostport.partition(":")
            upstream_reader, upstream_writer = await _open(host, int(port or 80), bind_ip)
            upstream_writer.write(f"{method} /{path} HTTP/1.1\r\n".encode("latin-1") + rest)
            await upstream_writer.drain()
        await asyncio.gather(_pipe(reader, upstream_writer), _pipe(upstream_reader, writer))
    except Exception:
        try:
            writer.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
            await writer.drain()
        except Exception:
            pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def serve(bind_ip: str, port: int = PORT) -> None:
    server = await asyncio.start_server(lambda reader, writer: _handle(reader, writer, bind_ip), HOST, port)
    async with server:
        await server.serve_forever()


def egress(bind_ip: str) -> str:
    """从真实网卡出去，对方看到的是什么地址。返回查 IP 网站的一句话。"""
    import ssl
    host = "myip.ipip.net"
    raw = socket.socket()
    raw.bind((bind_ip, 0))
    raw.settimeout(10)
    raw.connect((resolve(host, bind_ip)[0], 443))
    with ssl.create_default_context().wrap_socket(raw, server_hostname=host) as tls:
        tls.sendall(f"GET / HTTP/1.1\r\nHost: {host}\r\nUser-Agent: hz-publisher\r\nConnection: close\r\n\r\n".encode())
        body = b""
        while chunk := tls.recv(4096):
            body += chunk
    return body.decode("utf-8", "replace").split("\r\n\r\n", 1)[-1].strip()[:120]


def is_domestic(text: str) -> bool:
    return "中国" in text and not any(place in text for place in ("香港", "澳门", "台湾"))


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else "check"
    adapter = real_adapter_ip()
    if not adapter:
        print("没有找到真实上网的网卡。可以在 .env 里用 HZ_DIRECT_BIND_IP 写明它的地址。")
        sys.exit(1)
    if command == "check":
        seen = egress(adapter)
        print(f"真实网卡地址：{adapter}")
        print(f"从它出去，对方看到的是：{seen}")
        print("可以用作直连通道。" if is_domestic(seen) else "这不是国内地址，直连通道不会启用。")
    elif command == "serve":
        print(f"直连通道已启动：{HOST}:{PORT}，经 {adapter} 出去。")
        asyncio.run(serve(adapter))
    else:
        print(__doc__)
