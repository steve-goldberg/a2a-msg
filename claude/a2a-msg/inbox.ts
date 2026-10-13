// The a2a-msg inbox: HTTP/1.1 on this agent's Unix socket (SPEC.md §3.4). Node only.
// Pi calls listen() in-process. Claude runs: node inbox.ts <sock> <kind> <pane> [owner].
// The stable pane paths are aliases; each generation owns its actual listener and record.
import { execFileSync } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { GENERATION, makeRecord, MAX_BODY, parseInbound, parseRecord, pong, safe, workspaceOf, type Kind, type Message, type PeerRecord } from "./hooks/core.ts"

export type Inbox = {
  close(): Promise<void>
  setSession(session: string): void
  /** Also run every second: restore lost aliases/record, or retire a superseded generation. */
  repair(): Promise<void>
}
type Options = { record?: string; session?: string; owner?: string; onError?: (err: Error) => void }

function link(target: string, alias: string) {
  const tmp = `${alias}.${randomUUID()}.tmp`
  try {
    fs.symlinkSync(path.basename(target), tmp)
    fs.renameSync(tmp, alias)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

function target(alias: string): string | undefined {
  try { return fs.readlinkSync(alias) } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined
    // A legacy regular socket/record belongs to another generation too.
    if ((err as NodeJS.ErrnoException).code === "EINVAL") return ""
    throw err
  }
}

/** A dead OS owner cannot bind again. Delete only its generation's private targets, never aliases. */
export function reap(r: PeerRecord): boolean {
  if (!r.pid || !r.generation || !GENERATION.test(r.generation)) return false
  try { process.kill(r.pid, 0); return false } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") return false // EPERM is alive too
  }
  const actual = `${path.dirname(r.sock)}/${r.generation}`
  fs.rmSync(actual, { force: true })
  fs.rmSync(`${actual}-record`, { force: true })
  return true
}

/** Listens via `sock` (folder 0700, socket 0600); deliver runs before each valid message's 200. */
export async function listen(sock: string, kind: Kind, pane: string, deliver: (m: Message) => void, options: Options = {}): Promise<Inbox> {
  const dir = path.dirname(sock)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
  if (options.record) {
    let previous: PeerRecord | undefined
    try { previous = parseRecord(fs.readFileSync(options.record, "utf8"), workspaceOf(pane), path.dirname(dir)) } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    }
    if (previous) reap(previous)
  }
  // Shorter than the canonical pane.sock basename, so the existing path-length bound still holds.
  const actual = `${dir}/.${randomBytes(6).toString("base64url")}`
  const record = `${actual}-record`
  const workspace = workspaceOf(pane)
  let session = options.session ?? ""
  let stopped = false
  let timer: ReturnType<typeof setInterval> | undefined
  let repairing: Promise<void> | undefined
  let closing: Promise<void> | undefined
  let recordCreated = false
  let server: http.Server | undefined

  const owned = () => target(sock) === path.basename(actual)
  const writeRecord = () => {
    if (!options.record) return
    const tmp = `${record}.tmp`
    try {
      fs.writeFileSync(tmp, JSON.stringify({ ...makeRecord(kind, { pane, workspace }, session, sock), pid: process.pid, generation: path.basename(actual) }), { mode: 0o600 })
      fs.renameSync(tmp, record)
      recordCreated = true
      link(record, options.record)
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  }
  const closeServer = (s: http.Server | undefined) => new Promise<void>((resolve, reject) => {
    if (!s) return resolve()
    s.close(err => err && (err as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? reject(err) : resolve())
    s.closeAllConnections()
  })
  const close = (): Promise<void> => {
    if (closing) return closing
    stopped = true
    clearInterval(timer)
    // Never unlink the pane aliases: another generation may already own them. Removing only
    // our targets leaves harmless dangling aliases (existsSync=false) until the next start.
    closing = (async () => {
      await closeServer(server)
      if (recordCreated) fs.rmSync(record, { force: true })
    })()
    return closing
  }
  const setSession = (name: string) => {
    if (stopped || !owned()) throw new Error("inbox was superseded or stopped")
    session = name
    writeRecord()
  }
  const bind = () => new Promise<http.Server>((resolve, reject) => {
    const s = http.createServer((req, res) => {
      const reply = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(typeof body === "string" ? body : JSON.stringify(body))
      if (req.method === "GET" && req.url === "/ping") return reply(200, pong(kind, pane))
      const control = options.owner && (req.url === "/session" || req.url === "/close")
      if (req.method !== "POST" || (req.url !== "/msg" && !control)) return reply(404, { ok: false, error: "not found" })
      const chunks: Buffer[] = []
      let size = 0
      req.on("data", (chunk: Buffer) => { size += chunk.length; if (size <= MAX_BODY) chunks.push(chunk) })
      req.on("end", () => {
        if (size > MAX_BODY) return reply(413, { ok: false, error: `body over ${MAX_BODY} bytes` })
        const raw = Buffer.concat(chunks).toString("utf8")
        if (control) {
          let body: any
          try { body = JSON.parse(raw) } catch { return reply(400, { ok: false, error: "invalid JSON" }) }
          if (body?.owner !== options.owner || !owned()) return reply(403, { ok: false, error: "not this inbox's owner" })
          if (req.url === "/session") {
            if (typeof body.session !== "string") return reply(400, { ok: false, error: "session must be text" })
            try { setSession(body.session) } catch (err) { return reply(500, { ok: false, error: (err as Error).message }) }
          } else {
            // Let the acknowledgement flush before closing its connection.
            res.once("finish", () => { void close().catch(report) })
          }
          return reply(200, { ok: true })
        }
        const r = parseInbound(raw, workspace)
        if (r.status !== 200) return reply(r.status, { ok: false, error: r.error })
        deliver(r.message)
        reply(200, { ok: true })
      })
    })
    s.once("error", reject)
    s.listen(actual, () => {
      try { fs.chmodSync(actual, 0o600); resolve(s) } catch (err) { s.close(); reject(err) }
    })
  })
  const repair = (): Promise<void> => {
    if (stopped) return closing ?? Promise.resolve()
    if (repairing) return repairing
    repairing = (async () => {
      const current = target(sock)
      if (current !== undefined && current !== path.basename(actual)) { await close(); return }
      if (!fs.existsSync(actual)) {
        await closeServer(server)
        if (stopped) return
        server = await bind()
        if (stopped) { await closeServer(server); return }
      }
      if (!owned()) link(actual, sock)
      if (options.record && (!fs.existsSync(record) || target(options.record) !== path.basename(record))) writeRecord()
    })().finally(() => { repairing = undefined })
    return repairing
  }
  function report(err: Error) {
    void close().catch(() => {})
    if (options.onError) options.onError(err)
    else process.stderr.write(`a2a-msg inbox is off: ${err.message}\n`)
  }
  try {
    server = await bind()
    link(actual, sock)
    writeRecord()
    timer = setInterval(() => { void repair().catch(report) }, 1000)
    timer.unref()
    return { close, setSession, repair }
  } catch (err) {
    await close()
    throw err
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args[0] === "--identity") {
    // ps reads the parent's launch environment, not later env.set additions. This lets an
    // existing UUID owner migrate after session-scoped state was lost, without admitting
    // a child that inherited that UUID. Never return or log the environment itself.
    try {
      const launch = execFileSync("ps", ["eww", "-p", String(process.ppid), "-o", "command="], { encoding: "utf8" })
      if (!/(?:^|\s)PATH=/.test(launch)) throw new Error("parent launch environment is unavailable")
      process.stdout.write(JSON.stringify({ pid: process.ppid, inheritedOwner: /(?:^|\s)A2A_MSG_OWNER=/.test(launch) }) + "\n")
    } catch {
      process.stderr.write("a2a-msg: could not establish the host process identity\n")
      process.exitCode = 1
    }
    process.exit(process.exitCode ?? 0)
  }
  if (args[0] === "--reap") {
    const [, root, workspace, snapshot] = args
    const r = root && workspace && snapshot ? parseRecord(snapshot, workspace, root) : undefined
    if (!r) { process.stderr.write("usage: node inbox.ts --reap <root> <workspace> <record-json>\n"); process.exit(2) }
    reap(r)
    process.exit(0)
  }
  const [sock, kind, pane, owner = randomUUID()] = args
  if (!sock || (kind !== "pi" && kind !== "claude") || !pane || path.basename(sock) !== `${safe(pane)}.sock`) {
    process.stderr.write("usage: node inbox.ts <sock> <pi|claude> <pane> [owner]\n")
    process.exit(2)
  }
  listen(sock, kind, pane, m => process.stdout.write(JSON.stringify(m) + "\n"), {
    record: sock.slice(0, -5) + ".json", owner,
    onError: err => { process.stderr.write(`a2a-msg inbox: ${err.message}\n`); process.exitCode = 1 },
  }).then(inbox => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void inbox.close().catch(err => { process.stderr.write(`${err.message}\n`); process.exitCode = 1 }) })
    process.stdout.write(JSON.stringify({ ready: true }) + "\n")
  }, (err: Error) => { process.stderr.write(`a2a-msg inbox: ${err.message}\n`); process.exitCode = 1 })
}
