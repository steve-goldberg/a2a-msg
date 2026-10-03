// node --import ./test/pi-host.mjs: resolve the packages Pi provides to extensions (typebox, @earendil-works/pi-*)
// from .host/node_modules, the links scripts/link-pi.sh makes to the installed Pi. Tests only.
import { registerHooks } from "node:module"

const HOST = new URL("../.host/resolve-from-here.mjs", import.meta.url).href
const HOSTED = /^(typebox|@earendil-works\/pi-[a-z-]+)(\/|$)/
registerHooks({ resolve: (specifier, context, next) => next(specifier, HOSTED.test(specifier) ? { ...context, parentURL: HOST } : context) })
