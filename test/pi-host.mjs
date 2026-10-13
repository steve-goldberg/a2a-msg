// node --import ./test/pi-host.mjs: resolve the exposed Pi packages from .host/node_modules.
// Internal SDK dependencies resolve from their own installed location. Tests only.
import { registerHooks } from "node:module"

const HOST = new URL("../.host/resolve-from-here.mjs", import.meta.url).href
const HOSTED = /^(typebox|@earendil-works\/(pi-coding-agent|pi-tui))(\/|$)/
registerHooks({ resolve: (specifier, context, next) => next(specifier, HOSTED.test(specifier) ? { ...context, parentURL: HOST } : context) })
