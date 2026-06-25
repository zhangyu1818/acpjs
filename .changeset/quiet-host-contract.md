---
'@acpjs/protocol': minor
'@acpjs/core': minor
'@acpjs/client': minor
'@acpjs/electron': minor
'@acpjs/react': minor
---

Align the public API with the acpjs host adapter boundary instead of presenting it as ACP wire protocol.

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
