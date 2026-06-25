# @acpjs/electron

## 0.2.0

### Minor Changes

- 2ab76be: Align the public API with the acpjs host adapter boundary instead of presenting it as ACP wire protocol.

  Breaking changes:

  - Rename `ACP_ERROR_CODES` to `ACPJS_ERROR_CODES`.
  - Rename `ACPJS_HOST_RPC_METHODS` to `ACPJS_HOST_METHODS`.
  - Rename `RpcRequest` / `RpcResponse` to `HostRequest` / `HostResponse`.
  - Rename `Transport` and related transport types to `HostClientTransport` names.
  - Rename `AcpEvent` and related event helper unions to `AcpjsEvent` names.
  - Rename host projection snapshots from `AgentSnapshotWire` / `SessionSnapshotWire` / `AgentCapabilitiesWire` to `AgentSnapshot` / `SessionSnapshot` / `AgentCapabilitiesSnapshot`.
  - Narrow `HostRequest.method` from `string` to `AcpjsHostMethod` so host transports only accept the acpjs host adapter method set.
  - Rename the package-internal Electron port request messages from `rpc` / `rpc-result` to `request` / `response`.
  - Remove prompt-error state/payload fields; prompt-time agent JSON-RPC errors now reject the imperative prompt call instead of being represented as a synthetic `prompt-finished` payload.

  Internal ACP connections now use the official SDK builder APIs (`client({ name })` / `agent({ name })`) rather than the deprecated connection classes.

- 0b7c668: Surface the ACP `authenticate` and `logout` agent-direction RPCs as typed mechanism, and project the stable `auth` capability.

  acpjs now sends these calls — it does not pick an auth method, store credentials, or track login state; choosing the `methodId` and when to authenticate remains the integrator's decision (the agent's advertised `authMethods` are still surfaced verbatim on the agent snapshot).

  - `@acpjs/core`: `AcpHost.authenticate(agentId, methodId)` sends `authenticate`; `AcpHost.logout(agentId)` sends `logout`, gated on the agent's advertised `auth.logout` capability (rejects with `acpjs/capability-unsupported` otherwise).
  - `@acpjs/client` / `@acpjs/react`: `AcpAgent.authenticate(methodId)` and `AcpAgent.logout()` on the agent facade.
  - `@acpjs/protocol`: added `agents/authenticate` and `agents/logout` to `ACPJS_HOST_METHODS`; `AgentCapabilitiesSnapshot` now mirrors the stable `auth` capability (`AgentAuthCapabilities`, whose `logout` gates `logout`). The experimental `providers` field stays unmodeled per the stable-surface-only policy.
  - `@acpjs/electron`: the renderer client reaches `authenticate` / `logout` through the existing transport with no bridge changes.

### Patch Changes

- Updated dependencies [2ab76be]
- Updated dependencies [062d49f]
- Updated dependencies [0b7c668]
  - @acpjs/protocol@0.6.0
  - @acpjs/core@0.6.0

## 0.1.5

### Patch Changes

- Updated dependencies [b6a0f0b]
- Updated dependencies [7ce1084]
  - @acpjs/protocol@0.5.0
  - @acpjs/core@0.5.0

## 0.1.4

### Patch Changes

- Updated dependencies [4e438f4]
  - @acpjs/protocol@0.4.0
  - @acpjs/core@0.4.0

## 0.1.3

### Patch Changes

- Updated dependencies [214cae3]
  - @acpjs/protocol@0.3.1
  - @acpjs/core@0.3.1

## 0.1.2

### Patch Changes

- Updated dependencies [5c85002]
  - @acpjs/protocol@0.3.0
  - @acpjs/core@0.3.0

## 0.1.1

### Patch Changes

- Updated dependencies [d581617]
  - @acpjs/protocol@0.2.0
  - @acpjs/core@0.2.0
