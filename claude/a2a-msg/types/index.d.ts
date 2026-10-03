// a2a-msg's $.state contract. Self-contained by rule: Peer is the shape of core.ts's Peer.
export type Peer = { kind: "pi" | "claude"; pane: string; sock: string; name: string; token: string }

declare module "claude-code" {
  interface PluginState {
    "a2a-msg": {
      /** The peers the open /msg picker lists. */
      peers: Peer[]
      /** True between turn.start and turn.complete: inbound messages then join the running turn. */
      running: boolean
      /** This process's A2A_MSG_OWNER token; a process that inherits another token is nested and stays off. */
      owner: string
    }
  }
}
