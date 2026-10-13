// a2a-msg's $.state contract. Self-contained by rule: Peer is the shape of core.ts's Peer.
export type Peer = { kind: "pi" | "claude"; pane: string; sock: string; name: string; token: string }

declare module "claude-code" {
  interface PluginState {
    "a2a-msg": {
      /** The peers the open /msg picker lists. */
      peers: Peer[]
      /** True between turn.start and turn.complete: inbound messages then join the running turn. */
      running: boolean
      /** Compatibility mirror of the process-bound owner; session state is not ownership authority. */
      owner: string
    }
  }
}
