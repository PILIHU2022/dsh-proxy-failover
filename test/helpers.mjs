/**
 * Test helpers: local origins and a fake upstream HTTP proxy.
 *
 * A loopback target is deliberately refused by the relay, so tests use the
 * machine's first non-internal IPv4 address as the origin host. That also
 * exercises the relay's private-unicast allowance.
 */
import http from "node:http";
import net from "node:net";
import os from "node:os";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/** First non-internal IPv4 address, or undefined when the host has none. */
export function localAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && entry.internal === false) return entry.address;
    }
  }
  return undefined;
}

/** Start a TCP server that prefixes everything it receives with "echo:". */
export async function startEchoServer(host = "0.0.0.0") {
  const connections = { count: 0 };
  const server = net.createServer((socket) => {
    connections.count += 1;
    socket.on("error", () => {});
    socket.on("data", (chunk) => socket.write(Buffer.concat([Buffer.from("echo:"), chunk])));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  return {
    port: server.address().port,
    url: "http://" + host + ":" + server.address().port,
    connections,
    close: () => closeServer(server),
  };
}

/** Start a small HTTP origin. */
export async function startHttpOrigin(options = {}) {
  const body = options.body ?? "origin-ok";
  const sockets = new Set();
  const requests = { count: 0 };
  const server = http.createServer((req, res) => {
    requests.count += 1;
    res.writeHead(200, { "content-type": "text/plain", "x-origin": "local" });
    res.end(body);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  return {
    port: server.address().port,
    url: "http://" + localAddress() + ":" + server.address().port,
    requests,
    close: () => closeServer(server, sockets),
  };
}

/**
 * Start a fake upstream HTTP proxy that forwards CONNECT and absolute-form
 * requests. `stop()` closes the listener and drops live sockets, which is how
 * a test simulates the user closing Mihomo.
 */
export async function startForwardProxy(options = {}) {
  const stats = { connects: 0, requests: 0 };
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    stats.requests += 1;
    if (options.refuseHttp === true) {
      res.writeHead(403);
      res.end("refused");
      return;
    }
    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const headers = { ...req.headers, host: target.host };
    delete headers["proxy-connection"];
    const out = http.request(
      {
        host: target.hostname,
        port: target.port === "" ? 80 : Number(target.port),
        method: req.method,
        path: target.pathname + target.search,
        headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    out.on("error", () => {
      try {
        res.writeHead(502);
        res.end();
      } catch {
        /* response already gone */
      }
    });
    req.pipe(out);
  });

  server.on("connect", (req, clientSocket, head) => {
    stats.connects += 1;
    clientSocket.on("error", () => {});
    if (options.refuseConnect === true) {
      clientSocket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const parsed = parseAuthority(req.url);
    if (parsed === undefined) {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const upstream = net.connect({ host: parsed.host, port: parsed.port }, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head !== undefined && head.length > 0) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    upstream.on("error", () => {
      try {
        clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      } catch {
        /* client already gone */
      }
    });
    sockets.add(upstream);
    sockets.add(clientSocket);
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });

  const port = server.address().port;
  return {
    port,
    url: "http://127.0.0.1:" + port,
    stats,
    close: () => closeServer(server, sockets),
    stop: () => closeServer(server, sockets),
  };
}

/** Parse "host:port" including bracketed IPv6. */
export function parseAuthority(value) {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = new URL("http://" + value);
    if (parsed.hostname === "") return undefined;
    return {
      host: parsed.hostname.replace(/^\[|\]$/g, ""),
      port: parsed.port === "" ? 80 : Number(parsed.port),
    };
  } catch {
    return undefined;
  }
}

/** Open a CONNECT tunnel through an HTTP proxy. Resolves with the raw socket. */
export function openTunnel(proxyUrl, authority, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(proxyUrl);
    const socket = net.connect({ host: parsed.hostname, port: Number(parsed.port) });
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      if (error !== undefined) {
        socket.destroy();
        reject(error);
        return;
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("CONNECT timed out")), timeoutMs);
    const onError = (error) => finish(error);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = buffer.subarray(0, end).toString("latin1");
      const tail = buffer.subarray(end + 4);
      const status = Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(head)?.[1] ?? 0);
      finish(undefined, { socket, status, head, tail });
    };
    socket.on("connect", () => {
      socket.write("CONNECT " + authority + " HTTP/1.1\r\nHost: " + authority + "\r\n\r\n");
    });
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

/** Send one absolute-form HTTP request through an HTTP proxy. */
export function proxiedGet(proxyUrl, absoluteUrl, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(proxyUrl);
    const req = http.request(
      {
        host: parsed.hostname,
        port: Number(parsed.port),
        method: "GET",
        path: absoluteUrl,
        headers: { host: new URL(absoluteUrl).host },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    req.end();
  });
}

/** Resolve the harness's own copy of @deepseek-ai/dsh-http-proxy, or undefined. */
export async function loadHarnessProxy() {
  const roots = [];
  try {
    const bin = execFileSync("sh", ["-c", "command -v dsh"], { encoding: "utf8" }).trim();
    if (bin !== "") {
      const real = fs.realpathSync(bin);
      roots.push(path.dirname(path.dirname(real)));
    }
  } catch {
    /* dsh is not on PATH */
  }
  roots.push("/usr/lib/node_modules/@deepseek-ai/dsh", "/usr/local/lib/node_modules/@deepseek-ai/dsh");
  for (const root of roots) {
    try {
      const resolved = createRequire(path.join(root, "package.json")).resolve("@deepseek-ai/dsh-http-proxy");
      return await import(pathToFileURL(resolved).href);
    } catch {
      /* try the next root */
    }
  }
  return undefined;
}

function closeServer(server, sockets) {
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
    for (const socket of sockets ?? []) {
      try {
        socket.destroy();
      } catch {
        /* best effort */
      }
    }
  });
}
