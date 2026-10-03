export type HdrPeer = { pane: string; kind: string; name: string }
declare module "claude-code" {
  interface PluginState { "hdr-probe": { peers: HdrPeer[]; draft: string } }
}
