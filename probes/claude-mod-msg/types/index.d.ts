export type Peer = { kind: "pi" | "cld"; pane: string; name: string; sock: string }
declare module "claude-code" {
  interface PluginState { "hdr-probe2": { peers: Peer[]; running: boolean } }
}
