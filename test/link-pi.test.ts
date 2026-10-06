// Exercise the dev linker with isolated npm-global and managed-install layouts, not the user's config.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { test, type TestContext } from "node:test"

const SCRIPT = new URL("../scripts/link-pi.sh", import.meta.url)

function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/a2a-link-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repo = `${root}/repo`
  const bin = `${root}/bin`
  fs.mkdirSync(`${repo}/scripts`, { recursive: true })
  fs.mkdirSync(`${repo}/.host`)
  fs.writeFileSync(`${repo}/.host/keep`, "previous links")
  fs.mkdirSync(bin)
  fs.copyFileSync(SCRIPT, `${repo}/scripts/link-pi.sh`)
  const run = () => spawnSync("bash", [`${repo}/scripts/link-pi.sh`], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8", timeout: 10_000,
  })
  const linked = (name: string) => fs.readlinkSync(`${repo}/.host/node_modules/${name}`)
  const preserved = () => assert.equal(fs.readFileSync(`${repo}/.host/keep`, "utf8"), "previous links")
  return { root, bin, run, linked, preserved }
}

function pkg(modules: string, name: string, main: string, version = "1.0.3") {
  const root = `${modules}/${name}`
  fs.mkdirSync(path.dirname(`${root}/${main}`), { recursive: true })
  fs.writeFileSync(`${root}/package.json`, JSON.stringify({ name, version, main }))
  fs.writeFileSync(`${root}/${main}`, "#!/usr/bin/env node\n", { mode: 0o755 })
  return root
}

function install(modules: string, nested = false) {
  const pi = pkg(modules, "@earendil-works/pi-coding-agent", "dist/bundle/cli.js")
  const deps = nested ? `${pi}/node_modules` : modules
  const tui = pkg(deps, "@earendil-works/pi-tui", "dist/index.js")
  const typebox = pkg(deps, "typebox", "build/index.mjs")
  // Match typebox's exports-only entry; package.json is deliberately not exported.
  fs.writeFileSync(`${typebox}/package.json`, JSON.stringify({ name: "typebox", exports: { ".": "./build/index.mjs" } }))
  fs.mkdirSync(`${modules}/.bin`)
  fs.symlinkSync("../@earendil-works/pi-coding-agent/dist/bundle/cli.js", `${modules}/.bin/pi`)
  return { pi, tui, typebox }
}

function managed(root: string, bin: string, version = "1.0.3") {
  const agent = `${root}/agent's directory`
  fs.mkdirSync(`${agent}/bin`, { recursive: true })
  fs.mkdirSync(`${agent}/install`)
  fs.writeFileSync(`${agent}/install/current-version`, `${version}\n`)
  // The linker must read the managed pointer, never execute or source this launcher.
  fs.writeFileSync(`${agent}/bin/pi`, "#!/bin/sh\nexit 99\n", { mode: 0o755 })
  fs.symlinkSync(`${agent}/bin/pi`, `${bin}/pi`)
  return agent
}

test("link-pi: npm-global CLI with nested host dependencies", t => {
  const f = fixture(t)
  const packages = install(`${f.root}/global/node_modules`, true)
  fs.symlinkSync(`${packages.pi}/dist/bundle/cli.js`, `${f.bin}/pi`)
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(f.linked("@earendil-works/pi-coding-agent"), packages.pi)
  assert.equal(f.linked("@earendil-works/pi-tui"), packages.tui)
  assert.equal(f.linked("typebox"), packages.typebox)
})

test("link-pi: managed launcher, hoisted dependencies, and updated version pointer", t => {
  const f = fixture(t)
  const agent = managed(f.root, f.bin)
  for (const version of ["1.0.3", "1.0.4"]) {
    const packages = install(`${agent}/install/releases/${version}/node_modules`)
    fs.writeFileSync(`${agent}/install/current-version`, `${version}\n`)
    const result = f.run()
    assert.equal(result.status, 0, result.stderr)
    assert.equal(f.linked("@earendil-works/pi-coding-agent"), packages.pi)
    assert.equal(f.linked("@earendil-works/pi-tui"), packages.tui)
    assert.equal(f.linked("typebox"), packages.typebox)
  }
})

test("link-pi: invalid managed versions fail before deleting existing links", t => {
  const f = fixture(t)
  const agent = managed(f.root, f.bin)
  for (const version of ["", ".", "..", "../../escape", "$(touch bad)"]) {
    fs.writeFileSync(`${agent}/install/current-version`, `${version}\n`)
    const result = f.run()
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Invalid managed Pi version/)
    f.preserved()
  }
})

test("link-pi: missing managed release fails before deleting existing links", t => {
  const f = fixture(t)
  managed(f.root, f.bin)
  const result = f.run()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Managed Pi executable is missing/)
  f.preserved()
})

test("link-pi: missing host dependency fails before deleting existing links", t => {
  const f = fixture(t)
  const packages = install(`${f.root}/global/node_modules`, true)
  fs.rmSync(packages.typebox, { recursive: true })
  fs.symlinkSync(`${packages.pi}/dist/bundle/cli.js`, `${f.bin}/pi`)
  const result = f.run()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Cannot find module 'typebox'/)
  f.preserved()
})
